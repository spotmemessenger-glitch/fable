---
name: voice-assistant
description: Build a real-time streaming voice assistant — streaming STT, barge-in, chunked TTS, model routing, and turn state. Use when working on ybot's voice layer or any conversational voice pipeline, when latency makes an assistant feel slow, when interruption handling is broken, or when choosing between fast and smart models per utterance.
allowed-tools: [Read, Grep, Glob, Edit, Write, Bash]
---

# Real-time voice assistant

Reference implementation: `ybot/ybot/voice/` — `chunker.py`, `state.py`,
`router.py`, `engines.py`, tested in `ybot/tests/test_voice.py` with no audio
hardware. Read those before changing behaviour.

## Perceived latency is the only latency

Users do not experience total response time; they experience **time to first
audio**. A 400ms first word followed by 3s of streaming feels instant. A
silent 1.5s followed by a complete answer feels broken. Optimise the first
number and the second stops mattering.

This inverts the usual instinct. Do not wait for a good answer — start
speaking a true, short one and continue generating underneath the audio.

## The pipeline streams at every stage

```
mic → streaming STT → route → [memory] → LLM stream → chunker → TTS → speaker
                ↑                                                      │
                └──────── barge-in: speech detected while speaking ────┘
```

No stage waits for the previous one to finish where streaming is possible. The
two that matter most:

- **STT must emit partials.** A recogniser returning only finals adds its full
  processing time to perceived latency and makes early barge-in detection
  impossible.
- **TTS must be cancellable synchronously.** `stop()` has to cut audio already
  handed to the speaker. A synthesiser that can only be left to finish cannot
  support barge-in, however good the rest of the system is.

Enforce both at the adapter boundary (`engines.py` Protocols) so a vendor that
cannot do them fails at integration, not in production.

## Chunking: early for the first, whole sentences after

The first chunk may flush on a clause boundary — a comma is enough. Every later
chunk waits for a full sentence.

The asymmetry is the design: for the first chunk latency dominates, because the
user is sitting in silence. Once audio plays there is no race, and prosody
dominates — a synthesiser handed fragments produces flat, clipped speech.

Guard the boundary detector against `Dr.`, `e.g.`, initials, and decimals
(`3.5`). Each one splits a sentence mid-thought and the voice audibly stops in
the wrong place.

Always include a `max_chars` hard flush. A model that never punctuates must not
leave the user in silence — and never split mid-word when it fires.

## Barge-in: stop, then fix the transcript

When the user speaks while the assistant is talking: cut audio immediately,
cancel in-flight generation and any running tool, and switch to listening.
Finishing the sentence first reads as "not listening" and the user repeats
themselves.

**The part most implementations miss:** what the user *heard* is not what was
generated. Audio already queued kept playing; the tail never reached them. If
you record the generated text as conversation history, the model believes it
said things the user never heard, and later refers back to them. Truncate the
turn to the spoken prefix — `Conversation._finish` does this, and
`test_interrupted_turn_records_what_was_heard_not_what_was_generated` pins it.

Barge-in during *thinking* (before any audio) must also abandon the turn.

## Routing: three tiers, biased toward fast

| Tier | For | Why |
|---|---|---|
| LOCAL | "stop", "cancel", "louder", "repeat" | Control, not conversation. A round trip on "stop" is unforgivable |
| FAST | Greetings, short answers, mechanical desktop steps | Most utterances; latency is the product |
| SMART | Planning, architecture, debugging, research | Reasoning is worth the wait |

Route with keywords, not a model — asking a model which model to use costs the
latency the routing was meant to save.

Misroutes are asymmetric: FAST failing on something hard is recoverable
(escalate on evidence), SMART answering "hello" is dead air the user always
notices. So bias to FAST and escalate only after the fast model actually fails.

Context matters for control words: "wait" mid-sentence is conversation; "wait"
while a task runs is a command. Pass a `busy` flag.

## Testing without hardware

Keep every decision — when to speak, when to stop, what was said, which model —
in pure logic behind Protocol adapters. Then the behaviour that determines
whether the assistant feels human is testable on any machine, and only the
vendor glue needs a microphone. `NullSynthesizer` records what would have been
spoken; `ScriptedRecognizer` replays transcripts.

## Anti-patterns

- Waiting for the full LLM response before synthesising.
- Sentence-splitting on `.` without abbreviation and decimal guards.
- Recording generated text, not spoken text, after an interruption.
- Routing every utterance to the largest model "for quality".
- Using an LLM call to classify intent before the real LLM call.
- A TTS whose `stop()` only prevents *future* audio.
- Asking the user for something already in session memory.
