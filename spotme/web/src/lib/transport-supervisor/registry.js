/**
 * Spot Me — the transport REGISTRY. Priority 2, ADR-012. SCAFFOLDING ONLY.
 *
 * A supervisor that switches transports needs a set to switch BETWEEN. The
 * registry is that set: a name -> { transport, capabilities } table the selector
 * reads and the supervisor drives. It is a FACTORY, not a populated singleton —
 * nothing is registered at module load, because registering a real transport is
 * wiring, and wiring is deferred behind the (off) flag. Tests and benchmarks
 * build their own registries with fakes; the live app would build exactly one,
 * later, in a wiring PR.
 *
 * The registry stores capability ROWS (inert data) alongside each transport so
 * scoring never has to call into a live object just to read a static fact.
 */
import { CAPABILITY_KEYS } from './capabilities.js'

/** Minimal shape check so a bad row cannot enter selection as silent zeros. */
function assertCapabilityRow (caps, name) {
  if (!caps || typeof caps !== 'object') throw new Error(`registry: ${name} has no capabilities`)
  for (const k of CAPABILITY_KEYS) {
    if (!(k in caps)) throw new Error(`registry: ${name} capabilities missing "${k}"`)
  }
}

export function createTransportRegistry () {
  const entries = new Map()   // name -> { name, transport, capabilities }

  return {
    /**
     * Register a transport under a name. Idempotent by name is NOT assumed —
     * re-registering the same name is treated as a caller error, because in the
     * live app two things claiming one transport name is a bug, not an update.
     */
    register (name, { transport, capabilities }) {
      if (!name || typeof name !== 'string') throw new Error('registry: name required')
      if (entries.has(name)) throw new Error(`registry: "${name}" already registered`)
      assertCapabilityRow(capabilities, name)
      entries.set(name, Object.freeze({ name, transport: transport || null, capabilities }))
      return name
    },

    /** Replace a registration deliberately (e.g. a test swapping a fake). */
    replace (name, { transport, capabilities }) {
      assertCapabilityRow(capabilities, name)
      entries.set(name, Object.freeze({ name, transport: transport || null, capabilities }))
      return name
    },

    unregister (name) { return entries.delete(name) },
    has (name) { return entries.has(name) },
    get (name) { return entries.get(name) || null },

    /** Every registration, insertion-ordered. Callers must not mutate the rows. */
    list () { return [...entries.values()] },

    /** Just the capability rows keyed by name — the selector's static input. */
    capabilityMap () {
      const out = {}
      for (const [name, e] of entries) out[name] = e.capabilities
      return out
    },

    get size () { return entries.size }
  }
}
