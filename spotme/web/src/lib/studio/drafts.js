/**
 * Spot Me — Creative Studio drafts: op-docs in IndexedDB, never pixels.
 *
 * A draft is the serialized edit DOCUMENT plus source references — that is
 * the whole point of the non-destructive core: reopening a draft re-renders
 * from the original media, so drafts stay a few KB and re-encode nothing.
 *
 * CONTENT RULES (these are user photos' edit history — content, not config):
 *   wipe     the database name 'spotme-studio-drafts' is on db.js's
 *            wipeDevice() list. While the studio is dark the DB is never
 *            created, and deleting a nonexistent database is a no-op success.
 *   TTL      a draft can carry expiresAt; list() deletes and skips expired
 *            records. A draft born from a disappearing-message conversation
 *            must be given that conversation's msgTtl so the edit history
 *            dies NO LATER than the message it edits
 *            (docs/ai-camera/studio-threat-model.md).
 *   LRU      bounded by count and bytes; oldest-updated evicted first.
 *   corrupt  a record that fails to parse is deleted, skipped and COUNTED in
 *            the result — one bad row can neither crash the picker nor hide.
 *
 * Storage may be absent (private mode, Node) — every entry point answers
 * "unavailable" instead of throwing, exactly like lib/blobstore.js.
 * The flag gate is stricter than blobstore's availability: with
 * STUDIO_DRAFTS_ENABLED off nothing here touches `idb` AT ALL (inertness is
 * fence-tested with a throwing fake).
 */

import { parseEditDoc } from './opdoc.js'

export const DRAFTS_DB = 'spotme-studio-drafts'
export const DRAFTS_STORE = 'drafts'
export const DRAFTS_DB_VERSION = 1
export const MAX_DRAFTS = 40
export const MAX_TOTAL_BYTES = 16_000_000
export const MAX_THUMB_CHARS = 40_000

export function createDraftsStore ({ flags, clock, idb } = {}) {
  if (!flags || typeof flags !== 'object') throw new TypeError('drafts: resolved flags required')
  if (!clock) throw new TypeError('drafts: clock required')
  const enabled = flags.STUDIO_DRAFTS_ENABLED === true
  const source = () => (idb !== undefined ? idb : (typeof indexedDB !== 'undefined' ? indexedDB : null))

  let dbPromise = null
  function open () {
    const backend = source()
    if (!backend) return Promise.resolve(null)
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve) => {
      let req
      try {
        req = backend.open(DRAFTS_DB, DRAFTS_DB_VERSION)
      } catch {
        return resolve(null)
      }
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(DRAFTS_STORE)) db.createObjectStore(DRAFTS_STORE, { keyPath: 'id' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    })
    dbPromise = dbPromise.then((db) => { if (!db) dbPromise = null; return db })
    return dbPromise
  }

  async function tx (mode, fn, fallback = null) {
    const db = await open()
    if (!db) return fallback
    return new Promise((resolve) => {
      let t
      try {
        t = db.transaction(DRAFTS_STORE, mode)
      } catch {
        return resolve(fallback)
      }
      let out = fallback
      t.oncomplete = () => resolve(out)
      t.onerror = () => resolve(fallback)
      t.onabort = () => resolve(fallback)
      try {
        fn(t.objectStore(DRAFTS_STORE), (value) => { out = value })
      } catch {
        resolve(fallback)
      }
    })
  }

  const disabled = { ok: false, reason: 'disabled' }
  const unavailable = { ok: false, reason: 'unavailable' }

  function randomId () {
    try {
      const buf = new Uint8Array(8)
      globalThis.crypto.getRandomValues(buf)
      return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
    } catch {
      return `d${clock.now().toString(16)}${Math.floor(Math.random() * 1e9).toString(16)}`
    }
  }

  return {
    available: () => enabled && Boolean(source()),

    /**
     * Persist one draft. { doc (live edit doc OR serialized string), refs,
     * thumb?, ttlMs?, id? } → { ok, id } | { ok: false, reason }.
     */
    async save (draft = {}) {
      if (!enabled) return disabled
      const serialized = typeof draft.doc === 'string' ? draft.doc : draft.doc?.serialize?.()
      if (typeof serialized !== 'string' || !serialized) return { ok: false, reason: 'no document' }
      try {
        parseEditDoc(serialized)                     // refuse to store what cannot restore
      } catch (e) {
        return { ok: false, reason: `invalid document: ${e.message}` }
      }
      const refs = Array.isArray(draft.refs) ? draft.refs.filter((r) => typeof r === 'string' && r).slice(0, 24) : []
      const thumb = typeof draft.thumb === 'string' && draft.thumb.length <= MAX_THUMB_CHARS ? draft.thumb : null
      const now = clock.now()
      const ttl = Number(draft.ttlMs)
      const record = {
        id: typeof draft.id === 'string' && draft.id ? draft.id : randomId(),
        createdAt: draft.createdAt || now,
        updatedAt: now,
        expiresAt: Number.isFinite(ttl) && ttl > 0 ? now + ttl : 0,
        doc: serialized,
        refs,
        thumb,
        bytes: serialized.length + (thumb?.length || 0)
      }
      const wrote = await tx('readwrite', (os, done) => {
        os.put(record)
        done(true)
      }, false)
      if (!wrote) return unavailable
      await this.prune()
      return { ok: true, id: record.id }
    },

    /** All live drafts, newest first: { drafts, skipped }. Expired and
     *  corrupt records are deleted on the way through. */
    async list () {
      if (!enabled) return { drafts: [], skipped: 0, reason: 'disabled' }
      const rows = await tx('readonly', (os, done) => {
        const req = os.getAll()
        req.onsuccess = () => done(req.result || [])
      }, null)
      if (rows === null) return { drafts: [], skipped: 0, reason: 'unavailable' }
      const now = clock.now()
      const drafts = []
      const doomed = []
      let skipped = 0
      for (const row of rows) {
        if (!row || typeof row.id !== 'string' || typeof row.doc !== 'string') {
          skipped++
          if (row?.id) doomed.push(row.id)
          continue
        }
        if (row.expiresAt > 0 && now >= row.expiresAt) {
          doomed.push(row.id)                        // TTL: gone means gone
          continue
        }
        try {
          parseEditDoc(row.doc)
        } catch {
          skipped++
          doomed.push(row.id)
          continue
        }
        drafts.push({
          id: row.id,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          expiresAt: row.expiresAt,
          refs: row.refs || [],
          thumb: row.thumb || null,
          bytes: row.bytes || row.doc.length
        })
      }
      if (doomed.length) {
        await tx('readwrite', (os, done) => {
          for (const id of doomed) os.delete(id)
          done(true)
        }, false)
      }
      drafts.sort((a, b) => b.updatedAt - a.updatedAt)
      return { drafts, skipped }
    },

    /** Restore one draft: { ok, doc (LIVE edit document), refs, … }. */
    async openDraft (id) {
      if (!enabled) return disabled
      const row = await tx('readonly', (os, done) => {
        const req = os.get(id)
        req.onsuccess = () => done(req.result ?? null)
      }, null)
      if (!row) return { ok: false, reason: 'not found' }
      if (row.expiresAt > 0 && clock.now() >= row.expiresAt) {
        await this.remove(id)
        return { ok: false, reason: 'expired' }
      }
      try {
        return { ok: true, id: row.id, doc: parseEditDoc(row.doc), refs: row.refs || [], updatedAt: row.updatedAt }
      } catch (e) {
        await this.remove(id)
        return { ok: false, reason: `corrupt: ${e.message}` }
      }
    },

    async remove (id) {
      if (!enabled) return false
      return tx('readwrite', (os, done) => {
        os.delete(id)
        done(true)
      }, false)
    },

    /** LRU enforcement: count and byte caps, oldest-updated evicted first. */
    async prune () {
      if (!enabled) return { evicted: 0 }
      const rows = await tx('readonly', (os, done) => {
        const req = os.getAll()
        req.onsuccess = () => done(req.result || [])
      }, null)
      if (!rows) return { evicted: 0 }
      const live = rows.filter((r) => r && typeof r.id === 'string')
      live.sort((a, b) => b.updatedAt - a.updatedAt)      // newest first
      let bytes = 0
      const doomed = []
      live.forEach((row, i) => {
        bytes += row.bytes || 0
        if (i >= MAX_DRAFTS || bytes > MAX_TOTAL_BYTES) doomed.push(row.id)
      })
      if (doomed.length) {
        await tx('readwrite', (os, done) => {
          for (const id of doomed) os.delete(id)
          done(true)
        }, false)
      }
      return { evicted: doomed.length }
    }
  }
}
