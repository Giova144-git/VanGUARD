"""VanGUARD: TURN relay for call audio, so the call works on hosts (or networks) that block UDP.

With HF_TOKEN set, the server asks Hugging Face's FastRTC TURN service (Cloudflare TURN, free
quota per Hugging Face account) for short-lived ICE servers at startup and every few hours, and
bridge.make_connection adds them to ICE_SERVERS_JSON. aiortc then also gathers relay candidates
(TURN over UDP, TCP and TLS on 443) and ICE keeps the best path. The token never leaves this
process except to that service; credentials are never logged.
"""

import asyncio

import httpx

TURN_SERVICE = "https://fastrtc-turn-service.hf.space/credentials"
TTL_SECONDS = 6 * 3600
REFRESH_SECONDS = 4 * 3600
RETRY_SECONDS = 300

_servers = []  # [{"urls": [...], "username": ..., "credential": ...}], replaced as a whole on refresh


def current():
    return list(_servers)


def normalize(data):
    """Cloudflare answers {"iceServers": {...}} or {"iceServers": [...]}; keep turn(s) URLs with credentials."""
    raw = data.get("iceServers") if isinstance(data, dict) else data
    rows = raw if isinstance(raw, list) else [raw] if isinstance(raw, dict) else []
    servers = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        urls = row.get("urls")
        urls = [urls] if isinstance(urls, str) else [u for u in urls or [] if isinstance(u, str)]
        turn = [u for u in urls if u.startswith(("turn:", "turns:"))]
        if turn and row.get("username") and row.get("credential"):
            servers.append({"urls": turn, "username": str(row["username"]), "credential": str(row["credential"])})
    return servers


async def fetch(hf_token, transport=None):
    async with httpx.AsyncClient(timeout=10, follow_redirects=False, transport=transport) as client:
        response = await client.get(TURN_SERVICE, headers={"Authorization": f"Bearer {hf_token}"},
                                    params={"ttl": TTL_SECONDS})
    response.raise_for_status()
    return normalize(response.json())


async def refresh_forever(hf_token, log):
    global _servers
    while True:
        try:
            servers = await fetch(hf_token)
            if servers:
                _servers = servers
                log.add("turn_refreshed", servers=len(servers))
                await asyncio.sleep(REFRESH_SECONDS)
                continue
            log.add("turn_empty")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            log.add("turn_refresh_failed_" + type(error).__name__)
        await asyncio.sleep(RETRY_SECONDS)
