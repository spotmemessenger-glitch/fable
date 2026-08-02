/**
 * Spot Me — Live Voice Translation (flagship). Roadmap V2 §6, ADR-011.
 *
 * ⚠ SCAFFOLDING ONLY, FLAG OFF, NOT WIRED IN. This directory is the typed
 * skeleton of the live-voice pipeline: streaming interfaces, a state machine, a
 * latency-budget type, wire frames, an orchestrator that runs the STT→MT→(LLM)→
 * TTS→playback order on STUB adapters, and the deterministic stubs themselves.
 * No real provider is contacted, no microphone is opened, no network frame is
 * sent, and no cryptographic behaviour is touched. `LIVE_VOICE_ENABLED` defaults
 * to false and nothing in the app imports this module.
 *
 * This barrel re-exports the pieces and defines ONE thing of its own: the future
 * wire-in entry point, `bootLiveVoice()`, which refuses to do anything while the
 * flag is off. It is defined so the eventual integration has a single, obvious,
 * flag-checked door — and it is deliberately called from nowhere yet.
 *
 * See docs/adr/011-live-voice-translation-scaffold.md for the decisions, the
 * rollback, and the IMPLEMENTED-vs-DEFERRED list; and
 * docs/priority-2/03-live-voice-benchmark-plan.md for how the targets get
 * measured.
 */

export { LIVE_VOICE_FLAG, isLiveVoiceEnabled, setLiveVoiceOverride } from './flags.js'

export {
  FRAME_TYPES, CONTROL_SIGNALS, FRAME_SCHEMA_VERSION,
  makeAudioInFrame, makePartialCaptionFrame, makeTranslatedAudioOutFrame, makeControlFrame,
  assertFrame, isFrameType
} from './frames.js'

export {
  StreamingStatus, STREAM_HANDLERS, FORBIDDEN_RETENTION_SURFACE,
  STREAMING_STT_METHODS, STREAMING_MT_METHODS, STREAMING_TTS_METHODS,
  assertImplementsStreamingStt, assertImplementsStreamingMt, assertImplementsStreamingTts,
  assertStreamController, normalizeHandlers
} from './streaming-interfaces.js'

export {
  UTTERANCE_STATES, SESSION_STATES, TERMINAL_UTTERANCE_STATES,
  UTTERANCE_TRANSITIONS, SESSION_TRANSITIONS,
  canTransition, isTerminalUtterance,
  createMachine, createUtteranceMachine, createSessionMachine,
  createLiveTranslationSession
} from './session-state.js'

export {
  TOTAL_BUDGET_MS, STAGE_BUDGETS_MS, STAGE_ORDER, createLatencyBudget
} from './latency-budget.js'

export {
  makeManualClock,
  createStubStreamingStt, createStubStreamingMt, createStubStreamingTts,
  createStubCorrector, createStubPlayback
} from './stub-adapters.js'

export { createLiveVoiceOrchestrator, createFrameCollector } from './orchestrator.js'

import { isLiveVoiceEnabled } from './flags.js'

/**
 * The future integration door. Returns `{ started: false, reason }` while the
 * flag is off — which is ALWAYS, this cycle — so a caller that forgets to check
 * the flag still cannot accidentally start the feature. When the real providers
 * land, this is where they get selected (with routing/fallback per the standing
 * AI principle) and handed to `createLiveVoiceOrchestrator`.
 *
 * It is exported and intentionally unreferenced by the app. Wiring it in is a
 * separate, reviewed change (ADR-011 §Rollback).
 */
export function bootLiveVoice (opts = {}) {
  if (!isLiveVoiceEnabled()) {
    return { started: false, reason: 'LIVE_VOICE_ENABLED is off (scaffolding only)' }
  }
  // DEFERRED: real provider selection + orchestrator construction + transport
  // wiring live here behind the flag. Not implemented this cycle.
  return { started: false, reason: 'live-voice runtime not implemented (scaffolding only)', opts }
}
