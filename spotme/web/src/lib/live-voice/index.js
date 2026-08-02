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

export {
  LIVE_VOICE_FLAG, isLiveVoiceEnabled, setLiveVoiceOverride,
  LIVE_VOICE_SUBFLAGS, isLiveTranslationEnabled, isVoiceCloneEnabled,
  isLiveCaptionsEnabled, isGroupTranslationEnabled, isStreamingProviderEnabled,
  setLiveVoiceSubOverride, liveVoiceFlagSnapshot
} from './flags.js'

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

/* --------------------------- the platform build (Priority 2C, ADR-011b) --- */

export {
  createElevenLabsStreamingStt, ELEVENLABS_STT_URL, ELEVENLABS_STT_MODEL
} from './providers/elevenlabs-stt.js'
export {
  createElevenLabsStreamingTts, buildTtsStreamUrl, chunkTextForStreaming,
  ELEVENLABS_TTS_WS_BASE, ELEVENLABS_TTS_STREAM_MODELS, DEFAULT_OUTPUT_FORMAT
} from './providers/elevenlabs-tts.js'
export {
  mapProsodyToVoiceSettings, isLegalVoiceSettings, NEUTRAL_PROSODY, SPEED_RANGE
} from './providers/prosody.js'
export { createFailoverChain } from './providers/failover.js'
export { createTranslationPlatformMt, STRICT_PRIVACY_REFUSAL } from './mt-stage.js'
export { beginSharedSttUtterance } from './shared-stt.js'
export { fanoutForUtterance, whoHearsWhatMatrix, planCall, normalizeParticipant } from './fanout.js'
export { createLiveVoiceSession, NEUTRAL_VOICE_ID, SESSION_MODES } from './live-session.js'
export { createCallIntegration, UI_EVENTS } from './call-integration.js'
export { createLatencyAggregator, percentile, DEFAULT_RING_CAPACITY } from './metrics.js'
export { createVad, VAD_DEFAULTS } from './quality/vad.js'
export { createJitterBuffer, JITTER_DEFAULTS } from './quality/jitter-buffer.js'
export { createDegradationLadder, DEGRADATION_TIERS, TIER_ORDER, LADDER_DEFAULTS } from './quality/degradation-ladder.js'
export { createDiarizer, DIARIZER_DEFAULTS } from './quality/diarization.js'
export { LIVE_VOICE_AUDIO_CONSTRAINTS, applyLiveVoiceConstraints } from './quality/constraints.js'

import { isLiveVoiceEnabled, isLiveTranslationEnabled } from './flags.js'
import { createCallIntegration } from './call-integration.js'

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
  if (!isLiveTranslationEnabled()) {
    return { started: false, reason: 'LIVE_TRANSLATION_ENABLED is off — the layered flag must also be raised' }
  }
  // The runtime now exists (ADR-011b): with both flags up and the deps
  // supplied, the door hands back a NOT-YET-ATTACHED integration — the caller
  // still has to call attach(), which re-checks the flags. Nothing in the app
  // calls this; adopting it is the separate, reviewed wire-in change.
  const { call, participants, selfId, adapters } = opts
  if (!call || !participants || !selfId || !adapters) {
    return { started: false, reason: 'missing deps: { call, participants, selfId, adapters } required' }
  }
  return { started: true, integration: createCallIntegration(opts) }
}
