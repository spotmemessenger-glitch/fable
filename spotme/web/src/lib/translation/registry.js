/**
 * Spot Me — the provider registry (design §3 "registration, not rewrite").
 *
 * A provider becomes usable by REGISTERING, not by being wired into a branch.
 * The registry is the list the router iterates: register an adapter (validated
 * against the contract on the way in), and the router will consider it; nothing
 * else changes. This is the seam that lets today's eight-vendor engine be
 * expressed as data without touching `handler()`.
 *
 * Registration is strict on purpose — `assertImplementsProvider` runs here, so a
 * malformed adapter is refused at the door rather than discovered mid-request.
 * Duplicate ids are refused too: two "sarvam"s is a bug, not a fallback.
 */
import { assertImplementsProvider } from './ITranslationProvider.js'
import { capabilityMatrixData } from './capabilities.js'

/** Create an empty registry. Pure, in-memory; nothing here touches a network. */
export function createProviderRegistry () {
  const providers = new Map()

  return {
    /** Validate and add a provider. Throws on a bad shape or a duplicate id. */
    register (provider) {
      const id = provider?.id
      assertImplementsProvider(provider, id || 'provider')
      if (providers.has(id)) {
        throw new Error(`registry: provider "${id}" already registered`)
      }
      providers.set(id, provider)
      return provider
    },

    get (id) { return providers.get(id) || null },
    has (id) { return providers.has(id) },
    /** Every registered provider, insertion order preserved. */
    list () { return [...providers.values()] },
    ids () { return [...providers.keys()] },
    get size () { return providers.size },

    /** Remove a provider (ops/test seam). */
    remove (id) { return providers.delete(id) },
    clear () { providers.clear() },

    /**
     * The capability matrix as data — every registered provider's declared row,
     * the shape the admin `?op=admin.providers` surface returns (design §8.4).
     * NO message content, ever.
     */
    capabilityMatrix () {
      const declared = capabilityMatrixData()
      const registered = new Set(providers.keys())
      return declared.filter((row) => registered.has(row.id))
    }
  }
}
