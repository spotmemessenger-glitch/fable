"""Turn spoken text into a timed mouth-shape track.

The avatar rig carries the 15 Oculus visemes (sil PP FF TH DD kk CH SS nn RR
aa E ih oh ou), so lip sync here is real mouth shapes rather than a jaw
flapping to volume — an amplitude-driven jaw reads as a puppet, because the
mouth is equally open on "oo" and "ee".

WHERE THE TIMING COMES FROM

ElevenLabs' with-timestamps endpoint returns a start time for every CHARACTER
it speaks. That is the whole trick: the audio and the timings come from the same
synthesis, so they cannot drift. No forced aligner, no second model.

WHAT THIS IS NOT

Characters are not phonemes. English spelling lies — "though", "tough" and
"through" share letters and almost nothing else. This maps graphemes with a few
digraph rules, which is accurate enough that mouth shapes track speech, and
wrong in the places English is wrong. A real phonemiser (g2p) would improve it;
it is not needed for the mouth to look alive, and pretending otherwise in a
comment would be worse than saying so here.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

# The rig's viseme names, exactly as the shape keys are spelled in avatar.glb.
VISEMES = ("sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR",
           "aa", "E", "ih", "oh", "ou")

# Two-letter spellings that are a single sound. Checked before single letters,
# otherwise "sh" would render as S then H and the mouth would stutter.
DIGRAPHS = {
    "th": "TH", "ch": "CH", "sh": "CH", "ph": "FF", "wh": "ou",
    "ck": "kk", "ng": "nn", "qu": "kk", "oo": "ou", "ee": "E",
    "ou": "ou", "ow": "oh", "oa": "oh", "ai": "E", "ay": "E",
}

LETTERS = {
    "a": "aa", "e": "E", "i": "ih", "o": "oh", "u": "ou", "y": "ih",
    "p": "PP", "b": "PP", "m": "PP",
    "f": "FF", "v": "FF",
    "d": "DD", "t": "DD",
    "n": "nn", "l": "nn",
    "k": "kk", "g": "kk", "c": "kk", "x": "kk",
    "j": "CH",
    "s": "SS", "z": "SS",
    "r": "RR",
    "w": "ou",
    "h": "sil",   # barely shapes the mouth on its own
}

# Below this the mouth should close rather than hold the last shape — a held
# shape through a pause is what makes an avatar look frozen mid-word.
SILENCE_GAP_S = 0.12
MIN_HOLD_S = 0.045


@dataclass(frozen=True)
class VisemeFrame:
    """One mouth shape and when it starts, in seconds from audio start."""
    t: float
    viseme: str

    def as_dict(self) -> dict:
        return {"t": round(self.t, 4), "v": self.viseme}


def viseme_for(text: str, i: int) -> tuple[str, int]:
    """Viseme at position i, plus how many characters it consumed."""
    two = text[i : i + 2].lower()
    if two in DIGRAPHS:
        return DIGRAPHS[two], 2
    one = text[i].lower()
    if one in LETTERS:
        return LETTERS[one], 1
    return "sil", 1        # spaces, punctuation, digits, anything unspoken


def track(characters: Sequence[str], starts: Sequence[float],
          total_s: float | None = None) -> list[VisemeFrame]:
    """Build a viseme track from ElevenLabs character alignment.

    `characters` and `starts` come straight from the API response. Consecutive
    identical shapes are collapsed: re-issuing the same viseme mid-vowel makes
    the mouth twitch, and holding it is what real speech looks like.
    """
    if len(characters) != len(starts):
        raise ValueError(f"alignment mismatch: {len(characters)} chars, {len(starts)} times")

    frames: list[VisemeFrame] = []
    i = 0
    text = "".join(characters)
    while i < len(text):
        vis, used = viseme_for(text, i)
        t = float(starts[i])
        # A real pause closes the mouth, whatever letter comes next.
        if frames and t - frames[-1].t > SILENCE_GAP_S and frames[-1].viseme != "sil":
            frames.append(VisemeFrame(frames[-1].t + MIN_HOLD_S, "sil"))
        if not frames or frames[-1].viseme != vis:
            frames.append(VisemeFrame(t, vis))
        i += used

    if not frames:
        return [VisemeFrame(0.0, "sil")]
    # Always land closed, or the avatar finishes a sentence with its mouth open.
    end = total_s if total_s is not None else frames[-1].t + MIN_HOLD_S * 2
    if frames[-1].viseme != "sil":
        frames.append(VisemeFrame(max(end, frames[-1].t + MIN_HOLD_S), "sil"))
    return frames


def to_payload(frames: Iterable[VisemeFrame]) -> list[dict]:
    """JSON-ready form for the renderer."""
    return [f.as_dict() for f in frames]


def demo() -> None:
    """Check the track is well-formed and actually shaped by the words."""
    # Timings in the shape the API returns them: one start per character.
    text = "Hello, opening Notepad."
    starts = [i * 0.06 for i in range(len(text))]
    frames = track(list(text), starts, total_s=len(text) * 0.06)

    assert frames, "no frames produced"
    times = [f.t for f in frames]
    assert times == sorted(times), f"frames out of order: {times[:8]}"
    assert all(f.viseme in VISEMES for f in frames), "unknown viseme emitted"
    assert frames[-1].viseme == "sil", "track must end with the mouth closed"
    # No two consecutive identical shapes — that would be a wasted twitch.
    assert all(a.viseme != b.viseme for a, b in zip(frames, frames[1:])), "duplicate holds"

    seq = [f.viseme for f in frames]
    # "Hello" -> h(sil) e(E) ll(nn) o(oh): the vowels must actually differ,
    # which is the whole reason for visemes over an amplitude-driven jaw.
    assert "E" in seq and "oh" in seq, seq
    assert "PP" in seq, f"the P in Notepad should close the lips: {seq}"

    # A gap in the timings must close the mouth rather than hold a shape.
    gapped = track(list("ab"), [0.0, 1.0], total_s=1.2)
    assert any(f.viseme == "sil" for f in gapped), gapped

    silent = track([], [], total_s=0.0)
    assert silent[0].viseme == "sil", silent

    print(f"visemes: ok ({len(frames)} frames for {len(text)} chars, seq starts {seq[:6]})")


if __name__ == "__main__":
    demo()
