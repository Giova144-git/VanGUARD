# VanGUARD · voz (Guardia)

Servidor de voz de VanGUARD: cuando las reglas detectan un **ataque crítico**, el Worker manda el WhatsApp con botones
y pide a este servidor que **llame por WhatsApp** al contacto. Guardia, una asistente de IA, explica en menos de un
minuto qué pasa y remite al botón «Bloquear IP» del WhatsApp. **No ejecuta nada por voz.**

Basado en el [WhatsApp voice agent starter de Kapso](https://github.com/gokapso/whatsapp-voice-agent-starter)
(MIT, commit `686189e`, ver `LICENSE`). Lo que cambia VanGUARD:

- **Proveedor `gemini`** (`src/kapso_voice_agent/gemini_bridge.py`): Gemini Live API (Google AI Studio) hace el
  reconocimiento, el modelo y la voz en una sola sesión. Audio de la llamada a 16 kHz; la respuesta de Gemini llega a
  24 kHz y se baja a 16 kHz.
- **Contexto del incidente** en la llamada saliente (`outbound.call_context`): solo `tipo`, `host`, `ip`, `eventos` y
  `severidad`, recortados y saneados. Van al saludo fijo y al prompt.
- **Saludo protegido**: mientras suena el saludo (con el aviso de que es una IA) no se envía el audio del llamante.
- **Entrantes solo como devolución**: una llamada entrante se contesta solo si VanGUARD llamó a ese número por un
  ataque en los últimos `INBOUND_CALLBACK_MINUTES`; el resto se rechaza sin arrancar el agente.
- Comportamiento del bot en `agent/prompt.md` y `agent/agent.toml` (español, 80–90 s máximo, solo `end_call`).

## Flujo

```
regla (crítico) → Worker: WhatsApp con botones → POST /operator/api/outbound/call {recipient, context}
  → permiso de llamada de WhatsApp → connect (Kapso) → SDP answer (webhook /webhooks/whatsapp) → ACCEPTED
  → Gemini Live: saludo fijo → explica → end_call → terminate
```

## Despliegue (Railway)

Servicio con raíz `apps/voz` (usa el `Dockerfile`). Variables: las genera `node scripts/voz-railway-env.mjs`
(herramienta local del equipo) y se pegan en Railway → Variables → Raw Editor. Con `KAPSO_REGISTER_WEBHOOK=1`, al
arrancar se registra como webhook de Meta del número si no tiene uno.

Salud: `GET /healthz`. Consola de operador: `/operator` (token de operador).
