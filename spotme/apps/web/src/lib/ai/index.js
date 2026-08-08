/**
 * AI Gateway — public entry point. Provider-neutral ports with deterministic
 * baselines (DPAS ch.05/06). Built and tested, deliberately NOT wired into the
 * app (fence: `test/ai-gateway-not-shipped.test.js`).
 */
export { createAiGateway } from './gateway.js'
export { intentBaseline, summaryBaseline, voiceBaseline } from './baseline.js'
