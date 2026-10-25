"""Gemini Live bridge: Google's native-audio model runs the conversation (VOICE_PROVIDER=gemini).

Same place in the pipeline as bridge.ElevenAgentBridge and grok_bridge.GrokAgentBridge:
transport.input() -> GeminiAgentBridge -> transport.output() [-> local recorder]

Gemini Live (BidiGenerateContent over WebSocket, Google AI Studio key) does speech recognition,
the LLM and the voice in one session. There is no stored agent: every call sends the rendered
prompt, voice and tools in the `setup` message. Protocol, per the Live API docs:
https://ai.google.dev/gemini-api/docs/live

- Send `setup`, wait for `setupComplete`.
- The greeting (AI disclosure + what happened) is asked for with one `clientContent` turn once
  the call's media is connected. While it is generated and played, caller audio is NOT sent, so
  it cannot be interrupted and the free-tier session does not spend input on it.
- Caller audio goes out as `realtimeInput.audio` (16 kHz PCM16, 100 ms chunks); Gemini's own
  activity detection decides turns. Agent audio arrives as 24 kHz PCM16 in
  `serverContent.modelTurn.parts[].inlineData` and is resampled to the pipeline's 16 kHz.
- `serverContent.interrupted` is a barge-in: Gemini stops that turn itself; this bridge drops
  what is still queued for the caller.
- The only tool is `end_call` (local): the call ends once the goodbye turn has finished and its
  audio has had time to play. The model can explain, never act: actions stay behind the
  WhatsApp buttons that VanGUARD's rules sent.
"""

import asyncio
import audioop  # Python 3.12 (pinned in pyproject); used only for a 24 kHz -> 16 kHz resample
import base64
import json
import time

from pipecat.frames.frames import CancelFrame, EndFrame, EndWorkerFrame, InputAudioRawFrame, OutputAudioRawFrame, StartFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosedOK

from .bridge import CHUNK_BYTES, SAMPLE_RATE, provider_problem
from .grok_bridge import render_instructions

GEMINI_LIVE = ("wss://generativelanguage.googleapis.com/ws/"
               "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent")
GEMINI_RATE = 24000
SESSION_READY_SECONDS = 10
BYTES_PER_SECOND = SAMPLE_RATE * 2
PLAYBACK_MARGIN_SECONDS = 0.3
MAX_GOODBYE_WAIT_SECONDS = 12
END_CALL = {"name": "end_call",
            "description": "Cuelga la llamada cuando la persona se despide, pide colgar o confirma que no necesita "
                           "nada más. Antes di una despedida corta."}


def setup_message(spec, variables):
    gemini = spec.gemini
    return {"setup": {
        "model": "models/" + gemini["model"],
        "generationConfig": {"responseModalities": ["AUDIO"],
                             "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": gemini["voice"]}}}},
        "systemInstruction": {"parts": [{"text": render_instructions(spec.prompt, variables)}]},
        "tools": [{"functionDeclarations": [END_CALL]}],
        "inputAudioTranscription": {},
        "outputAudioTranscription": {},
    }}


def greeting_turn(opening):
    """The first turn: the model is told to say the opening, word for word, and stop."""
    return {"clientContent": {"turns": [{"role": "user", "parts": [{"text":
            "La llamada acaba de conectarse. Di exactamente este texto, sin añadir nada antes ni después, y "
            "luego espera a que la persona hable: " + opening}]}], "turnComplete": True}}


async def gemini_endpoint(settings, spec):
    """WebSocket URL and headers. The API key goes in a header from this process only."""
    if settings.dev_agent_ws_url:
        return settings.dev_agent_ws_url, {}  # loopback-only offline fake, validated in config
    return GEMINI_LIVE, {"x-goog-api-key": settings.gemini_api_key}


class GeminiRefused(Exception):
    """Gemini closed or refused the session in a way it cannot continue after."""

    def __init__(self, problem):
        super().__init__(problem)
        self.problem = problem


def close_problem(error):
    """Gemini reports quota and auth problems as WebSocket close codes with a reason."""
    reason = str(getattr(getattr(error, "rcvd", None), "reason", "") or "").lower()
    if "quota" in reason or "rate" in reason or "exhausted" in reason:
        return "rate_limited"
    if "api key" in reason or "permission" in reason or "unauthenticated" in reason:
        return "auth"
    if "model" in reason or "not found" in reason:
        return "not_found"
    return provider_problem(error)


class GeminiAgentBridge(FrameProcessor):
    def __init__(self, context, store, caller, log, ref, url_factory=gemini_endpoint, capture=None, clock=time.monotonic,
                 sleep=asyncio.sleep):
        super().__init__()
        self.context, self.store, self.log, self.ref = context, store, log, ref
        self.capture, self.clock, self.sleep = capture, clock, sleep
        self.url_factory = url_factory
        self.websocket = None
        self.receive_task = None
        self.goodbye_task = None
        self.input_buffer = bytearray()
        self.stopping = False
        self.audio_in = self.audio_out = 0
        self.conversation_id = None
        self.ready = asyncio.Event()
        self.media_connected = False
        self.greeting_pending = False    # provider ready, waiting for media
        self.greeting_sent = False
        self.greeting_done = False       # the greeting turn finished generating
        self.greeting_until = 0.0        # local playback end of the greeting
        self.playback_until = 0.0        # local playback end of everything queued so far
        self.resample_state = None
        self.dropping = False            # caller talked over the current turn
        self.ending = False
        self.agent_text = ""
        self.user_text = ""

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, StartFrame):
            await self.push_frame(frame, direction)
            try:
                url, headers = await self.url_factory(self.context["settings"], self.context["spec"])
                self.websocket = await connect(url, additional_headers=headers, open_timeout=15, max_size=4_000_000)
                self.receive_task = self.create_task(self.receive(), name="gemini-agent-events")
                await self.send(setup_message(self.context["spec"], self.context["dynamic_variables"]))
                self.log.add("agent_socket_connected", self.ref)
            except Exception as error:
                self.log.add("agent_start_failed_" + type(error).__name__, self.ref)
                self.log.provider_failed(provider_problem(error), self.ref)
                await self.push_frame(EndWorkerFrame(), FrameDirection.UPSTREAM)
        elif isinstance(frame, InputAudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
            if self.websocket is None or not self.ready.is_set() or self.greeting_protected() or self.ending:
                return  # nothing to send yet, or the disclosure greeting is still playing
            if frame.sample_rate != SAMPLE_RATE or frame.num_channels != 1:
                raise ValueError("Agent input must be 16 kHz mono PCM")
            self.audio_in += 1
            if self.audio_in == 1:
                self.log.add("first_audio_in", self.ref)
            self.input_buffer.extend(frame.audio)
            if self.capture:
                await self.push_frame(frame, direction)
            while len(self.input_buffer) >= CHUNK_BYTES:
                chunk = bytes(self.input_buffer[:CHUNK_BYTES])
                del self.input_buffer[:CHUNK_BYTES]
                try:
                    await self.send({"realtimeInput": {"audio": {"data": base64.b64encode(chunk).decode(),
                                                                 "mimeType": f"audio/pcm;rate={SAMPLE_RATE}"}}})
                except Exception as error:
                    if not isinstance(error, ConnectionClosedOK):  # a clean close (end_call) is not a failure
                        self.log.add("agent_audio_send_failed_" + type(error).__name__, self.ref)
                    await self.stop_socket()
                    await self.push_frame(EndWorkerFrame(), FrameDirection.UPSTREAM)
                    return
        elif isinstance(frame, (EndFrame, CancelFrame)):
            await self.stop_socket()
            await self.push_frame(frame, direction)
        else:
            await self.push_frame(frame, direction)

    async def send(self, message):
        await self.websocket.send(json.dumps(message))

    def greeting_protected(self):
        if self.greeting_pending or (self.greeting_sent and not self.greeting_done):
            return True
        return self.clock() < self.greeting_until + PLAYBACK_MARGIN_SECONDS

    async def handle_event(self, message):
        if "setupComplete" in message:
            if self.ready.is_set():
                return
            self.ready.set()
            self.log.add("agent_session_ready", self.ref)
            self.log.provider_ok()
            self.greeting_pending = True
            await self.greet()
        elif content := message.get("serverContent"):
            await self.handle_content(content)
        elif call := message.get("toolCall"):
            await self.run_tools(call.get("functionCalls") or [])
        elif "goAway" in message:
            self.log.add("agent_go_away", self.ref)

    async def handle_content(self, content):
        if content.get("interrupted"):
            if self.greeting_sent and not self.greeting_done:
                return  # cannot happen (no audio is sent during the greeting); never cut the disclosure
            self.dropping = True
            self.playback_until = self.clock()
            self.log.add("agent_interrupted", self.ref)
            await self.broadcast_interruption()
        for part in (content.get("modelTurn") or {}).get("parts") or []:
            data = (part.get("inlineData") or {}).get("data")
            if not data or self.dropping:
                continue
            audio = base64.b64decode(data, validate=True)
            if len(audio) % 2:
                raise ValueError("Invalid PCM audio")
            audio, self.resample_state = audioop.ratecv(audio, 2, 1, GEMINI_RATE, SAMPLE_RATE, self.resample_state)
            self.playback_until = max(self.playback_until, self.clock()) + len(audio) / BYTES_PER_SECOND
            self.audio_out += 1
            if self.audio_out == 1:
                self.log.add("first_audio_out", self.ref)
            await self.push_frame(OutputAudioRawFrame(audio, SAMPLE_RATE, 1))
        if self.capture:
            self.agent_text += str((content.get("outputTranscription") or {}).get("text") or "")
            self.user_text += str((content.get("inputTranscription") or {}).get("text") or "")
        if content.get("turnComplete"):
            await self.finish_turn()

    async def finish_turn(self):
        self.dropping = False
        if self.capture:
            if self.user_text.strip():
                self.capture.add_turn("user", self.user_text.strip())
            if self.agent_text.strip():
                self.capture.add_turn("agent", self.agent_text.strip())
            self.user_text = self.agent_text = ""
        if self.greeting_sent and not self.greeting_done:
            self.greeting_done = True
            self.greeting_until = self.playback_until
            self.log.add("agent_greeting_done", self.ref)
        if self.ending:
            await self.close_after_playback()

    async def media_ready(self):
        """Called by the session when the WebRTC peer connects."""
        self.media_connected = True
        await self.greet()

    async def greet(self):
        if not (self.greeting_pending and self.media_connected and self.websocket):
            return
        self.greeting_pending = False
        self.greeting_sent = True
        opening = self.context["dynamic_variables"]["opening_message"]
        await self.send(greeting_turn(opening))
        if self.capture:
            self.capture.add_turn("agent", opening)

    async def run_tools(self, calls):
        responses = []
        for call in calls:
            name, call_id = str(call.get("name") or ""), str(call.get("id") or "")[:128]
            if name == "end_call":
                self.ending = True
                self.log.add("tool_end_call_ok", self.ref)
                result = {"result": "ok: despídete en una frase corta"}
            else:
                self.log.add("tool_unknown_failed", self.ref)
                result = {"error": "herramienta desconocida"}
            responses.append({"id": call_id, "name": name, "response": result})
        if responses:
            await self.send({"toolResponse": {"functionResponses": responses}})
        if self.ending and not self.goodbye_task:
            # Safety net: if no goodbye turn arrives, hang up anyway.
            self.goodbye_task = self.create_task(self.hang_up_soon(), name="gemini-goodbye")

    async def hang_up_soon(self):
        await self.sleep(MAX_GOODBYE_WAIT_SECONDS)
        await self.close_after_playback()

    async def close_after_playback(self):
        remaining = self.playback_until - self.clock()
        if remaining > 0:
            await self.sleep(min(remaining + PLAYBACK_MARGIN_SECONDS, MAX_GOODBYE_WAIT_SECONDS))
        if self.websocket:
            await self.websocket.close()  # ends the receive loop, and with it the call

    async def receive(self):
        try:
            async with asyncio.timeout(SESSION_READY_SECONDS):
                while not self.ready.is_set():
                    await self.handle_event(json.loads(await self.websocket.recv()))
            async for raw in self.websocket:
                await self.handle_event(json.loads(raw))
            self.log.add("agent_conversation_ended", self.ref)
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            self.log.add("agent_session_not_ready", self.ref)
            self.log.provider_failed("failed", self.ref)
        except GeminiRefused as error:
            self.log.provider_failed(error.problem, self.ref)
        except ConnectionClosedOK:
            self.log.add("agent_conversation_ended", self.ref)
        except Exception as error:
            self.log.add("agent_receive_failed_" + type(error).__name__, self.ref)
            if not self.ready.is_set() or self.audio_out == 0:
                self.log.provider_failed(close_problem(error), self.ref)
        finally:
            if not self.stopping:
                await self.push_frame(EndWorkerFrame(), FrameDirection.UPSTREAM)

    async def stop_socket(self):
        self.stopping = True
        if self.goodbye_task:
            await self.cancel_task(self.goodbye_task)
            self.goodbye_task = None
        if self.websocket:
            await self.websocket.close()
            self.websocket = None
        if self.receive_task:
            await self.cancel_task(self.receive_task)
            self.receive_task = None

    async def cleanup(self):
        await self.stop_socket()
        await super().cleanup()
