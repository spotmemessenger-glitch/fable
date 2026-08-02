/**
 * Spot Me camera — the two REFERENCE pipeline stages.
 *
 * These exist as PROOF the stage contract carries real image work — one
 * arithmetic stage (exposure gain) and one lookup stage (1D LUT) — with
 * bit-identical CPU math and a GLSL twin of each. They are deliberately the
 * only stages this mission ships: beauty/AR stages are mission 3's to add
 * against this contract, not this module's to preempt.
 *
 * Both CPU implementations are PURE (fresh output buffer, input untouched)
 * and golden-vector tested in test/camera-pipeline.test.js.
 */

import { clamp255 } from './pipeline.js'

/**
 * Exposure gain: out = in × 2^EV per RGB channel, alpha untouched.
 * EV units because that is how photographers and the HDR bracket both
 * think; gain 2^0 = identity.
 */
export function exposureGainStage (ev = 0) {
  return {
    name: 'exposure-gain',
    params: { ev },
    cpu (image, params) {
      const gain = Math.pow(2, params.ev)
      const out = new Uint8ClampedArray(image.data.length)
      const src = image.data
      for (let i = 0; i < src.length; i += 4) {
        out[i] = clamp255(src[i] * gain)
        out[i + 1] = clamp255(src[i + 1] * gain)
        out[i + 2] = clamp255(src[i + 2] * gain)
        out[i + 3] = src[i + 3]
      }
      return { data: out, width: image.width, height: image.height }
    },
    glsl: {
      fragment: `#version 300 es
precision highp float;
uniform sampler2D u_frame;
uniform float u_gain;
in vec2 v_uv;
out vec4 outColor;
void main () {
  vec4 c = texture(u_frame, v_uv);
  outColor = vec4(clamp(c.rgb * u_gain, 0.0, 1.0), c.a);
}`,
      uniforms: (params) => ({ u_gain: Math.pow(2, params.ev) }),
    },
  }
}

/**
 * 1D LUT apply: out[c] = lut[c][in[c]] for RGB. `lut` is 256 entries per
 * channel; identity when omitted. This is the shape film-look presets,
 * gamma curves and tone maps all reduce to.
 */
export function lutStage (lut = identityLut()) {
  if (!lut || lut.r?.length !== 256 || lut.g?.length !== 256 || lut.b?.length !== 256) {
    throw new Error('lutStage needs {r,g,b} of 256 entries each')
  }
  return {
    name: 'lut',
    params: { lut },
    cpu (image, params) {
      const { r, g, b } = params.lut
      const out = new Uint8ClampedArray(image.data.length)
      const src = image.data
      for (let i = 0; i < src.length; i += 4) {
        out[i] = r[src[i]]
        out[i + 1] = g[src[i + 1]]
        out[i + 2] = b[src[i + 2]]
        out[i + 3] = src[i + 3]
      }
      return { data: out, width: image.width, height: image.height }
    },
    glsl: {
      fragment: `#version 300 es
precision highp float;
uniform sampler2D u_frame;
uniform sampler2D u_lut;                 // 256×1 RGBA: r,g,b curves packed
in vec2 v_uv;
out vec4 outColor;
void main () {
  vec4 c = texture(u_frame, v_uv);
  float r = texture(u_lut, vec2((c.r * 255.0 + 0.5) / 256.0, 0.5)).r;
  float g = texture(u_lut, vec2((c.g * 255.0 + 0.5) / 256.0, 0.5)).g;
  float b = texture(u_lut, vec2((c.b * 255.0 + 0.5) / 256.0, 0.5)).b;
  outColor = vec4(r, g, b, c.a);
}`,
      uniforms: (params) => ({ u_lut: packLutTexture(params.lut) }),
    },
  }
}

export function identityLut () {
  const ramp = new Uint8Array(256)
  for (let i = 0; i < 256; i++) ramp[i] = i
  return { r: ramp, g: new Uint8Array(ramp), b: new Uint8Array(ramp) }
}

/** A gamma curve as a LUT — the working example of a non-identity look. */
export function gammaLut (gamma) {
  const curve = new Uint8Array(256)
  for (let i = 0; i < 256; i++) curve[i] = Math.round(255 * Math.pow(i / 255, gamma))
  return { r: curve, g: new Uint8Array(curve), b: new Uint8Array(curve) }
}

/** {r,g,b} curves → one 256×1 RGBA texture payload for the GL twin. */
export function packLutTexture (lut) {
  const packed = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    packed[i * 4] = lut.r[i]
    packed[i * 4 + 1] = lut.g[i]
    packed[i * 4 + 2] = lut.b[i]
    packed[i * 4 + 3] = 255
  }
  return packed
}
