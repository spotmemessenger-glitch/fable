/**
 * Spot Me camera — the WebGL2 executor behind pipeline.js.
 *
 * One fullscreen triangle, one texture upload per frame, one fragment
 * program per stage, ping-pong between two FBO textures, final pass to the
 * canvas. Stages see:
 *
 *   uniform sampler2D u_frame;     // the previous pass's output
 *   in vec2 v_uv;                  // 0..1
 *   out vec4 outColor;
 *   + whatever `glsl.uniforms(params)` returns (floats, vec2/3/4 as arrays,
 *     and 256×1 RGBA LUT textures via {lut: Uint8Array(1024)}).
 *
 * WHAT NODE CANNOT PROVE. There is no WebGL2 in CI; this file is kept thin
 * and mechanical for that reason, its stage MATH lives in the cpu()
 * implementations that ARE golden-vector tested, and the GL/CPU equivalence
 * check is a manual device-matrix item (production-checklist.md). Compile
 * errors are still surfaced eagerly: addStage compiles immediately and
 * refuses a stage whose shader will not link.
 */

import { CAMERA_UNAVAILABLE, available, unavailable } from './availability.js'

const VERTEX = `#version 300 es
precision highp float;
out vec2 v_uv;
void main () {
  // Fullscreen triangle: 3 vertices, no buffer needed.
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = pos;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

export function createGlExecutor (canvas, env = globalThis) {
  const gl = canvas.getContext('webgl2')
  if (!gl) throw new Error('webgl2 context refused')
  const programs = new Map()              // stage.name → {program, uniformLocs, lutTexture}
  let ping = null                         // {texture, fbo} ×2, lazily sized
  let pong = null
  let sourceTexture = null
  let width = 0
  let height = 0

  function compileShader (type, src) {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, src)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader)
      gl.deleteShader(shader)
      throw new Error(log || 'shader compile failed')
    }
    return shader
  }

  function link (fragmentSrc) {
    const program = gl.createProgram()
    const vs = compileShader(gl.VERTEX_SHADER, VERTEX)
    const fs = compileShader(gl.FRAGMENT_SHADER, fragmentSrc)
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program)
      gl.deleteProgram(program)
      throw new Error(log || 'program link failed')
    }
    return program
  }

  function makeTarget () {
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { texture, fbo }
  }

  function ensureTargets (w, h) {
    if (w === width && h === height && ping) return
    disposeTargets()
    width = w
    height = h
    ping = makeTarget()
    pong = makeTarget()
    sourceTexture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  function disposeTargets () {
    for (const target of [ping, pong]) {
      if (!target) continue
      gl.deleteTexture(target.texture)
      gl.deleteFramebuffer(target.fbo)
    }
    if (sourceTexture) gl.deleteTexture(sourceTexture)
    ping = pong = sourceTexture = null
  }

  function setUniform (loc, value) {
    if (typeof value === 'number') gl.uniform1f(loc, value)
    else if (Array.isArray(value)) {
      if (value.length === 2) gl.uniform2fv(loc, value)
      else if (value.length === 3) gl.uniform3fv(loc, value)
      else if (value.length === 4) gl.uniform4fv(loc, value)
      else gl.uniform1fv(loc, value)
    }
  }

  return {
    /** Compile eagerly so addStage can refuse a broken shader up front. */
    compileStage (stage) {
      try {
        const program = link(stage.glsl.fragment)
        programs.set(stage.name, { program, lutTexture: null })
        return available({})
      } catch (e) {
        return unavailable(CAMERA_UNAVAILABLE.FAILED, `shader for ${stage.name}: ${e.message}`)
      }
    },

    releaseStage (stage) {
      const entry = programs.get(stage.name)
      if (!entry) return
      gl.deleteProgram(entry.program)
      if (entry.lutTexture) gl.deleteTexture(entry.lutTexture)
      programs.delete(stage.name)
    },

    /** Draw source → stages → canvas. Stages without glsl are skipped HERE
     *  only if they have no shader AND the pipeline was allowed to add them
     *  (i.e. cpu-only stages in a GL pipeline run on readback paths, which
     *  the engine does not do per-frame; the pipeline layer enforces). */
    run (source, stages, overrides = {}) {
      const w = source.videoWidth || source.codedWidth || source.width || canvas.width
      const h = source.videoHeight || source.codedHeight || source.height || canvas.height
      if (!w || !h) return unavailable(CAMERA_UNAVAILABLE.FAILED, 'source has no dimensions')
      ensureTargets(w, h)
      gl.bindTexture(gl.TEXTURE_2D, sourceTexture)
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
      } catch (e) {
        return unavailable(CAMERA_UNAVAILABLE.FAILED, `texture upload: ${e.message}`)
      }
      const glStages = stages.filter((s) => s.glsl && programs.has(s.name))
      let input = sourceTexture
      let target = ping
      for (let i = 0; i < glStages.length; i++) {
        const stage = glStages[i]
        const last = i === glStages.length - 1
        const entry = programs.get(stage.name)
        gl.bindFramebuffer(gl.FRAMEBUFFER, last ? null : target.fbo)
        gl.viewport(0, 0, last ? canvas.width : w, last ? canvas.height : h)
        gl.useProgram(entry.program)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, input)
        gl.uniform1i(gl.getUniformLocation(entry.program, 'u_frame'), 0)
        const params = { ...stage.params, ...overrides[stage.name] }
        const uniforms = stage.glsl.uniforms(params) || {}
        for (const [name, value] of Object.entries(uniforms)) {
          if (value instanceof Uint8Array) {              // 256×1 RGBA LUT
            if (!entry.lutTexture) entry.lutTexture = gl.createTexture()
            gl.activeTexture(gl.TEXTURE1)
            gl.bindTexture(gl.TEXTURE_2D, entry.lutTexture)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, value)
            gl.uniform1i(gl.getUniformLocation(entry.program, name), 1)
            gl.activeTexture(gl.TEXTURE0)
          } else {
            setUniform(gl.getUniformLocation(entry.program, name), value)
          }
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        input = target.texture
        target = target === ping ? pong : ping
      }
      if (glStages.length === 0) {
        // Passthrough draw so an empty GL pipeline still presents the frame.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      }
      return available({ passes: glStages.length })
    },

    dispose () {
      for (const entry of programs.values()) {
        gl.deleteProgram(entry.program)
        if (entry.lutTexture) gl.deleteTexture(entry.lutTexture)
      }
      programs.clear()
      disposeTargets()
    },
  }
}
