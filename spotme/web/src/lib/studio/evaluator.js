/**
 * Spot Me — Creative Studio evaluator: renders an edit document.
 *
 * The registry maps op names to implementations. Every op MUST provide a CPU
 * implementation over plain pixels ({width,height,data}) — that is the path
 * Node tests, tiled full-resolution exports and no-WebGL devices run. An op
 * MAY additionally provide a GLSL fragment shader; the GL runtime (gl-eval.js)
 * uses it for interactive preview, falling back PER OP to the CPU twin when
 * compilation or the context fails. The render result names which path each
 * op actually took, so "it used the GPU" is an observable fact, never a hope.
 *
 * DETERMINISM POLICY. The CPU path is byte-deterministic: same source, same
 * ops, same output, every device, every time — that is what makes golden
 * tests and draft re-rendering trustworthy. GPU output is float math on
 * whoever's driver, correct within tolerance but not bit-stable across
 * devices, so EXPORT renders on the CPU path unless a caller explicitly opts
 * into `allowGpuExport` (the tolerance the GL twin is held to is pinned by
 * studio-ops.test.js). Preview freely uses the GPU.
 */

import { isImage, cloneImage, planTiles, cropRect, blitRect } from './image-io.js'

/* --------------------------------------------------------------- registry */

const registry = new Map()

/**
 * Register one op implementation.
 *   name/version   must match the op-doc entries they evaluate
 *   validate       (params) → normalized params; throws on bad input
 *   cpu            (img, params, ctx) → NEW image (never mutate the input)
 *   glsl           optional { frag, uniforms(params, ctx) } preview shader
 *   pad            optional (params, ctx) → px of neighborhood a tile needs
 *   geometry       true when output dimensions differ from input (CPU only)
 */
export function registerOp (def) {
  const { name, version, validate, cpu } = def || {}
  if (typeof name !== 'string' || !name) throw new TypeError('registerOp: name required')
  if (!Number.isInteger(version) || version < 1) throw new TypeError(`registerOp ${name}: bad version`)
  if (typeof validate !== 'function' || typeof cpu !== 'function') {
    throw new TypeError(`registerOp ${name}: validate and cpu are mandatory`)
  }
  if (registry.has(name)) throw new Error(`registerOp: duplicate op ${name}`)
  registry.set(name, Object.freeze({ pad: null, glsl: null, geometry: false, ...def }))
}

export const getOp = (name) => registry.get(name) || null
export const listOps = () => [...registry.keys()].sort()

/** Validate one op-doc entry against the registry. Returns normalized params. */
export function validateOp (entry) {
  const def = registry.get(entry?.op)
  if (!def) throw new Error(`unknown op: ${String(entry?.op)}`)
  if (entry.v !== def.version) {
    // v1 is the only version of every op today; a future v2 op adds an
    // explicit migration in its own module rather than a silent best-effort.
    throw new Error(`op ${entry.op}: document has v${entry.v}, this build evaluates v${def.version}`)
  }
  return def.validate(entry.params ?? {})
}

/* -------------------------------------------------------------- evaluator */

/** Pixel budget one full-resolution CPU pass may hold per tile. */
const TILE_PIXELS = 4_000_000

export function createEvaluator ({ glRuntime = null } = {}) {
  /**
   * Render `ops` over `source`.
   *
   * opts:
   *   assets     Map<id, image> — decoded secondary inputs (backgrounds…)
   *   scale      source-pixels → rendered-pixels factor (preview downscale);
   *              ops with pixel-radius params multiply by it
   *   quality    'preview' (GL allowed) | 'export' (CPU unless allowGpuExport)
   *   allowGpuExport  opt into GPU floats for export renders
   *   tiled      force the tiling path (exports of very large images)
   *
   * → { image, paths: [{ op, path: 'gpu'|'cpu' }] }
   */
  function render (source, ops, opts = {}) {
    if (!isImage(source)) throw new TypeError('render: source is not an image')
    const { assets = new Map(), scale = 1, quality = 'preview', allowGpuExport = false, tiled = false } = opts
    if (!Array.isArray(ops)) throw new TypeError('render: ops must be an array')
    const ctx = { assets, scale }

    // Validate the WHOLE document before touching a pixel: a doc that fails
    // at op 7 must not return a half-rendered image as if it were the edit.
    const plan = ops.map((entry) => {
      const def = registry.get(entry?.op)
      const params = validateOp(entry)
      return { def, params, name: entry.op }
    })

    const gpuAllowed = Boolean(glRuntime) && (quality === 'preview' || allowGpuExport)
    const paths = []
    let img = source

    for (const step of plan) {
      const { def, params, name } = step
      let out = null
      if (gpuAllowed && def.glsl && !def.geometry) {
        out = glRuntime.run(def, img, params, ctx)     // null on any GL failure
      }
      if (out) {
        paths.push({ op: name, path: 'gpu' })
      } else {
        out = runCpu(def, img, params, ctx, tiled)
        paths.push({ op: name, path: 'cpu' })
      }
      img = out
    }

    return { image: img === source ? cloneImage(source) : img, paths }
  }

  return { render }
}

/**
 * CPU execution, tiling when the image exceeds the per-pass budget and the
 * op is tileable. Geometry ops and ops with unbounded support (inpaint reads
 * the whole neighborhood ring) declare themselves untileable by omitting
 * `pad` semantics — they run whole-image (their own implementations bound
 * memory internally).
 */
function runCpu (def, img, params, ctx, tiled) {
  const big = img.width * img.height > TILE_PIXELS
  const tileable = !def.geometry && def.tileable !== false
  if ((tiled || big) && tileable) {
    const pad = def.pad ? Math.ceil(def.pad(params, ctx)) : 0
    const tiles = planTiles(img.width, img.height, { maxPixels: TILE_PIXELS, overlap: pad })
    if (tiles.length > 1) {
      const out = cloneImage(img)
      for (const t of tiles) {
        const padded = cropRect(img, t.src)
        const rendered = def.cpu(padded, params, ctx)
        if (rendered.width !== padded.width || rendered.height !== padded.height) {
          throw new Error(`op ${def.name}: tileable op changed dimensions`)
        }
        const inner = cropRect(rendered, {
          x: t.rect.x - t.src.x,
          y: t.rect.y - t.src.y,
          w: t.rect.w,
          h: t.rect.h
        })
        blitRect(out, inner, t.rect.x, t.rect.y)
      }
      return out
    }
  }
  return def.cpu(img, params, ctx)
}

/* ------------------------------------------------------------ test seam */

/** Reset the registry — ONLY for tests that register throwaway ops. */
export function _resetRegistryForTests () { registry.clear() }
