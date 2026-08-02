/**
 * Test helper — a controllable ITranslationProvider fixture + a #51 platform
 * built over it, for the live-voice suites. Mirrors the `prov()` fixture the
 * translation tests use (same capability shape the registry validates), so
 * live-voice tests drive the REAL platform pipeline deterministically without
 * duplicating provider logic.
 */
import { buildTranslationPlatform } from '../../src/lib/translation/index.js'
import { createProviderRegistry } from '../../src/lib/translation/registry.js'

/** A registrable fake provider. `o.translate` overrides the leg behaviour. */
export function fakeProvider (id, o = {}) {
  const caps = {
    supports: o.supports || ['translate'],
    languagePairs: o.languagePairs || (() => 0.9),
    scripts: o.scripts || ['Latn', 'Taml', 'Deva'],
    streaming: false,
    qualityTier: o.qualityTier || 'high',
    latencyClass: o.latencyClass || 'fast',
    costClass: o.costClass || 'cheap',
    privacy: o.privacy || 'cloud-contract',
    rateLimit: {}
  }
  const p = {
    id,
    capabilities: () => caps,
    health: () => o.health || { circuit: 'closed', p50Ms: 120, p95Ms: o.p95 ?? 700, errorRate: 0 },
    priceSignal: () => ({ unit: 'char', estimatedUnits: 1, costClass: caps.costClass })
  }
  const impl = o.translate || (async ({ text, targetLang }) => ({ text: `⟨${targetLang}⟩ ${text}`, engine: id }))
  for (const cap of caps.supports) p[cap === 'detect' ? 'detectLanguage' : cap] = impl
  return p
}

/**
 * A real (enabled, in-memory) #51 platform over the given fake providers.
 * Defaults to one healthy 'google'. Returns { platform, registry, providers }.
 */
export function fakeTranslationPlatform (providers = null, opts = {}) {
  const registry = createProviderRegistry()
  const list = providers || [fakeProvider('google')]
  for (const p of list) registry.register(p)
  const platform = buildTranslationPlatform({ enabled: true, registry, flags: opts.flags || {}, ...opts.buildOpts })
  return { platform, registry, providers: list }
}
