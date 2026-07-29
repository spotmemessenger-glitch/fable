"""Voice pipeline logic. Runs with no microphone, speaker, or vendor.

Everything hardware-bound sits behind engines.py, so the behaviour that decides
whether the assistant feels human — when it starts talking, when it stops, what
it believes it said — is testable here.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ybot.voice import (  # noqa: E402
    Chunker,
    Conversation,
    Event,
    NullSynthesizer,
    State,
    Tier,
    route,
)
from ybot.voice.router import escalate  # noqa: E402


def stream(chunker: Chunker, text: str) -> list[str]:
    """Feed text word by word, as a model would emit it."""
    out = []
    for word in text.split(" "):
        out += chunker.push(word + " ")
    tail = chunker.flush()
    if tail:
        out.append(tail)
    return out


# --- chunker: time-to-first-audio -----------------------------------------

def test_first_chunk_emits_before_the_sentence_ends():
    """The whole point: start speaking on a clause, not after the full reply."""
    c = Chunker()
    out = []
    for word in "Sure, I will open the browser and search for it.".split(" "):
        out += c.push(word + " ")
        if out:
            break
    assert out == ["Sure,"]


def test_later_chunks_wait_for_a_full_sentence():
    """Once audio is playing there is no race, so prosody wins over speed."""
    c = Chunker()
    c.push("Yes, ")           # first chunk leaves on the comma
    assert not c.is_first
    mid = c.push("this part is long enough to matter, ")
    assert mid == [], "a comma must not split once we are already speaking"


def test_full_stream_splits_into_sentences():
    out = stream(Chunker(), "Okay. I opened the file. It has three lines in it.")
    assert out == ["Okay.", "I opened the file.", "It has three lines in it."]


def test_abbreviations_do_not_end_a_sentence():
    out = stream(Chunker(), "Dr. Smith replied to the message and said it was fine.")
    assert len(out) == 1, f"split mid-thought: {out}"


def test_decimals_do_not_end_a_sentence():
    out = stream(Chunker(), "The file is 3.5 megabytes which is under the limit here.")
    assert len(out) == 1, f"split on a decimal point: {out}"


def test_unpunctuated_stream_still_produces_audio():
    """A model that never punctuates must not leave the user in silence."""
    out = stream(Chunker(max_chars=60), "word " * 60)
    assert len(out) > 1
    assert all(len(chunk) <= 60 for chunk in out)


def test_hard_flush_never_splits_mid_word():
    out = stream(Chunker(max_chars=40), "supercalifragilistic " * 6)
    assert all("supercalifragilistic" in c or c.strip() for c in out)
    for chunk in out:
        for word in chunk.split():
            assert word == "supercalifragilistic", f"word was cut: {word!r}"


def test_flush_returns_the_tail():
    c = Chunker()
    c.push("No punctuation here")
    assert c.flush() == "No punctuation here"
    assert c.flush() is None


# --- barge-in --------------------------------------------------------------

def test_speaking_then_user_talks_stops_audio_immediately():
    tts = NullSynthesizer()
    convo = Conversation(on_stop_audio=tts.stop)
    convo.handle(Event.REPLY_START)
    convo.handle(Event.AUDIO_START)
    assert convo.is_speaking

    convo.handle(Event.SPEECH_START)
    assert tts.stopped == 1
    assert convo.state is State.LISTENING
    assert convo.barge_ins == 1


def test_barge_in_cancels_in_flight_work():
    cancelled = []
    convo = Conversation(on_cancel_work=lambda: cancelled.append(1))
    convo.handle(Event.REPLY_START)
    convo.handle(Event.SPEECH_START)
    assert cancelled == [1], "generation must be torn down, not left running"


def test_interrupted_turn_records_what_was_heard_not_what_was_generated():
    """The desync bug: the model must not believe it said the unheard tail.

    Without this the assistant later refers back to a sentence the user never
    heard, and the conversation quietly comes apart.
    """
    convo = Conversation()
    convo.handle(Event.REPLY_START)
    convo.handle(Event.AUDIO_START)
    convo.spoke("The first part played.")
    convo.generated("The first part played.")
    convo.generated("This tail was cut off.")

    convo.handle(Event.SPEECH_START)

    turn = convo.history[-1]
    assert turn.interrupted
    assert turn.reply_text == "The first part played."
    assert "cut off" not in turn.reply_text


def test_completed_turn_keeps_the_whole_reply():
    convo = Conversation()
    convo.handle(Event.REPLY_START)
    convo.handle(Event.AUDIO_START)
    convo.generated("All of it was said.")
    convo.spoke("All of it was said.")
    convo.handle(Event.REPLY_DONE)

    turn = convo.history[-1]
    assert not turn.interrupted
    assert turn.reply_text == "All of it was said."


def test_speech_while_idle_is_not_a_barge_in():
    tts = NullSynthesizer()
    convo = Conversation(on_stop_audio=tts.stop)
    convo.handle(Event.SPEECH_START)
    assert convo.barge_ins == 0
    assert tts.stopped == 0


def test_speech_end_captures_the_utterance():
    convo = Conversation()
    convo.handle(Event.SPEECH_START)
    convo.handle(Event.SPEECH_END, "open notepad")
    assert convo.turn.user_text == "open notepad"


def test_barge_in_during_thinking_also_cancels():
    """Before any audio plays, an interruption must still abandon the turn."""
    tts = NullSynthesizer()
    convo = Conversation(on_stop_audio=tts.stop)
    convo.handle(Event.REPLY_START)
    assert convo.state is State.THINKING
    convo.handle(Event.SPEECH_START)
    assert convo.barge_ins == 1
    assert convo.state is State.LISTENING


# --- routing ---------------------------------------------------------------

@pytest.mark.parametrize("phrase", ["stop", "cancel", "never mind", "shut up"])
def test_stop_words_never_reach_a_model(phrase):
    r = route(phrase)
    assert r.tier is Tier.LOCAL and r.control == "stop"


def test_stop_inside_a_short_phrase_while_busy():
    """'no wait stop' during a task must cut it, not become conversation."""
    assert route("no wait stop", busy=True).control in ("stop", "pause")


def test_control_word_when_idle_is_not_forced_local():
    """Same words mid-conversation are usually just talk."""
    r = route("I had to wait for the download to finish before it worked", busy=False)
    assert r.tier is not Tier.LOCAL


@pytest.mark.parametrize("phrase", ["hi", "thanks", "good morning", "okay"])
def test_greetings_use_the_fast_model(phrase):
    assert route(phrase).tier is Tier.FAST


@pytest.mark.parametrize("phrase", [
    "design the architecture for the sync layer",
    "why does the build fail on windows",
    "research the best approach and compare them",
    "refactor this module",
])
def test_reasoning_requests_use_the_smart_model(phrase):
    assert route(phrase).tier is Tier.SMART


def test_mechanical_requests_default_to_fast():
    assert route("open notepad and type hello").tier is Tier.FAST


def test_multi_step_requests_escalate():
    r = route("open the report then export it and email it to the team")
    assert r.tier is Tier.SMART


def test_empty_utterance_is_a_noop():
    assert route("   ").control == "noop"


def test_escalation_is_one_way():
    fast = route("open notepad")
    smart = escalate(fast)
    assert smart.tier is Tier.SMART
    assert escalate(smart) is smart
