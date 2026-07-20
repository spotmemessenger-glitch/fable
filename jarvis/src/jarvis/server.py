"""The HUD server.

Serves the interface (plain HTTP, static files) and bridges the browser to the
brain over a WebSocket. One brain, one memory — the same core as the terminal
modes, so everything the HUD does lands in the same database.

Run:  python -m jarvis.server        then open  http://localhost:8770
"""

from __future__ import annotations

import asyncio
import base64
import functools
import http.server
import json
import logging
import threading
import time
from pathlib import Path

import psutil
import websockets

from .app import Session, _setup_logging
from .config import settings
from .tools.registry import Tool, registry

log = logging.getLogger(__name__)

HTTP_PORT = 8770
WS_PORT = 8765
UI_DIR = Path(__file__).resolve().parent.parent.parent / "ui"

APPROVAL_TIMEOUT_SECONDS = 120

# Which HUD agent card lights up for which tool. Anything unlisted maps to the
# CEO itself. MCP tools slot in here as they're added.
TOOL_AGENT = {
    "remember": "memory",
    "recall": "memory",
    "forget": "memory",
    "search_history": "memory",
    "review_actions": "memory",
    "read_file": "coder",
    "write_file": "coder",
    "list_directory": "coder",
    "run_command": "system",
    "current_time": "system",
}

AGENTS = [
    {"id": "ceo", "name": "J.A.R.V.I.S.", "role": "Chief · orchestrator", "tier": "fable-5"},
    {"id": "research", "name": "SCHOLAR", "role": "Web research", "tier": "on hold"},
    {"id": "coder", "name": "FORGE", "role": "Files & code", "tier": "sonnet-5"},
    {"id": "designer", "name": "MUSE", "role": "Design / UI", "tier": "on hold"},
    {"id": "video", "name": "REEL", "role": "Video pipeline", "tier": "on hold"},
    {"id": "market", "name": "LEDGER", "role": "Market intel", "tier": "feeds live"},
    {"id": "memory", "name": "ARCHIVE", "role": "Memory & audit", "tier": "sqlite"},
    {"id": "system", "name": "CORE", "role": "System & shell", "tier": "gated"},
]


class Hub:
    """Owns the session and fans events out to connected HUD clients."""

    def __init__(self) -> None:
        self.session = Session(settings, owner="Yuvraj")
        self.clients: set = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.busy = False
        self.last_feeds: dict[str, dict | None] = {}
        self._pending_approvals: dict[str, dict] = {}
        self.session.brain.approver = self._approve_via_hud
        self.session.brain.on_tool = self._on_tool
        self._eleven = None
        if settings.has_voice_output:
            try:
                from elevenlabs.client import ElevenLabs

                self._eleven = ElevenLabs(api_key=settings.elevenlabs_api_key)
            except Exception:  # noqa: BLE001
                log.exception("ElevenLabs unavailable; HUD will use browser TTS")

    # ------------------------------------------------------------ broadcast

    def cast(self, message: dict) -> None:
        """Send to every client; safe to call from any thread."""
        if self.loop is None:
            return
        data = json.dumps(message, ensure_ascii=False)
        for ws in list(self.clients):
            asyncio.run_coroutine_threadsafe(self._send(ws, data), self.loop)

    async def _send(self, ws, data: str) -> None:
        try:
            await ws.send(data)
        except websockets.ConnectionClosed:
            self.clients.discard(ws)

    # ------------------------------------------------------------- events

    def _on_tool(self, name: str, arguments: dict, phase: str, ok: bool) -> None:
        agent = TOOL_AGENT.get(name, "ceo")
        self.cast(
            {
                "type": "tool",
                "tool": name,
                "agent": agent,
                "phase": phase,
                "ok": ok,
            }
        )

    def _approve_via_hud(self, tool: Tool, arguments: dict) -> bool:
        """Ask the HUD and block the brain thread until an answer or timeout."""
        request_id = f"ap{time.monotonic_ns()}"
        event = threading.Event()
        slot: dict = {"event": event, "answer": False}
        self._pending_approvals[request_id] = slot
        self.cast(
            {
                "type": "approval_request",
                "id": request_id,
                "description": tool.describe_call(arguments),
                "tool": tool.name,
            }
        )
        granted = event.wait(APPROVAL_TIMEOUT_SECONDS) and slot["answer"]
        self._pending_approvals.pop(request_id, None)
        self.cast({"type": "approval_resolved", "id": request_id, "granted": granted})
        return granted

    def resolve_approval(self, request_id: str, granted: bool) -> None:
        slot = self._pending_approvals.get(request_id)
        if slot:
            slot["answer"] = granted
            slot["event"].set()

    # -------------------------------------------------------------- speech

    def tts(self, text: str) -> str | None:
        """Synthesize speech, returning base64 MP3, or None to let the browser
        fall back to its own voice."""
        if self._eleven is None:
            return None
        try:
            chunks = self._eleven.text_to_speech.convert(
                voice_id=settings.voice_id,
                text=text,
                model_id=settings.tts_model,
                output_format="mp3_44100_64",
            )
            audio = b"".join(chunks)
            return base64.b64encode(audio).decode("ascii")
        except Exception as exc:  # noqa: BLE001
            log.warning("TTS failed (%s); browser voice takes over", exc)
            return None

    # --------------------------------------------------------------- brain

    # Canned acknowledgements for a bare "Hey Jarvis" — spoken in the cloned
    # voice, no Claude call, so the wake response is instant and free.
    WAKE_LINES = (
        "Yes, Yuvraj?",
        "At your service, Yuvraj.",
        "Go ahead, Yuvraj.",
        "I'm listening.",
    )

    def wake(self) -> None:
        """Acknowledge the wake word without invoking the brain."""
        if self.busy:
            return

        def work() -> None:
            # Vary the line by the second so it doesn't feel robotic, without
            # needing a RNG (unavailable in some sandboxes anyway).
            idx = int(time.time()) % len(self.WAKE_LINES)
            text = self.WAKE_LINES[idx]
            self.cast({"type": "state", "state": "speaking"})
            payload: dict = {"type": "say", "text": text}
            audio = self.tts(text)
            if audio:
                payload["audio"] = audio
            self.cast(payload)
            self.cast({"type": "state", "state": "idle"})

        threading.Thread(target=work, daemon=True).start()

    def handle_command(self, text: str, want_audio: bool) -> None:
        """Run one user turn on a worker thread, streaming events to the HUD."""
        if self.busy:
            self.cast({"type": "notice", "text": "Still working on the last one."})
            return
        self.busy = True
        self.cast({"type": "state", "state": "thinking"})

        def work() -> None:
            try:
                for sentence in self.session.brain.respond(text):
                    payload: dict = {"type": "say", "text": sentence}
                    if want_audio:
                        audio = self.tts(sentence)
                        if audio:
                            payload["audio"] = audio
                    self.cast({"type": "state", "state": "speaking"})
                    self.cast(payload)
            except Exception:  # noqa: BLE001
                log.exception("brain turn failed")
                self.cast({"type": "say", "text": "Something broke mid-thought. Check the log."})
            finally:
                self.busy = False
                self.cast({"type": "state", "state": "idle"})

        threading.Thread(target=work, daemon=True).start()

    # -------------------------------------------------------------- vitals

    def vitals(self) -> dict:
        vm = psutil.virtual_memory()
        disk = psutil.disk_usage("C:\\")
        net = psutil.net_io_counters()
        return {
            "type": "vitals",
            "cpu": psutil.cpu_percent(interval=None),
            "cores": psutil.cpu_percent(interval=None, percpu=True),
            "ram": vm.percent,
            "ram_used_gb": round(vm.used / 2**30, 1),
            "ram_total_gb": round(vm.total / 2**30, 1),
            "disk": disk.percent,
            "disk_free_gb": round(disk.free / 2**30, 1),
            "net_sent_mb": round(net.bytes_sent / 2**20, 1),
            "net_recv_mb": round(net.bytes_recv / 2**20, 1),
            "uptime_h": round((time.time() - psutil.boot_time()) / 3600, 1),
            "at": time.time(),
        }

    def memory_summary(self) -> dict:
        stats = self.session.memory.stats()
        facts = [f.render() for f in self.session.memory.active_facts(limit=12)]
        return {"type": "memory", "stats": stats, "facts": facts}


hub = Hub()


# ------------------------------------------------------------------ websocket


async def client_handler(ws) -> None:
    hub.clients.add(ws)
    await ws.send(json.dumps({"type": "hello", "agents": AGENTS, "name": settings.assistant_name}))
    await ws.send(json.dumps(hub.memory_summary()))
    # Push the most recent feed data immediately so a fresh page isn't blank
    # until the next poll cycle.
    for snap in hub.last_feeds.values():
        if snap:
            await ws.send(json.dumps(snap, ensure_ascii=False))

    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = msg.get("type")
            if kind == "command":
                text = str(msg.get("text", "")).strip()
                if text:
                    hub.cast({"type": "user_said", "text": text})
                    hub.handle_command(text, want_audio=bool(msg.get("audio", True)))
            elif kind == "wake":
                hub.wake()
            elif kind == "approval_response":
                hub.resolve_approval(str(msg.get("id")), bool(msg.get("granted")))
            elif kind == "get_memory":
                await ws.send(json.dumps(hub.memory_summary(), ensure_ascii=False))
    except websockets.ConnectionClosed:
        pass
    finally:
        hub.clients.discard(ws)


async def vitals_loop() -> None:
    while True:
        hub.cast(hub.vitals())
        await asyncio.sleep(2)


async def feeds_loop() -> None:
    from .feeds import Feeds

    feeds = Feeds()
    while True:
        snap = await asyncio.to_thread(feeds.snapshot)
        for key in ("crypto", "forex", "news"):
            if snap.get(key):
                hub.last_feeds[key] = snap[key]
                hub.cast(snap[key])
        await asyncio.sleep(45)


# ----------------------------------------------------------------- static http


class _StaticHandler(http.server.SimpleHTTPRequestHandler):
    """Serves the UI, plus POST /snap to save a rendered snapshot to disk.

    The snapshot endpoint exists because the preview pane's own screenshot
    capture is unreliable for this heavily-animated page; the page can render
    itself to a PNG and POST it here so it can be viewed as a file.
    """

    def do_POST(self):  # noqa: N802 - stdlib naming
        if self.path != "/snap":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        out = UI_DIR.parent / "data" / "snap.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):  # keep the console quiet
        pass


def serve_static() -> None:
    handler = functools.partial(_StaticHandler, directory=str(UI_DIR))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), handler)
    httpd.serve_forever()


# ----------------------------------------------------------------------- main


async def amain() -> None:
    hub.loop = asyncio.get_running_loop()
    threading.Thread(target=serve_static, daemon=True).start()
    psutil.cpu_percent(interval=None)  # prime the counter so the first read is real

    async with websockets.serve(client_handler, "127.0.0.1", WS_PORT):
        print(f"\n  {settings.assistant_name} HUD:  http://localhost:{HTTP_PORT}")
        print(f"  WebSocket bridge:  ws://localhost:{WS_PORT}")
        print("  Ctrl+C to stop.\n")
        await asyncio.gather(vitals_loop(), feeds_loop())


def main() -> int:
    _setup_logging(settings.log_path)
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        print("\n  HUD stopped.")
    finally:
        hub.session.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
