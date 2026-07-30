"""Serves the avatar and relays voice events to it.

WHY A RELAY EXISTS AT ALL

The voice service publishes newline-JSON on a TCP socket. A browser cannot open
a raw TCP socket, so something has to sit between them. This is that something:
one stdlib HTTP server that serves avatar/ and exposes /events as
Server-Sent Events, which is the one push transport a browser gets for free —
no WebSocket dependency, no extra package, works offline.

The direction is deliberately one-way. The face reacts to what ybot does; it
never drives it. Nothing a page could send would be trusted here, so nothing
can be sent.

    python -m ybot.avatar_server          # then open http://127.0.0.1:8770
"""
from __future__ import annotations

import json
import queue
import socket
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .voice.bridge import HOST as VOICE_HOST
from .voice.bridge import PORT as VOICE_PORT

AVATAR_DIR = Path(__file__).resolve().parents[1] / "avatar"
PORT = 8770
# A slow or stalled browser must not hold the relay hostage; past this depth its
# events are dropped rather than growing without bound.
MAX_QUEUED = 200


class Hub:
    """Fans voice-service events out to every connected page."""

    def __init__(self) -> None:
        self._clients: set[queue.Queue] = set()
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=MAX_QUEUED)
        with self._lock:
            self._clients.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            self._clients.discard(q)

    def publish(self, payload: dict) -> None:
        with self._lock:
            clients = list(self._clients)
        for q in clients:
            try:
                q.put_nowait(payload)
            except queue.Full:
                pass          # this page is not keeping up; skip, never block

    def pump(self) -> None:
        """Follow the voice socket forever, reconnecting when it goes away.

        The service is started and stopped independently of the avatar window,
        so a closed socket is normal operation, not an error worth crashing on.
        """
        buf = b""
        while True:
            try:
                with socket.create_connection((VOICE_HOST, VOICE_PORT), timeout=5) as s:
                    self.publish({"type": "link", "text": "voice connected"})
                    s.settimeout(None)
                    while True:
                        chunk = s.recv(4096)
                        if not chunk:
                            break
                        buf += chunk
                        while b"\n" in buf:
                            line, buf = buf.split(b"\n", 1)
                            if not line.strip():
                                continue
                            try:
                                self.publish(json.loads(line.decode("utf-8")))
                            except json.JSONDecodeError:
                                continue      # one bad frame must not kill the pump
            except OSError:
                pass
            self.publish({"type": "link", "text": "voice offline"})
            threading.Event().wait(2.0)


HUB = Hub()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw) -> None:
        super().__init__(*a, directory=str(AVATAR_DIR), **kw)

    def do_GET(self) -> None:                       # noqa: N802 - stdlib name
        if self.path.split("?")[0] == "/events":
            self._events()
            return
        super().do_GET()

    def _events(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = HUB.subscribe()
        try:
            while True:
                try:
                    payload = q.get(timeout=15)
                    body = json.dumps(payload)
                except queue.Empty:
                    body = None
                # A comment line keeps the connection alive through idle
                # stretches; without it proxies and browsers eventually give up
                # and the face silently stops reacting.
                frame = f"data: {body}\n\n" if body else ": keepalive\n\n"
                self.wfile.write(frame.encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass                                     # page closed; expected
        finally:
            HUB.unsubscribe(q)

    def log_message(self, *a) -> None:               # noqa: ANN002
        pass                                         # one line per asset is noise


def serve(port: int = PORT) -> None:
    threading.Thread(target=HUB.pump, daemon=True).start()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"avatar on http://127.0.0.1:{port}  (events relayed from voice)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\navatar server stopped.")


def demo() -> None:
    """Check the fan-out rules without a socket or a browser."""
    hub = Hub()
    a, b = hub.subscribe(), hub.subscribe()
    hub.publish({"type": "speak", "visemes": [{"t": 0, "v": "aa"}]})
    assert a.get_nowait()["type"] == "speak"
    assert b.get_nowait()["type"] == "speak", "every page must receive every event"

    hub.unsubscribe(b)
    hub.publish({"type": "state", "text": "thinking"})
    assert a.get_nowait()["type"] == "state"
    assert b.empty(), "unsubscribed page still received events"

    # A page that stops reading must not block the relay or grow memory forever.
    for _ in range(MAX_QUEUED + 50):
        hub.publish({"type": "noise"})
    assert a.qsize() <= MAX_QUEUED, a.qsize()

    assert AVATAR_DIR.joinpath("index.html").exists(), AVATAR_DIR
    print(f"avatar_server: ok (fan-out, unsubscribe, backpressure capped at {MAX_QUEUED})")


if __name__ == "__main__":
    import sys

    if "--demo" in sys.argv:
        demo()
    else:
        serve()
