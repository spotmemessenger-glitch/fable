/**
 * Live Nearby Events — event detail state.
 *
 * A tiny state machine for the "one event, expanded" view: which event is open
 * and whether its (optional) fuller detail has loaded. Detail enrichment is
 * OPTIONAL and provider-driven; with no detail provider the record we already
 * have IS the detail (state `ready`), never a spinner that never resolves.
 *
 * Pure and framework-free (subscribe/notify with immutable snapshots), so it
 * drives any renderer and tests need no DOM. It invents nothing: if a detail
 * provider returns no extra fields, the event is shown exactly as normalised.
 */

/** Detail lifecycle states. */
export const DETAIL_STATE = Object.freeze({
  CLOSED: 'closed',
  LOADING: 'loading', // fetching richer detail from a provider
  READY: 'ready', // showing the event (base record and/or enriched)
  UNAVAILABLE: 'unavailable' // detail was requested and could not be produced
})

export function createEventDetail () {
  const state = { event: null, status: DETAIL_STATE.CLOSED }
  const subscribers = new Set()
  const snap = () => Object.freeze({
    event: state.event ? Object.freeze({ ...state.event }) : null,
    status: state.status
  })
  const notify = () => { const s = snap(); for (const fn of subscribers) fn(s) }

  /**
   * Open an event. Without a detail provider it is immediately `ready`. With
   * one, goes `loading` → `ready` (merging returned fields) or `unavailable`.
   *
   * @param {object} event  a normalised, state-tagged EventRecord
   * @param {object} [opts]
   * @param {object} [opts.provider]  `{ name, detail(event) → Promise<object> }`
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<object>} the resulting snapshot
   */
  async function open (event, opts = {}) {
    if (!event || event.id == null) {
      state.event = null; state.status = DETAIL_STATE.UNAVAILABLE; notify(); return snap()
    }
    state.event = event
    const provider = opts.provider
    if (!provider || typeof provider.detail !== 'function') {
      state.status = DETAIL_STATE.READY; notify(); return snap()
    }
    state.status = DETAIL_STATE.LOADING; notify()
    try {
      const extra = await provider.detail(event, { signal: opts.signal })
      // Merge only over the base record; a provider cannot blank required fields
      // by returning nulls — we keep the normalised values it doesn't supply.
      state.event = { ...event, ...(extra && typeof extra === 'object' ? extra : {}), id: event.id }
      state.status = DETAIL_STATE.READY
    } catch {
      state.status = DETAIL_STATE.UNAVAILABLE
    }
    notify(); return snap()
  }

  function close () { state.event = null; state.status = DETAIL_STATE.CLOSED; notify() }

  return {
    open,
    close,
    snapshot: snap,
    subscribe (fn) { subscribers.add(fn); return () => subscribers.delete(fn) }
  }
}
