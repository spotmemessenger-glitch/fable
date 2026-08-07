/**
 * AI Gateway — the routing seam.
 *
 * `createAiGateway()` returns an object with one implementation per port. Today
 * every port defaults to its deterministic baseline; a later change injects
 * model-backed adapters here (per-port, with fallback to the baseline on
 * quality/latency/availability/cost). No provider is a hard dependency, and no
 * adapter may remove the baseline fallback.
 *
 * DARK: constructing a gateway does nothing on its own, and nothing in the app
 * constructs one yet (fence-enforced).
 */

import { intentBaseline, summaryBaseline, voiceBaseline } from './baseline.js'

/**
 * @param {Partial<import('./ports.js').AiGateway>} [overrides]
 * @returns {import('./ports.js').AiGateway}
 */
export function createAiGateway (overrides = {}) {
  return {
    intent: overrides.intent ?? intentBaseline,
    summary: overrides.summary ?? summaryBaseline,
    voice: overrides.voice ?? voiceBaseline,
  }
}
