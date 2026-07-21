"""The HUD server.

Serves the interface (static files) and the brain (WebSocket) on ONE port —
required for cloud hosts like Railway/Fly that expose a single $PORT. Static
assets are served for any plain HTTP GET; the WebSocket lives at /ws. One
brain, one memory — the same core as the terminal modes, so everything the HUD
does lands in the same database.

Run:  python -m jarvis.server        then open  http://localhost:8770
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import mimetypes
import os
import threading
import time
from pathlib import Path

import psutil
import websockets
from websockets.datastructures import Headers
from websockets.http11 import Response

from .app import Session, _setup_logging
from .config import settings
from .tools.registry import Risk, Tool, registry

# JARVIS-the-assistant must not be able to rewrite its own code or run shell
# commands — that self-modification is what made it "disoriented", trying to
# fix its own mic by editing ears.py mid-conversation. Block those tools so it
# can't even see them. It keeps memory, recall, search, files-read, and time;
# real capabilities (web research, etc.) arrive later as purpose-built,
# individually-gated sub-agent tools, never raw shell/file-write on its repo.
for _blocked in ("run_command", "write_file", "read_file", "list_directory"):
    _tool = registry.get(_blocked)
    if _tool is not None:
        _tool.risk = Risk.BLOCKED

log = logging.getLogger(__name__)

# Railway/Fly/Render inject $PORT and expect the app to listen on it with a
# single process bound to 0.0.0.0. Locally there's no $PORT, so default to
# 8770 on loopback only.
PORT = int(os.environ.get("PORT", 8770))
BIND_HOST = "0.0.0.0" if "PORT" in os.environ else "127.0.0.1"
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
        self.speaking = False          # JARVIS is playing audio on local speakers
        self.local_mouth = None        # native speaker output (set in native mode)
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

    def stt(self, audio: bytes, mime: str = "audio/webm") -> str | None:
        """Transcribe a spoken command with ElevenLabs Scribe.

        Far more accurate than the browser's free recognizer, especially for
        accented English and code-switched speech — this is what makes JARVIS
        actually understand the owner. Returns None on failure so the caller
        can fall back to the browser transcript.
        """
        if self._eleven is None or not audio:
            return None
        import io

        if "wav" in mime:
            ext = "wav"
        elif "webm" in mime:
            ext = "webm"
        elif "ogg" in mime:
            ext = "ogg"
        else:
            ext = "mp3"
        try:
            result = self._eleven.speech_to_text.convert(
                file=(f"command.{ext}", io.BytesIO(audio), mime),
                model_id="scribe_v1",
                tag_audio_events=False,
            )
            text = (getattr(result, "text", None) or "").strip()
            log.info("Scribe (%s, %d bytes) -> %r", ext, len(audio), text[:100])
            return text or None
        except TypeError:
            # older/newer SDK signature: positional file object
            try:
                result = self._eleven.speech_to_text.convert(
                    io.BytesIO(audio), model_id="scribe_v1"
                )
                text = (getattr(result, "text", None) or "").strip()
                return text or None
            except Exception:  # noqa: BLE001
                log.exception("Scribe STT failed (fallback signature)")
                return None
        except Exception:  # noqa: BLE001
            log.exception("Scribe STT failed")
            return None

    def handle_voice_command(self, audio_b64: str, mime: str) -> None:
        """A recorded spoken command from the HUD: transcribe, then execute."""
        try:
            audio = base64.b64decode(audio_b64)
        except Exception:  # noqa: BLE001
            return

        def work() -> None:
            text = self.stt(audio, mime)
            if not text:
                self.cast({"type": "say", "text": "I didn't catch that, boss. Say it again?"})
                return
            self.cast({"type": "user_said", "text": text})
            self.handle_command(text, want_audio=True)

        threading.Thread(target=work, daemon=True).start()

    def speak_local(self, text: str) -> None:
        """Speak on the machine's own speakers (native, browser-free mode).

        Sets the speaking flag so the native mic listener ignores JARVIS's own
        voice. No-op if local speaker output isn't configured.
        """
        if self.local_mouth is None or not text.strip():
            return
        self.speaking = True
        try:
            self.local_mouth.say(text)
        except Exception:  # noqa: BLE001
            log.exception("Local speech failed")
        finally:
            # small tail so the mic doesn't catch the last word as a command
            time.sleep(0.35)
            self.speaking = False

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
        "Yes boss. Jarvis, at your service.",
        "At your service, boss.",
        "Yes boss?",
        "Online and ready, boss.",
    )

    def wake(self) -> None:
        """Acknowledge the wake word without invoking the brain."""
        if self.busy:
            return
        # Vary the line by the second so it doesn't feel robotic, without
        # needing a RNG (unavailable in some sandboxes anyway).
        idx = int(time.time()) % len(self.WAKE_LINES)
        self.announce(self.WAKE_LINES[idx])

    def announce(self, text: str) -> None:
        """Speak a fixed line without invoking the brain (wake/sleep acks)."""
        if self.busy:
            return

        def work() -> None:
            self.cast({"type": "state", "state": "speaking"})
            payload: dict = {"type": "say", "text": text}
            if self.local_mouth is None:
                audio = self.tts(text)
                if audio:
                    payload["audio"] = audio
            self.cast(payload)
            self.speak_local(text)
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
                    if want_audio and self.local_mouth is None:
                        # browser plays the audio (native mode speaks locally instead)
                        audio = self.tts(sentence)
                        if audio:
                            payload["audio"] = audio
                    self.cast({"type": "state", "state": "speaking"})
                    self.cast(payload)
                    self.speak_local(sentence)
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

# Fully-autonomous native voice: listen on the machine's own microphone, no
# browser and no clicking. On by default; set JARVIS_NATIVE_VOICE=0 to disable
# (e.g. if the mic is better handled by the browser tab).
_native_listener = None


def _start_native_voice() -> None:
    global _native_listener
    import os

    if os.environ.get("JARVIS_NATIVE_VOICE", "1").strip() in {"0", "false", "no"}:
        log.info("Native voice disabled by JARVIS_NATIVE_VOICE")
        return
    try:
        from .voice.native_listener import NativeListener
        from .voice.mouth import Mouth

        # local speaker output so JARVIS answers out loud without a browser
        if settings.has_voice_output and hub.local_mouth is None:
            hub.local_mouth = Mouth(
                settings.elevenlabs_api_key, settings.voice_id,
                settings.tts_model, enabled=True,
            )

        listener = NativeListener(hub, language=settings.stt_language)
        if listener.start():
            _native_listener = listener
            print("  Native voice: ONLINE — listening on the microphone, say 'Hey Jarvis'.")
        else:
            print("  Native voice: no microphone found; use the browser tab for voice.")
    except Exception:  # noqa: BLE001
        log.exception("Native voice failed to start")


# ------------------------------------------------------------------ websocket


async def client_handler(ws) -> None:
    hub.clients.add(ws)
    await ws.send(json.dumps({
        "type": "hello", "agents": AGENTS, "name": settings.assistant_name,
        "native": _native_listener is not None,
    }))
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
            elif kind == "audio_command":
                hub.handle_voice_command(str(msg.get("data", "")), str(msg.get("mime", "audio/webm")))
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

_MIME_FALLBACK = "application/octet-stream"


def _static_response(path: str) -> Response:
    """Serve a file from ui/ for a plain HTTP GET on the shared port."""
    clean = path.split("?", 1)[0].split("#", 1)[0]
    rel = clean.lstrip("/") or "index.html"
    target = (UI_DIR / rel).resolve()
    # Refuse to serve anything outside ui/ (blocks ../.. traversal).
    if UI_DIR not in target.parents and target != UI_DIR:
        return Response(403, "Forbidden", Headers({"Content-Type": "text/plain"}), b"forbidden")
    if target.is_dir():
        target = target / "index.html"
    if not target.is_file():
        return Response(404, "Not Found", Headers({"Content-Type": "text/plain"}), b"not found")
    body = target.read_bytes()
    ctype = mimetypes.guess_type(str(target))[0] or _MIME_FALLBACK
    headers = Headers({
        "Content-Type": ctype,
        "Content-Length": str(len(body)),
        # Never cache: this is a fast-moving app and stale JS/CSS has
        # repeatedly caused "I changed it but it didn't update" confusion.
        "Cache-Control": "no-store, must-revalidate",
    })
    return Response(200, "OK", headers, body)


async def process_request(connection, request):
    """Route plain HTTP to static files; let /ws through to the WS handshake."""
    if request.path.startswith("/ws"):
        return None  # proceed with the WebSocket handshake
    try:
        return _static_response(request.path)
    except Exception:  # noqa: BLE001
        log.exception("static file serving failed for %s", request.path)
        return Response(500, "Internal Server Error", Headers(), b"error")


# ----------------------------------------------------------------------- main


async def amain() -> None:
    hub.loop = asyncio.get_running_loop()
    psutil.cpu_percent(interval=None)  # prime the counter so the first read is real
    _start_native_voice()

    async with websockets.serve(
        client_handler, BIND_HOST, PORT, process_request=process_request
    ):
        scheme = "0.0.0.0" if BIND_HOST == "0.0.0.0" else "localhost"
        print(f"\n  {settings.assistant_name} HUD + WebSocket:  http://{scheme}:{PORT}  (ws at /ws)")
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
