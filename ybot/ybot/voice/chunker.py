"""Cut a streaming token feed into speakable chunks, as early as is safe.

This is the single biggest lever on *perceived* latency. Waiting for the model
to finish before speaking means the user hears nothing for the whole generation.
Speaking the first clause as soon as it lands means they hear a voice almost
immediately and the rest is synthesised underneath the audio already playing.

The tension: flush too early and prosody breaks — a synthesiser handed "The" and
then "answer is" produces two flat fragments instead of one phrase. Flush too
late and you are back to waiting. So the first chunk is allowed to be short
(latency dominates), and later chunks are held for a full sentence (prosody
dominates, because audio is already playing and there is no longer a race).

Pure text logic — no audio, no engine, no I/O.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# Sentence-final punctuation followed by whitespace, or at end of buffer.
_SENTENCE_END = re.compile(r"[.!?](?=[\s\"')\]]|$)")
# Weaker boundaries — usable for the first chunk only, where speed wins.
_CLAUSE_END = re.compile(r"[,;:—](?=\s)")

# Do not treat the dot in these as a sentence end.
_ABBREVIATIONS = {
    "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "st.",
    "e.g.", "i.e.", "etc.", "vs.", "approx.", "no.", "fig.",
}


@dataclass
class Chunker:
    """Accumulates tokens, emits text when it is worth speaking.

    first_min_chars: below this the first chunk is held even at a clause break —
        "Yes." is a fine first chunk, "Y" is not.
    later_min_chars: sentences shorter than this are merged with the next one, so
        "OK. Sure. Right." becomes one utterance rather than three clipped ones.
    max_chars: hard flush, so a model that never punctuates still produces audio.
    """

    first_min_chars: int = 4
    later_min_chars: int = 15
    max_chars: int = 240

    _buf: str = field(default="", init=False)
    _emitted: int = field(default=0, init=False)

    @property
    def is_first(self) -> bool:
        return self._emitted == 0

    def push(self, token: str) -> list[str]:
        """Add a token; return any chunks that are ready to speak."""
        self._buf += token
        out: list[str] = []
        while True:
            chunk = self._take()
            if chunk is None:
                return out
            out.append(chunk)

    def flush(self) -> str | None:
        """End of stream: emit whatever is left, however short."""
        text = self._buf.strip()
        self._buf = ""
        if text:
            self._emitted += 1
            return text
        return None

    # --- internals ---------------------------------------------------------

    def _take(self) -> str | None:
        buf = self._buf
        if not buf.strip():
            return None

        if len(buf) >= self.max_chars:
            cut = self._last_space_before(buf, self.max_chars) or self.max_chars
            return self._emit(cut)

        minimum = self.first_min_chars if self.is_first else self.later_min_chars

        end = self._sentence_end(buf)
        if end is not None and end >= minimum:
            return self._emit(end)

        # A clause break is only good enough to start talking on. Once audio is
        # playing, holding for a real sentence sounds better and costs nothing.
        if self.is_first:
            m = _CLAUSE_END.search(buf)
            if m and m.end() >= self.first_min_chars:
                return self._emit(m.end())
        return None

    def _emit(self, cut: int) -> str:
        text = self._buf[:cut].strip()
        self._buf = self._buf[cut:].lstrip()
        self._emitted += 1
        return text

    @staticmethod
    def _last_space_before(buf: str, limit: int) -> int:
        """Never split mid-word on a hard flush."""
        idx = buf.rfind(" ", 0, limit)
        return idx + 1 if idx > 0 else 0

    @staticmethod
    def _sentence_end(buf: str) -> int | None:
        """Index just past the first real sentence end, or None.

        Skips abbreviations and decimals — "3.5" and "e.g." must not end a
        sentence, or the voice stops mid-thought.
        """
        for m in _SENTENCE_END.finditer(buf):
            end = m.end()
            if end < len(buf) and buf[end - 1] == "." and buf[end:end + 1].isdigit():
                continue  # decimal point: 3.5
            before = buf[:end]
            last = before.split()[-1].lower() if before.split() else ""
            if last in _ABBREVIATIONS:
                continue
            if len(last) == 2 and last[0].isalpha() and last[1] == ".":
                continue  # initial, e.g. "J. Smith"
            return end
        return None
