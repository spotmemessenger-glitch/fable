"""The Meeting Manager — a standup with actual content.

The office already knew how to walk everyone to the table and give each seat a
fixed 2.4 seconds of airtime. That is choreography without a meeting: nobody
said anything, and nobody responded to anyone.

This runs the meeting itself. It produces an ordered sequence of Turns from the
desk's real state, and the 3D office plays them — one speaker at a time, in
that seat's own voice, for however long the line actually takes to say.

Structure, borrowed from how a real desk runs a morning meeting:

    open        HELM states the symbol, the consensus and what is on the table
    report      each seat with a usable reading gives its read
    objection   CASSANDRA argues against the leading view — always, by design
    rebuttal    the highest-conviction seat answers the objection directly
    ruling      SENTINEL gives the actual approve/decline and the reason
    close       HELM synthesises and says what happens next

The safety rule from brain.py carries over unchanged, and is the whole point:

    A meeting DISCUSSES a decision. It never MAKES one.

Sentinel's ruling is read out of the Ruling object Python already computed from
the numbers. Nothing said in this room can change a signal, widen a limit, or
move money.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Iterator

log = logging.getLogger(__name__)

# Seats that judge rather than take a directional view — they speak at fixed
# points in the agenda, not in the general report round.
NON_DIRECTIONAL = ("SENTINEL", "PILOT", "LEDGER", "CASSANDRA", "BALLAST")

MAX_REPORTS = 6          # keep a standup to a standup
MIN_CONFIDENCE = 0.25    # below this a seat has nothing worth the room's time


@dataclass
class Turn:
    """One person speaking once."""

    seat: str
    kind: str                        # open|report|objection|rebuttal|ruling|close
    text: str
    addressed_to: str | None = None  # who this turn answers, for head-turning
    signal: float = 0.0
    confidence: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "seat": self.seat, "kind": self.kind, "text": self.text,
            "addressed_to": self.addressed_to,
            "signal": round(self.signal, 3), "confidence": round(self.confidence, 2),
        }


@dataclass
class Meeting:
    """Runs one standup over one symbol, using the desk's live readings."""

    helm: Any
    agenda: list[Turn] = field(default_factory=list)

    # -- helpers -----------------------------------------------------------

    def _ask(self, seat: str, prompt: str, readings: dict[str, Any],
             symbol: str) -> str:
        """Put a question to one seat's brain, grounded in its own reading."""
        answer = self.helm.brains.ask(prompt, readings=readings, seat=seat,
                                      symbol=symbol)
        return answer["text"]

    @staticmethod
    def _rank(readings: dict[str, Any]) -> list[tuple[str, Any]]:
        """Directional seats worth hearing from, strongest conviction first."""
        rows = [
            (name, r) for name, r in readings.items()
            if r.usable and name not in NON_DIRECTIONAL and r.confidence >= MIN_CONFIDENCE
        ]
        rows.sort(key=lambda kv: abs(kv[1].signal) * kv[1].confidence, reverse=True)
        return rows

    # -- the meeting -------------------------------------------------------

    def run(self, symbol: str) -> Iterator[Turn]:
        """Yield the meeting one turn at a time, so the office can play it.

        Yielding rather than returning a list matters: each line is spoken
        aloud and animated before the next is generated, so the room stays in
        sync with the audio instead of racing ahead of it.
        """
        ctx, consensus, ruling = self.helm.analyse(symbol)
        self.agenda = []
        # Start every meeting cold. Otherwise a seat carries chatter about the
        # previous symbol into this one and contradicts its own fresh reading.
        self.helm.brains.reset()
        for turn in self._script(symbol, ctx.readings, consensus, ruling):
            self.agenda.append(turn)
            yield turn

    def _script(self, symbol: str, readings: dict[str, Any],
                consensus: float, ruling: Any) -> Iterator[Turn]:
        ranked = self._rank(readings)
        leader = ranked[0][0] if ranked else None

        # ---- open --------------------------------------------------------
        stance = "long" if consensus > 0.12 else "short" if consensus < -0.12 else "flat"
        usable = sum(1 for r in readings.values() if r.usable)
        yield Turn(
            "HELM", "open",
            f"{symbol} on the table. The desk is {stance}, consensus "
            f"{consensus:+.2f}, {usable} seats reporting. Round the table.",
            signal=consensus,
        )

        # ---- reports -----------------------------------------------------
        for name, reading in ranked[:MAX_REPORTS]:
            text = self._ask(
                name,
                f"Standup on {symbol}. Give your read in two sentences — your "
                f"strongest number and what it implies. No preamble.",
                readings, symbol,
            )
            yield Turn(name, "report", text,
                       signal=reading.signal, confidence=reading.confidence)

        # ---- objection ---------------------------------------------------
        # Cassandra speaks every meeting whether or not anyone wants it. That
        # is the seat's entire purpose: fourteen agreeing seats is a failure
        # mode, not a consensus.
        cass = readings.get("CASSANDRA")
        if cass is not None:
            lead_txt = f"The room is leaning {stance}."
            if leader:
                lead_txt += f" {leader} is the loudest voice."
            objection = self._ask(
                "CASSANDRA",
                f"{lead_txt} Argue the other side of {symbol} in two sentences. "
                f"Be specific about what would have to be true for the room to "
                f"be wrong.",
                readings, symbol,
            )
            yield Turn("CASSANDRA", "objection", objection, addressed_to=leader,
                       signal=cass.signal, confidence=cass.confidence)

            # ---- rebuttal -------------------------------------------------
            # Quote the objection verbatim. Each seat's brain has its own
            # isolated history, so the leader never heard Cassandra speak —
            # asking it to "answer the objection" without saying what the
            # objection was just produced "I don't know what she said".
            if leader:
                text = self._ask(
                    leader,
                    f'Cassandra just said, quote: "{objection}" Answer that '
                    f"objection directly in two sentences, using only your own "
                    f"numbers. If it is a fair point, concede it.",
                    readings, symbol,
                )
                yield Turn(leader, "rebuttal", text, addressed_to="CASSANDRA",
                           signal=readings[leader].signal,
                           confidence=readings[leader].confidence)

        # ---- cross-talk --------------------------------------------------
        # The two seats furthest apart speak to each other directly, not to the
        # room. A standup where everyone reports to the chair is a queue of
        # monologues; the disagreements are where the information is.
        for turn in self._crosstalk(symbol, readings, ranked):
            yield turn

        # ---- ruling ------------------------------------------------------
        # Read straight out of the Ruling that Python computed. Sentinel's
        # brain only phrases it; the verdict is not up for discussion.
        verdict = "approves" if ruling.approved else "holds"
        reason = ruling.reasons[0] if ruling.reasons else "no reason recorded"
        sent = readings.get("SENTINEL")
        yield Turn(
            "SENTINEL", "ruling",
            f"Sentinel {verdict}: {reason}.",
            confidence=sent.confidence if sent else 0.0,
        )

        # ---- execution ---------------------------------------------------
        for turn in self._execution(symbol, readings, ruling):
            yield turn

        # ---- close -------------------------------------------------------
        nxt = ("Pilot has the entry, sizes and stops as ruled."
               if ruling.approved else
               "Nothing goes on. We watch, and reconvene if it changes.")
        yield Turn("HELM", "close",
                   f"That's the room. {nxt} Back to your desks.",
                   signal=consensus)

    # -- segments ----------------------------------------------------------

    def _crosstalk(self, symbol: str, readings: dict[str, Any],
                   ranked: list[tuple[str, Any]]) -> Iterator[Turn]:
        """The two most-opposed seats argue it out, addressing each other.

        Silent when the room agrees — manufacturing a disagreement that the
        numbers do not support would be theatre, and the point of this desk is
        that the theatre is downstream of real signals.
        """
        if len(ranked) < 2:
            return
        bull = max(ranked, key=lambda kv: kv[1].signal)
        bear = min(ranked, key=lambda kv: kv[1].signal)
        if bull[0] == bear[0] or (bull[1].signal - bear[1].signal) < 0.4:
            return

        opener = self._ask(
            bull[0],
            f"{bear[0]} reads {symbol} the other way — their signal is "
            f"{bear[1].signal:+.2f} against your {bull[1].signal:+.2f}. Put one "
            f"direct question to {bear[0]} about what they are seeing. Two "
            f"sentences, speak to them, not about them.",
            readings, symbol,
        )
        yield Turn(bull[0], "crosstalk", opener, addressed_to=bear[0],
                   signal=bull[1].signal, confidence=bull[1].confidence)

        reply = self._ask(
            bear[0],
            f'{bull[0]} just asked you, quote: "{opener}" Answer them directly '
            f"in two sentences, using your own numbers.",
            readings, symbol,
        )
        yield Turn(bear[0], "crosstalk", reply, addressed_to=bull[0],
                   signal=bear[1].signal, confidence=bear[1].confidence)

    def _execution(self, symbol: str, readings: dict[str, Any],
                   ruling: Any) -> Iterator[Turn]:
        """How the trade actually gets done — or what would have to change.

        Runs on a decline too. A desk that goes quiet when it is flat teaches
        the operator nothing; PILOT saying what it is watching for is the
        difference between a system that waits and one that is asleep.
        """
        sent = readings.get("SENTINEL")
        pilot = readings.get("PILOT")

        if ruling.approved:
            if sent is not None:
                text = self._ask(
                    "SENTINEL",
                    f"The trade on {symbol} is approved. State the size and the "
                    f"stop in two sentences, using only the numbers in your "
                    f"reading. Be exact — Pilot works from this.",
                    readings, symbol,
                )
                yield Turn("SENTINEL", "sizing", text, addressed_to="PILOT",
                           confidence=sent.confidence)
            if pilot is not None:
                text = self._ask(
                    "PILOT",
                    f"Sentinel has signed off on {symbol}. From your spread, "
                    f"depth and slippage numbers, say in two sentences how you "
                    f"will work the entry and what would make you refuse the "
                    f"fill.",
                    readings, symbol,
                )
                yield Turn("PILOT", "execution", text, addressed_to="SENTINEL",
                           confidence=pilot.confidence)
        elif pilot is not None:
            text = self._ask(
                "PILOT",
                f"The desk is standing aside on {symbol}. Say in two sentences "
                f"what you are watching in the book that would tell you the "
                f"picture is changing. Use only your own numbers.",
                readings, symbol,
            )
            yield Turn("PILOT", "watching", text, confidence=pilot.confidence)

    # -- convenience -------------------------------------------------------

    def transcript(self) -> list[dict[str, Any]]:
        """The last meeting as plain dicts — for the dashboard and the journal."""
        return [t.as_dict() for t in self.agenda]
