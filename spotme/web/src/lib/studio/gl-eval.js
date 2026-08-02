/**
 * Spot Me — Creative Studio WebGL2 runtime (preview acceleration).
 *
 * One fullscreen-triangle pipeline: upload the working image as a texture,
 * run an op's fragment shader into a framebuffer texture, read back. Chained
 * ops reuse the GPU-resident texture (ping-pong) and read back once at the
 * end of the GPU run — the evaluator calls `run()` per op, and this runtime
 * keeps the previous output resident keyed by identity so a chain of GL ops
 * costs one upload + one readback, not N of each.
 *
 * EVERY failure returns null. Context loss, compile error, oversize texture —
 * the evaluator falls back to the op's CPU twin and records the path taken.
 * A preview accelerator that can take rendering down is worse than none.
 *
 * This file is browser-only by nature; the Node suite exercises the pure
 * parts (shader source assembly, uniform mapping) and the CPU-vs-shader-math
 * agreement through each op's float reference (see kernels.js), which is the
 * same arithmetic these shaders execute.
 */

const VERT = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main () {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

/** Shared fragment prelude every op shader is concatenated onto. */
export const FRAG_PRELUDE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_size;
out vec4 outColor;
`

/** Assemble a complete fragment shader from an op's body. Pure — unit-tested. */
export function assembleFrag (body) {
  if (typeof body !== 'string' || !body.includes('void main')) {
    throw new TypeError('assembleFrag: shader body must define void main')
  }
  return FRAG_PRELUDE + body
}

/**
 * Create the runtime, or null when WebGL2 is genuinely unavailable.
 * `makeCanvas` is injected so tests can hand in fakes and so the module never
 * touches the DOM on import.
 */
export function createGlRuntime ({ makeCanvas } = {}) {
  let canvas = null
  let gl = null
  try {
    canvas = makeCanvas
      ? makeCanvas(2, 2)
      : (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(2, 2) : null)
    gl = canvas?.getContext?.('webgl2', { premultipliedAlpha: false, antialias: false }) || null
  } catch {
    gl = null
  }
  if (!gl) return null

  const programs = new Map()      // op name → {program, locations} | null (failed)
  let quad = null
  const tex = [null, null]        // ping-pong color textures
  let fbo = null
  let texW = 0
  let texH = 0
  /** GPU-resident chain state: which image object the resident texture holds. */
  let residentFor = null
  let residentIx = 0

  function compile (type, src) {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      gl.deleteShader(s)
      return null
    }
    return s
  }

  function programFor (def) {
    if (programs.has(def.name)) return programs.get(def.name)
    let built = null
    try {
      const vs = compile(gl.VERTEX_SHADER, VERT)
      const fs = compile(gl.FRAGMENT_SHADER, assembleFrag(def.glsl.frag))
      if (vs && fs) {
        const p = gl.createProgram()
        gl.attachShader(p, vs)
        gl.attachShader(p, fs)
        gl.linkProgram(p)
        if (gl.getProgramParameter(p, gl.LINK_STATUS)) {
          built = { program: p, loc: new Map() }
        }
        gl.deleteShader(vs)
        gl.deleteShader(fs)
      }
    } catch {
      built = null
    }
    programs.set(def.name, built)   // a failed compile is cached: retrying every frame helps nobody
    return built
  }

  function ensureTargets (w, h) {
    if (texW === w && texH === h && tex[0] && tex[1] && fbo) return true
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE)
    if (w > max || h > max) return false
    for (const i of [0, 1]) {
      if (tex[i]) gl.deleteTexture(tex[i])
      tex[i] = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex[i])
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    }
    if (!fbo) fbo = gl.createFramebuffer()
    canvas.width = w
    canvas.height = h
    texW = w
    texH = h
    residentFor = null
    return true
  }

  function setUniforms (built, uniforms, w, h) {
    for (const [name, value] of Object.entries(uniforms)) {
      let loc = built.loc.get(name)
      if (loc === undefined) {
        loc = gl.getUniformLocation(built.program, name)
        built.loc.set(name, loc)
      }
      if (loc === null) continue
      if (typeof value === 'number') gl.uniform1f(loc, value)
      else if (Array.isArray(value) && value.length === 2) gl.uniform2f(loc, value[0], value[1])
      else if (Array.isArray(value) && value.length === 3) gl.uniform3f(loc, value[0], value[1], value[2])
      else if (Array.isArray(value) && value.length === 4) gl.uniform4f(loc, value[0], value[1], value[2], value[3])
      else if (value instanceof Float32Array) gl.uniform1fv(loc, value)
    }
    let sizeLoc = built.loc.get('u_size')
    if (sizeLoc === undefined) {
      sizeLoc = gl.getUniformLocation(built.program, 'u_size')
      built.loc.set('u_size', sizeLoc)
    }
    if (sizeLoc) gl.uniform2f(sizeLoc, w, h)
  }

  /**
   * Run one op. Returns the output image, or null to make the evaluator fall
   * back to CPU. The input is re-uploaded only when it is not the previous
   * call's output (chain locality).
   */
  function run (def, img, params, ctx) {
    try {
      if (gl.isContextLost?.()) return null
      const built = programFor(def)
      if (!built) return null
      const { width: w, height: h } = img
      if (!ensureTargets(w, h)) return null

      let srcIx
      if (residentFor === img) {
        srcIx = residentIx
      } else {
        srcIx = 0
        gl.bindTexture(gl.TEXTURE_2D, tex[0])
        // Flip so row 0 of our buffers is the TOP row in texture space; the
        // readback below flips back, keeping CPU and GPU row order identical.
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      }
      const dstIx = 1 - srcIx

      if (!quad) {
        quad = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, quad)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex[dstIx], 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null
      gl.viewport(0, 0, w, h)
      gl.useProgram(built.program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, tex[srcIx])
      const srcLoc = gl.getUniformLocation(built.program, 'u_src')
      if (srcLoc) gl.uniform1i(srcLoc, 0)
      setUniforms(built, def.glsl.uniforms(params, ctx) || {}, w, h)
      gl.bindBuffer(gl.ARRAY_BUFFER, quad)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)

      const out = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
      const raw = new Uint8Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw)
      // readPixels returns bottom-up; flip rows back to image order.
      const rowBytes = w * 4
      for (let y = 0; y < h; y++) {
        out.data.set(raw.subarray((h - 1 - y) * rowBytes, (h - y) * rowBytes), y * rowBytes)
      }
      residentFor = out
      residentIx = dstIx
      return out
    } catch {
      return null
    }
  }

  function dispose () {
    try {
      for (const p of programs.values()) if (p) gl.deleteProgram(p.program)
      programs.clear()
      for (const i of [0, 1]) if (tex[i]) gl.deleteTexture(tex[i])
      if (fbo) gl.deleteFramebuffer(fbo)
      if (quad) gl.deleteBuffer(quad)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    } catch { /* disposing a lost context is fine */ }
  }

  return { run, dispose, kind: 'webgl2' }
}
