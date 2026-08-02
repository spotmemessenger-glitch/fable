/**
 * Spot Me — Creative Studio edit document (the non-destructive core).
 *
 * An edit is DATA: an ordered list of typed, versioned, pure ops over a named
 * source. Pixels are never mutated in place — the evaluator renders
 * source + ops[0..cursor] from scratch, which is what makes undo/redo a
 * cursor move ("document slicing"), re-render deterministic, drafts cheap
 * (persist the ops, not re-encoded pixels), and the format future-proof
 * (versioned ops can be migrated; unknown ops are a hard error, not a silent
 * skip that would render a different photo than the one the user saved).
 *
 * Ops reference secondary pixel inputs (a replacement background, a mask
 * already lives inline as RLE) through the ASSET table by id; assets carry
 * source references — a blobstore key or data URL — never decoded pixels, so
 * a serialized document stays small and JSON-pure.
 *
 * Schema (v1):
 *   { kind: 'spotme-studio-opdoc', v: 1,
 *     source: { w, h, ref },
 *     assets: [{ id, type: 'image', ref }],
 *     ops:    [{ op, v, params }] }
 */

export const OPDOC_KIND = 'spotme-studio-opdoc'
export const OPDOC_VERSION = 1

/** Bounds that keep a hostile or runaway document from becoming a DoS. */
export const MAX_OPS = 256
export const MAX_ASSETS = 16
export const MAX_PARAM_DEPTH = 6
export const MAX_DOC_CHARS = 2_000_000   // masks are RLE; 2 MB of JSON is already extreme

/* ------------------------------------------------------- JSON-pure params */

/**
 * Ops must serialize losslessly: only null, booleans, finite numbers,
 * strings, arrays and plain objects, to a bounded depth. Functions, NaN,
 * Infinity, class instances and cycles are authoring bugs — better rejected
 * at addOp() than discovered as a corrupt draft.
 */
export function assertJsonPure (value, depth = 0, path = 'params') {
  if (depth > MAX_PARAM_DEPTH) throw new RangeError(`${path}: nesting deeper than ${MAX_PARAM_DEPTH}`)
  if (value === null) return
  const t = typeof value
  if (t === 'boolean' || t === 'string') return
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`${path}: non-finite number`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJsonPure(v, depth + 1, `${path}[${i}]`))
    return
  }
  if (t === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError(`${path}: not a plain object`)
    }
    for (const [k, v] of Object.entries(value)) assertJsonPure(v, depth + 1, `${path}.${k}`)
    return
  }
  throw new TypeError(`${path}: unsupported ${t}`)
}

/** Deterministic JSON: object keys sorted at every level, so the same
 *  document always serializes to the same bytes (draft dedupe, golden tests). */
export function stableStringify (value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

/* ------------------------------------------------------------- documents */

function checkSource (source) {
  if (!source || typeof source !== 'object') throw new TypeError('opdoc: source required')
  const { w, h, ref } = source
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new RangeError('opdoc: source needs integer w/h')
  }
  if (typeof ref !== 'string' || !ref) throw new TypeError('opdoc: source.ref must be a non-empty string')
  return { w, h, ref }
}

function checkOp (op) {
  if (!op || typeof op !== 'object') throw new TypeError('opdoc: op must be an object')
  if (typeof op.op !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(op.op)) {
    throw new TypeError(`opdoc: bad op name ${String(op.op)}`)
  }
  if (!Number.isInteger(op.v) || op.v < 1) throw new RangeError(`opdoc: op ${op.op} needs integer v >= 1`)
  const params = op.params ?? {}
  assertJsonPure(params, 0, `${op.op}.params`)
  // Deep-copy through JSON so a caller mutating its params object later
  // cannot silently rewrite committed history.
  return { op: op.op, v: op.v, params: JSON.parse(JSON.stringify(params)) }
}

/**
 * Create a live edit document.
 *
 * History model: `ops` plus a cursor. addOp() truncates any redo tail —
 * branching history is deliberately not a feature (it is how photo editors
 * confuse people). undo()/redo() move the cursor; nothing is ever re-rendered
 * here, the evaluator is handed `activeOps()`.
 */
export function createEditDoc ({ source, assets = [], ops = [] } = {}) {
  const src = checkSource(source)
  const assetList = []
  const assetIds = new Set()
  const history = []
  let cursor = 0

  const doc = {
    source: () => ({ ...src }),

    addAsset ({ id, type = 'image', ref }) {
      if (typeof id !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(id)) throw new TypeError('opdoc: bad asset id')
      if (assetIds.has(id)) throw new Error(`opdoc: duplicate asset ${id}`)
      if (type !== 'image') throw new RangeError(`opdoc: unsupported asset type ${type}`)
      if (typeof ref !== 'string' || !ref) throw new TypeError('opdoc: asset ref must be a non-empty string')
      if (assetList.length >= MAX_ASSETS) throw new RangeError(`opdoc: more than ${MAX_ASSETS} assets`)
      assetList.push({ id, type, ref })
      assetIds.add(id)
      return doc
    },
    assets: () => assetList.map((a) => ({ ...a })),

    addOp (op) {
      const clean = checkOp(op)
      if (cursor >= MAX_OPS) throw new RangeError(`opdoc: more than ${MAX_OPS} ops`)
      history.length = cursor            // adding after undo discards the redo tail
      history.push(clean)
      cursor = history.length
      return doc
    },

    /** The ops the evaluator should render — everything up to the cursor. */
    activeOps: () => history.slice(0, cursor).map((o) => ({ ...o, params: JSON.parse(JSON.stringify(o.params)) })),
    opCount: () => cursor,

    canUndo: () => cursor > 0,
    canRedo: () => cursor < history.length,
    undo () { if (cursor > 0) cursor -= 1; return doc },
    redo () { if (cursor < history.length) cursor += 1; return doc },

    /**
     * Serialize the ACTIVE slice. An undone tail is working state, not part
     * of the document — a draft saved mid-undo must reopen exactly as it
     * looked, and must not resurrect ops the user backed out of.
     */
    toJSON: () => ({
      kind: OPDOC_KIND,
      v: OPDOC_VERSION,
      source: { ...src },
      assets: assetList.map((a) => ({ ...a })),
      ops: history.slice(0, cursor)
    }),
    serialize: () => stableStringify(doc.toJSON())
  }

  for (const a of assets) doc.addAsset(a)
  for (const o of ops) doc.addOp(o)
  return doc
}

/**
 * Parse a serialized document back into a live one.
 *
 * Strict by design: wrong kind, unknown version, oversize payload, bad op
 * shape — each is a thrown Error with a stable message prefix ('opdoc:'), and
 * the drafts layer treats any throw as a corrupt record (skipped, surfaced,
 * never crashing the open). A version-2 document from some future build is
 * REFUSED rather than half-rendered; forward migration belongs to the future
 * version that defines it (documented in adr/014d §evolution).
 */
export function parseEditDoc (json) {
  const text = typeof json === 'string' ? json : stableStringify(json)
  if (text.length > MAX_DOC_CHARS) throw new RangeError('opdoc: document too large')
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('opdoc: not JSON')
  }
  if (!raw || typeof raw !== 'object') throw new Error('opdoc: not an object')
  if (raw.kind !== OPDOC_KIND) throw new Error('opdoc: wrong kind')
  if (raw.v !== OPDOC_VERSION) throw new Error(`opdoc: unsupported version ${raw.v}`)
  if (!Array.isArray(raw.ops) || raw.ops.length > MAX_OPS) throw new Error('opdoc: bad ops list')
  if (raw.assets !== undefined && (!Array.isArray(raw.assets) || raw.assets.length > MAX_ASSETS)) {
    throw new Error('opdoc: bad assets list')
  }
  return createEditDoc({ source: raw.source, assets: raw.assets || [], ops: raw.ops })
}
