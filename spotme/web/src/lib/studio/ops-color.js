/**
 * Spot Me — Creative Studio color adjustment ops.
 *
 * Each op wraps a kernel from kernels.js over bytes (CPU path) and, where the
 * math is per-pixel, transcribes the same arithmetic to GLSL for the preview
 * runtime. Curves is CPU-only ON PURPOSE: its LUT would need either 768
 * uniform floats (over the guaranteed ES3 fragment budget) or an auxiliary
 * LUT texture the deliberately-small GL runtime does not carry; the evaluator
 * falls back per-op, so a chain with curves still previews every other op on
 * the GPU. The honest path report makes that visible.
 */

import { registerOp } from './evaluator.js'
import {
  kExposure, kContrast, kSaturation, kTemperature, kHighlightsShadows,
  buildCurveLUT, LUMA_R, LUMA_G, LUMA_B
} from './kernels.js'

/** Validate one number in [lo, hi]; identity-defaulted sliders pass 0. */
export function num (value, name, lo, hi, dflt = 0) {
  const v = value === undefined ? dflt : value
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${name} must be a number`)
  if (v < lo || v > hi) throw new RangeError(`${name} must be in [${lo}, ${hi}]`)
  return v
}

/** Run a float kernel over every pixel's bytes. Alpha passes through. */
function mapKernel (img, params, kernel) {
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.length) }
  const s = img.data
  const d = out.data
  for (let i = 0; i < s.length; i += 4) {
    const [r, g, b] = kernel(s[i] / 255, s[i + 1] / 255, s[i + 2] / 255, params)
    d[i] = r * 255
    d[i + 1] = g * 255
    d[i + 2] = b * 255
    d[i + 3] = s[i + 3]
  }
  return out
}

registerOp({
  name: 'exposure',
  version: 1,
  validate: (p) => ({ ev: num(p.ev, 'exposure.ev', -3, 3) }),
  cpu: (img, p) => mapKernel(img, p, kExposure),
  glsl: {
    frag: `uniform float u_ev;
void main () {
  vec4 c = texture(u_src, v_uv);
  outColor = vec4(clamp(c.rgb * exp2(u_ev), 0.0, 1.0), c.a);
}`,
    uniforms: (p) => ({ u_ev: p.ev })
  }
})

registerOp({
  name: 'contrast',
  version: 1,
  validate: (p) => ({ amount: num(p.amount, 'contrast.amount', -1, 1) }),
  cpu: (img, p) => mapKernel(img, p, kContrast),
  glsl: {
    frag: `uniform float u_amount;
void main () {
  vec4 c = texture(u_src, v_uv);
  float f = 1.0 + u_amount;
  outColor = vec4(clamp((c.rgb - 0.5) * f + 0.5, 0.0, 1.0), c.a);
}`,
    uniforms: (p) => ({ u_amount: p.amount })
  }
})

registerOp({
  name: 'saturation',
  version: 1,
  validate: (p) => ({ amount: num(p.amount, 'saturation.amount', -1, 1) }),
  cpu: (img, p) => mapKernel(img, p, kSaturation),
  glsl: {
    frag: `uniform float u_amount;
void main () {
  vec4 c = texture(u_src, v_uv);
  float y = dot(c.rgb, vec3(${LUMA_R}, ${LUMA_G}, ${LUMA_B}));
  outColor = vec4(clamp(y + (c.rgb - y) * (1.0 + u_amount), 0.0, 1.0), c.a);
}`,
    uniforms: (p) => ({ u_amount: p.amount })
  }
})

registerOp({
  name: 'temperature',
  version: 1,
  validate: (p) => ({
    temp: num(p.temp, 'temperature.temp', -1, 1),
    tint: num(p.tint, 'temperature.tint', -1, 1)
  }),
  cpu: (img, p) => mapKernel(img, p, kTemperature),
  glsl: {
    frag: `uniform float u_temp;
uniform float u_tint;
void main () {
  vec4 c = texture(u_src, v_uv);
  vec3 g = vec3(1.0 + 0.25 * u_temp + 0.05 * u_tint,
                1.0 - 0.10 * u_tint,
                1.0 - 0.25 * u_temp + 0.05 * u_tint);
  outColor = vec4(clamp(c.rgb * g, 0.0, 1.0), c.a);
}`,
    uniforms: (p) => ({ u_temp: p.temp, u_tint: p.tint })
  }
})

registerOp({
  name: 'highlights_shadows',
  version: 1,
  validate: (p) => ({
    highlights: num(p.highlights, 'highlights_shadows.highlights', -1, 1),
    shadows: num(p.shadows, 'highlights_shadows.shadows', -1, 1)
  }),
  cpu: (img, p) => mapKernel(img, p, kHighlightsShadows),
  glsl: {
    frag: `uniform float u_hi;
uniform float u_sh;
void main () {
  vec4 c = texture(u_src, v_uv);
  float y = dot(c.rgb, vec3(${LUMA_R}, ${LUMA_G}, ${LUMA_B}));
  float fs = 1.0 + u_sh * 0.7 * (1.0 - y) * (1.0 - y);
  float fh = 1.0 + u_hi * 0.7 * y * y;
  outColor = vec4(clamp(c.rgb * fs * fh, 0.0, 1.0), c.a);
}`,
    uniforms: (p) => ({ u_hi: p.highlights, u_sh: p.shadows })
  }
})

/* ------------------------------------------------------------------ curves */

function validCurvePoints (points, name) {
  if (points === undefined) return null
  if (!Array.isArray(points)) throw new TypeError(`${name} must be an array of [x,y] points`)
  const clean = points.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 2) throw new TypeError(`${name}[${i}] must be [x,y]`)
    return [num(p[0], `${name}[${i}].x`, 0, 1), num(p[1], `${name}[${i}].y`, 0, 1)]
  })
  buildCurveLUT(clean)               // throws on non-monotone x / wrong count
  return clean
}

registerOp({
  name: 'curves',
  version: 1,
  /** master applies to all channels after the per-channel curves. Channels
   *  are optional; identity when absent. */
  validate: (p) => {
    const out = {
      master: validCurvePoints(p.master, 'curves.master'),
      r: validCurvePoints(p.r, 'curves.r'),
      g: validCurvePoints(p.g, 'curves.g'),
      b: validCurvePoints(p.b, 'curves.b')
    }
    if (!out.master && !out.r && !out.g && !out.b) {
      throw new RangeError('curves: at least one of master/r/g/b required')
    }
    return out
  },
  cpu: (img, p) => {
    // Bake channel + master into one 256→byte LUT per channel: exact and O(1)
    // per pixel. LUT-backed is the requirement; this is the LUT.
    const master = p.master ? buildCurveLUT(p.master) : null
    const build = (pts) => {
      const chan = pts ? buildCurveLUT(pts) : null
      const lut = new Uint8ClampedArray(256)
      for (let i = 0; i < 256; i++) {
        let v = i / 255
        if (chan) v = chan[Math.round(v * 255)]
        if (master) v = master[Math.round(v * 255)]
        lut[i] = v * 255
      }
      return lut
    }
    const lr = build(p.r)
    const lg = build(p.g)
    const lb = build(p.b)
    const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.length) }
    const s = img.data
    const d = out.data
    for (let i = 0; i < s.length; i += 4) {
      d[i] = lr[s[i]]
      d[i + 1] = lg[s[i + 1]]
      d[i + 2] = lb[s[i + 2]]
      d[i + 3] = s[i + 3]
    }
    return out
  }
})
