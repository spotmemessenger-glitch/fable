/**
 * Spot Me camera — the processing pipeline: the seam AR/beauty (mission 3)
 * plugs into later.
 *
 * CONTRACT. A pipeline is an ORDERED list of PURE stages applied to each
 * frame. A stage is:
 *
 *   {
 *     name:  unique string
 *     cpu:   (image, params) → image     — pure: never mutates its input
 *     glsl:  { fragment, uniforms(params) → {name: value} }   — optional
 *     params: default parameter object (overridable per apply)
 *   }
 *
 * Zero stages = passthrough: apply() returns its input UNTOUCHED, same
 * object, so an empty pipeline costs nothing and proves nothing was copied.
 *
 * TWO EXECUTORS, ONE SEMANTICS. The CPU executor below runs everywhere
 * (including Node, which is how the golden-vector tests pin stage math);
 * the WebGL2 executor (pipeline-gl.js) runs the same stages as fragment
 * passes where a context exists. Which one is active is REPORTED
 * (`mode()`), never guessed at: a GL-only stage added while in CPU mode is
 * REFUSED with NO_WEBGL2 — a silently skipped beauty filter is a lie in
 * the mirror.
 *
 * CPU image format: `{ data: Uint8ClampedArray, width, height }` — RGBA,
 * exactly ImageData's shape, so real ImageData objects pass straight in.
 */

import { CAMERA_UNAVAILABLE, available, unavailable } from './availability.js'
import { probeWebGL2 } from './capabilities.js'
import { createGlExecutor } from './pipeline-gl.js'

export function validateStage (stage) {
  if (!stage || typeof stage !== 'object') return 'stage must be an object'
  if (typeof stage.name !== 'string' || !stage.name) return 'stage.name required'
  const hasCpu = typeof stage.cpu === 'function'
  const hasGl = stage.glsl && typeof stage.glsl.fragment === 'string'
  if (!hasCpu && !hasGl) return 'stage needs cpu() and/or glsl.fragment'
  if (hasGl && typeof stage.glsl.uniforms !== 'function') return 'glsl stage needs uniforms(params)'
  return null
}

/** Deep-frozen copy of the stage list order — the inspection surface. */
function describe (stages, mode) {
  return Object.freeze({
    mode,
    stages: Object.freeze(stages.map((s) => Object.freeze({
      name: s.name,
      cpu: typeof s.cpu === 'function',
      glsl: Boolean(s.glsl),
    }))),
  })
}

/**
 * @param opts.canvas  a canvas (or OffscreenCanvas) to probe/run WebGL2 on.
 *                     Omitted → CPU mode. The engine passes one only in the
 *                     future wiring PR; headless callers run CPU.
 */
export function createPipeline ({ env = globalThis, canvas = null } = {}) {
  const stages = []
  let gl = null
  let mode = 'cpu'
  if (canvas) {
    const probe = probeWebGL2(env, canvas)
    if (probe.available) {
      try {
        gl = createGlExecutor(canvas, env)
        mode = 'webgl2'
      } catch { gl = null; mode = 'cpu' }
    }
  }

  const pipeline = {
    mode: () => mode,
    describe: () => describe(stages, mode),
    stageCount: () => stages.length,

    addStage (stage, index = stages.length) {
      const problem = validateStage(stage)
      if (problem) return unavailable(CAMERA_UNAVAILABLE.FAILED, problem)
      if (stages.some((s) => s.name === stage.name)) {
        return unavailable(CAMERA_UNAVAILABLE.FAILED, `duplicate stage name: ${stage.name}`)
      }
      if (mode === 'cpu' && typeof stage.cpu !== 'function') {
        return unavailable(CAMERA_UNAVAILABLE.NO_WEBGL2,
          `stage ${stage.name} is GL-only and this pipeline runs on CPU — refusing to silently skip it`)
      }
      if (mode === 'webgl2' && stage.glsl) {
        const compiled = gl.compileStage(stage)
        if (!compiled.available) return compiled
      }
      stages.splice(Math.max(0, Math.min(index, stages.length)), 0, stage)
      return available({ index: stages.indexOf(stage) })
    },

    removeStage (name) {
      const i = stages.findIndex((s) => s.name === name)
      if (i === -1) return unavailable(CAMERA_UNAVAILABLE.FAILED, `no stage named ${name}`)
      const [removed] = stages.splice(i, 1)
      if (mode === 'webgl2') gl.releaseStage(removed)
      return available({})
    },

    /**
     * Run every stage in order on one frame (CPU semantics; the GL path
     * draws — see runGl). `overrides` maps stage name → params for this
     * frame only. Returns `{image, stageCosts}` so per-stage cost lands in
     * the metrics snapshot instead of a guess.
     */
    apply (image, overrides = {}, clock = null) {
      if (stages.length === 0) return { image, stageCosts: [] }
      let current = image
      const stageCosts = []
      for (const stage of stages) {
        const params = { ...stage.params, ...overrides[stage.name] }
        const t0 = clock ? clock.now() : 0
        current = stage.cpu(current, params)
        stageCosts.push({ name: stage.name, ms: clock ? clock.now() - t0 : null })
      }
      return { image: current, stageCosts }
    },

    /** GL path: draw `source` through every compiled pass to the canvas.
     *  Only callable in webgl2 mode — the caller checks mode(), and this
     *  refuses rather than pretending. */
    runGl (source, overrides = {}) {
      if (mode !== 'webgl2') return unavailable(CAMERA_UNAVAILABLE.NO_WEBGL2, 'pipeline is in CPU mode')
      return gl.run(source, stages, overrides)
    },

    dispose () {
      if (mode === 'webgl2') gl.dispose()
      stages.length = 0
    },
  }
  return pipeline
}

/** Pure helper both executors share: clamp a float to a byte. */
export function clamp255 (v) {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

/** A fresh image of the same geometry — the stage author's copy tool. */
export function cloneImage (image) {
  return { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height }
}
