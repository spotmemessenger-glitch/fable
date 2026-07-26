"""The office bridge — HELM's headless core, exposed to a browser.

This is a CLIENT of the desk, not part of it. It builds one Helm, and serves
its already-computed dicts as JSON plus the static office page. No trading logic
lives here; the front-end only ever renders what HELM returns. That separation
is the whole point — a terminal, this office, and a future 3D renderer are all
just different views of the same deterministic readings.

Run (from anywhere, path is fixed below):
    desk/.venv/Scripts/python office/server.py        # http://127.0.0.1:8787
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make the `desk` package importable no matter the working directory.
ROOT = Path(__file__).resolve().parent.parent          # .../desk
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi import FastAPI, Query                       # noqa: E402
from fastapi.responses import FileResponse, Response     # noqa: E402
from fastapi.staticfiles import StaticFiles              # noqa: E402

from desk import narrate                                 # noqa: E402
from desk.config import settings                         # noqa: E402
from desk.helm import Helm                               # noqa: E402
from desk.meeting import Meeting                         # noqa: E402
from desk.roster import ROSTER                           # noqa: E402

STATIC = Path(__file__).resolve().parent / "static"

app = FastAPI(title="THE DESK — live office", version="0.1.0")
helm = Helm(settings)                                    # one desk, shared


def _norm(symbol: str) -> str:
    symbol = (symbol or "SOL").upper()
    return symbol if "/" in symbol else f"{symbol}/USDT"


@app.get("/api/roster")
def roster() -> list[dict[str, str]]:
    """Static seating chart — who sits where, and each seat's wing colour."""
    return [{"name": s.name, "role": s.role, "wing": s.wing,
             "colour": s.colour, "brief": s.brief, "market": s.market}
            for s in ROSTER]


@app.get("/api/look")
def look(symbol: str = Query("SOL")) -> dict:
    """Full desk read on one symbol — every seat's reading + the consensus."""
    return helm.look(_norm(symbol))


@app.get("/api/meeting")
def meeting(symbol: str = Query("SOL")) -> dict:
    """Run a full standup and return the agenda.

    The browser plays these turns one at a time — walking everyone to the
    table, then speaking each line in that seat's own voice via /api/say.
    Generating the whole agenda up front (rather than streaming) keeps the
    room's choreography simple: the office knows the running order, so it can
    seat people and aim heads before anyone opens their mouth.
    """
    room = Meeting(helm)
    turns = [t.as_dict() for t in room.run(_norm(symbol))]
    return {"symbol": _norm(symbol), "turns": turns}


@app.get("/api/book")
def book() -> dict:
    return helm.book()


@app.get("/api/wallet")
def wallet() -> dict:
    return helm.wallet_status()


@app.get("/api/say")
def say(seat: str = Query("HELM"), text: str = Query(...)) -> Response:
    """Speak `text` in a seat's own ElevenLabs voice.

    204 means no voice is configured (no API key, or no voice_id for the seat);
    the office falls back to the browser's speech synthesis so the desk still
    talks. Nothing here decides anything — it only reads text aloud.
    """
    audio = narrate.synthesize(seat.upper(), text, settings)
    if not audio:
        return Response(status_code=204)
    return Response(content=audio, media_type="audio/mpeg",
                    headers={"Cache-Control": "no-store"})


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.middleware("http")
async def no_cache_code(request, call_next):
    """Stop the browser serving a stale module.

    index.html imports ./agents.js at a fixed URL, and StaticFiles sends only an
    ETag — no Cache-Control. With no explicit directive a browser may cache
    heuristically, so an edit to agents.js can go unseen through several
    reloads: the page keeps running the old module, complete with the old
    ASSET_V, which then re-requests the old GLBs too. Asset files stay
    cacheable; they are already versioned by the ?v= query.
    """
    response = await call_next(request)
    path = request.url.path
    if path.endswith((".js", ".html")) or path == "/":
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8787, log_level="info")
