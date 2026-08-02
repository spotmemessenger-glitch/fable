/**
 * Spot Me — createAdaptiveNetwork: the ONE flag-gated factory. ADR-012b.
 *
 * The single entry a future wiring PR calls. It reads the LAYERED flags
 * (flags.js) and constructs exactly what they permit:
 *
 *   master OFF            → an INERT STUB. Nothing else runs: no supervisor,
 *                           no outbox, no mesh, no storage opened, and — the
 *                           property the off-state test pins — NOT ONE TIMER
 *                           OR CALLBACK is registered on the injected clock.
 *                           The stub answers `enabled: false` with the reason.
 *   + TRANSPORT_SUPERVISOR → the monitoring/ranking engine exists (started
 *                           only by start()).
 *   + AUTO_TRANSPORT      → decisions may EXECUTE switches; without it the
 *                           supervisor observes and logs but the executor is
 *                           not engaged (shadow mode for staged rollout).
 *   + OFFLINE_MESSAGING   → durable outbox + drainer.
 *   + BLUETOOTH_MESH      → mesh engine (multi-hop additionally gated by
 *                           MULTIHOP_ENABLED via relayFanout 0).
 *
 * Shipped flags are ALL FALSE, so calling this with defaults returns the
 * stub. Tests exercise deeper composition by injecting resolved flag sets —
 * dependency injection, not a runtime override: the shipped constants cannot
 * be flipped from here.
 *
 * THE SEAL-LIFT GATE, RESTATED WHERE WIRING WILL READ IT: even fully
 * flag-enabled, this factory moves ONLY already-sealed envelopes. Chat
 * activation over any NEW transport (BLE/LAN/mesh/Centrifugo) additionally
 * requires the seal-lift — AES-GCM seal/open moving ABOVE the transport —
 * which is gated on Priority 1 activation (ADR-008 §12) and still THROWS in
 * seal-boundary.js. Nothing here changes that, and the activation guide
 * makes it step zero.
 */
import { DEFAULT_FLAGS, resolveFlags } from './flags.js'
import { createTransportRegistry } from './registry.js'
import { createSupervisor } from './supervisor.js'
import { createSystemClock } from './clock.js'
import { createBatteryReader } from './battery.js'
import { createDurableOutbox } from './durable-outbox.js'
import { createMemoryOutbox } from './outbox.js'
import { createOutboxDrainer } from './drain.js'
import { createMeshEngine } from './mesh-engine.js'

export function createAdaptiveNetwork ({
  flags = DEFAULT_FLAGS,
  clock = null,
  deliver = null,            // (envelope, meta) => void — app-facing sink
  selfId = null,             // routing id for the mesh (rotating hash upstream)
  isOnline = null,
  idb = undefined,           // injected IndexedDB for the durable outbox
  getBattery = null,
  registry = null,
  durableOutbox = true       // false → memory outbox (tests, private mode policy)
} = {}) {
  const effective = resolveFlags(flags)

  if (effective.ADAPTIVE_NETWORK_ENABLED !== true) {
    // INERT. Constructed from literals only — no clock use, no storage, no
    // timers, nothing to stop. This object is what the app would hold today
    // if wiring landed with the shipped flags: a named "off".
    return Object.freeze({
      enabled: false,
      reason: 'ADAPTIVE_NETWORK_ENABLED is false — the adaptive network ships dark (ADR-012b)',
      flags: effective,
      supervisor: null,
      drainer: null,
      mesh: null,
      registry: null,
      async start () { return false },
      stop () {}
    })
  }

  const c = clock || createSystemClock()
  const reg = registry || createTransportRegistry()
  const sink = typeof deliver === 'function' ? deliver : () => {}

  const supervisor = effective.TRANSPORT_SUPERVISOR_ENABLED
    ? createSupervisor({
        registry: reg,
        clock: c,
        battery: createBatteryReader({ getBattery, clock: c }),
        isOnline,
        deliver: sink,
        // AUTO_TRANSPORT off ⇒ SHADOW MODE: the engine ranks and logs every
        // would-have-switched decision but never migrates — the staged
        // rollout posture the flag layering encodes.
        config: { autoSwitch: effective.AUTO_TRANSPORT_ENABLED === true }
      })
    : null

  let drainer = null
  let outbox = null
  if (effective.OFFLINE_MESSAGING_ENABLED && supervisor) {
    outbox = durableOutbox ? createDurableOutbox({ idb }) : createMemoryOutbox({})
    drainer = createOutboxDrainer({ outbox, supervisor, clock: c })
  }

  const mesh = effective.BLUETOOTH_MESH_ENABLED && selfId
    ? createMeshEngine({
        selfId,
        clock: c,
        onDeliver: (frame, meta) => sink(frame, { ...meta, mesh: true }),
        // MULTIHOP off ⇒ this node never relays (fan-out 0 on forward), but
        // still originates, delivers, and acks — single-hop BLE still works.
        config: effective.MULTIHOP_ENABLED ? {} : { relayFanout: 0 }
      })
    : null

  let started = false
  return Object.freeze({
    enabled: true,
    reason: null,
    flags: effective,
    supervisor,
    drainer,
    mesh,
    outbox,
    registry: reg,
    async start () {
      if (started) return true
      started = true
      if (outbox?.whenReady) await outbox.whenReady()
      if (supervisor) await supervisor.start()
      if (drainer) drainer.start()
      if (mesh) mesh.start()
      return true
    },
    stop () {
      if (!started) return
      started = false
      mesh?.stop()
      drainer?.stop()
      supervisor?.stop()
      outbox?.close?.()
    }
  })
}
