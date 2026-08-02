/**
 * Spot Me camera — portrait mode: the ISegmenter seam + the blur consumer.
 *
 * WHAT SHIPS HERE AND WHAT DOES NOT. Portrait = a person/background MASK
 * from a segmentation ENGINE, plus a blur that consumes the mask. The blur
 * is real and tested below. The engine is deliberately ABSENT: producing a
 * mask needs either an ML model (MediaPipe selfie-segmentation — a new
 * dependency this repo's zero-dep rule reserves for the OWNER to approve,
 * ADR-014a) or native depth (Capacitor, P10). Shipping a centre-oval
 * "segmenter" so demos look busy is exactly the kind of fake this platform
 * refuses: with no engine registered, portrait reports
 * UNAVAILABLE(NO_SEGMENTER_REGISTERED) and stays a button that does not
 * exist.
 *
 * ISegmenter — the adapter contract both future engines implement:
 *
 *   {
 *     name:    'mediapipe-selfie' | 'native-depth' | …
 *     kind:    'ml' | 'depth'
 *     segment: async (image {data,width,height}) →
 *                { mask: { data: Float32Array 0..1, width, height } }
 *              1 = person (keep sharp), 0 = background (blur).
 *              Mask geometry MAY be smaller than the image; the consumer
 *              upsamples (models run at 256×256-ish).
 *     release?: () => void
 *   }
 */

import { CAMERA_UNAVAILABLE, available, unavailable } from './availability.js'
import { boxBlurImage, boxBlurPlane } from './imagemath.js'

export function validateSegmenter (segmenter) {
  if (!segmenter || typeof segmenter !== 'object') return 'segmenter must be an object'
  if (typeof segmenter.name !== 'string' || !segmenter.name) return 'segmenter.name required'
  if (segmenter.kind !== 'ml' && segmenter.kind !== 'depth') return 'segmenter.kind must be "ml" or "depth"'
  if (typeof segmenter.segment !== 'function') return 'segmenter.segment(image) required'
  return null
}

/** The registry one engine instance owns. No module-level state: two
 *  engines (or a test and the app) can never fight over a global. */
export function createSegmenterRegistry () {
  let current = null
  return {
    register (segmenter) {
      const problem = validateSegmenter(segmenter)
      if (problem) return unavailable(CAMERA_UNAVAILABLE.FAILED, problem)
      current = segmenter
      return available({ engine: segmenter.name, kind: segmenter.kind })
    },
    unregister () {
      const had = current
      current = null
      try { had?.release?.() } catch { /* the engine's problem */ }
      return available({ released: Boolean(had) })
    },
    availability () {
      return current
        ? available({ engine: current.name, kind: current.kind })
        : unavailable(CAMERA_UNAVAILABLE.NO_SEGMENTER_REGISTERED,
          'register an ISegmenter: MediaPipe selfie-segmentation (owner dep decision) or native depth (P10)')
    },
    current: () => current,
  }
}

/** Nearest-neighbour mask upsample to image geometry — models emit small
 *  masks; feathering afterwards hides the blocks. */
export function resizeMask (mask, width, height) {
  if (mask.width === width && mask.height === height) return mask
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const sy = Math.min(mask.height - 1, Math.floor(y * mask.height / height))
    for (let x = 0; x < width; x++) {
      const sx = Math.min(mask.width - 1, Math.floor(x * mask.width / width))
      out[y * width + x] = mask.data[sy * mask.width + sx]
    }
  }
  return { data: out, width, height }
}

/**
 * The blur consumer: sharp foreground, blurred background, blended by the
 * (feathered) mask. Pure — golden-tested in Node with synthetic masks.
 *
 * @param opts.blurRadius   background box-blur radius (default 6)
 * @param opts.passes       blur passes; 3 ≈ Gaussian (default 3)
 * @param opts.feather      mask feather radius, softens the cutout edge
 */
export function applyPortrait (image, mask, { blurRadius = 6, passes = 3, feather = 2 } = {}) {
  if (!mask || !(mask.data instanceof Float32Array)) {
    return unavailable(CAMERA_UNAVAILABLE.FAILED, 'mask must be a Float32Array plane')
  }
  const sized = resizeMask(mask, image.width, image.height)
  const soft = feather > 0 ? boxBlurPlane(sized, feather) : sized
  const blurred = boxBlurImage(image, blurRadius, passes)
  const out = new Uint8ClampedArray(image.data.length)
  const sharp = image.data
  for (let p = 0, i = 0; p < soft.data.length; p++, i += 4) {
    const keep = Math.min(1, Math.max(0, soft.data[p]))
    out[i] = keep * sharp[i] + (1 - keep) * blurred.data[i]
    out[i + 1] = keep * sharp[i + 1] + (1 - keep) * blurred.data[i + 1]
    out[i + 2] = keep * sharp[i + 2] + (1 - keep) * blurred.data[i + 2]
    out[i + 3] = sharp[i + 3]
  }
  return available({ image: { data: out, width: image.width, height: image.height } })
}

/**
 * Segment-then-blur: the whole portrait still path over whatever engine is
 * registered. No engine → the honest refusal; an engine that returns a
 * malformed mask → FAILED with the defect named (a bad model must not
 * crash capture).
 */
export async function renderPortrait (registry, image, opts = {}) {
  const engine = registry.current()
  if (!engine) return registry.availability()
  let result
  try {
    result = await engine.segment(image)
  } catch (e) {
    return unavailable(CAMERA_UNAVAILABLE.FAILED, `segmenter ${engine.name}: ${e?.message || e}`)
  }
  const mask = result?.mask
  if (!mask || !(mask.data instanceof Float32Array) || mask.data.length !== mask.width * mask.height) {
    return unavailable(CAMERA_UNAVAILABLE.FAILED, `segmenter ${engine.name} returned a malformed mask`)
  }
  const rendered = applyPortrait(image, mask, opts)
  if (!rendered.available) return rendered
  return available({ image: rendered.image, engine: engine.name, kind: engine.kind })
}

/**
 * The GL preview twin: a single-pass masked box blur for the pipeline's
 * WebGL2 executor. The mask arrives as a texture the wiring provides per
 * frame (mission 3's live path). CPU/GL equivalence is a device-matrix
 * item; the CPU consumer above is the tested reference semantics.
 */
export function portraitBlurStageGl () {
  return {
    name: 'portrait-blur',
    params: { radiusPx: 6 },
    glsl: {
      fragment: `#version 300 es
precision highp float;
uniform sampler2D u_frame;
uniform sampler2D u_mask;                 // R channel: 1 keep, 0 blur
uniform float u_radius;                   // in texels
in vec2 v_uv;
out vec4 outColor;
void main () {
  vec2 texel = 1.0 / vec2(textureSize(u_frame, 0));
  float keep = texture(u_mask, v_uv).r;
  vec4 sharp = texture(u_frame, v_uv);
  vec4 sum = vec4(0.0);
  for (int dy = -3; dy <= 3; dy++) {
    for (int dx = -3; dx <= 3; dx++) {
      sum += texture(u_frame, v_uv + vec2(float(dx), float(dy)) * texel * (u_radius / 3.0));
    }
  }
  vec4 blurred = sum / 49.0;
  outColor = vec4(mix(blurred.rgb, sharp.rgb, clamp(keep, 0.0, 1.0)), sharp.a);
}`,
      uniforms: (params) => ({ u_radius: params.radiusPx }),
    },
  }
}
