/**
 * Spot Me — Creative Studio templates: versioned, data-driven presets that
 * expand into the module's real primitives — a story/reel template becomes a
 * composer timeline, a collage template becomes a layout + options. Nothing
 * in a template is code; instantiation validates every produced structure
 * through the same validators user-built ones go through, so a template can
 * never smuggle in an op or a duration the schema would refuse by hand.
 *
 * Versioning: templates carry v; unknown versions are refused (like op-docs).
 * The starter set below is data a designer can extend; ids are permanent for
 * the same reason look ids are (drafts reference them).
 */

import { TIMELINE_KIND, TIMELINE_VERSION, validateTimeline } from './composer.js'
import { COLLAGE_LAYOUTS } from './collage.js'
import { LOOKS } from './looks.js'

export const TEMPLATE_KIND = 'spotme-studio-template'
export const TEMPLATE_VERSION = 1

/**
 * Starter set. `slots` is how many source images the user must pick.
 * Story format is 1080×1920@30 (9:16); collage default square.
 */
export const TEMPLATES = Object.freeze({
  story_clean: {
    kind: TEMPLATE_KIND,
    v: TEMPLATE_VERSION,
    id: 'story_clean',
    name: 'Clean Story',
    type: 'story',
    slots: 1,
    story: {
      width: 1080, height: 1920, fps: 30,
      segments: [{ durMs: 5000, kenBurns: { from: { x: 0.5, y: 0.5, scale: 1 }, to: { x: 0.5, y: 0.45, scale: 1.08 } } }]
    }
  },
  story_golden: {
    kind: TEMPLATE_KIND,
    v: TEMPLATE_VERSION,
    id: 'story_golden',
    name: 'Golden Story',
    type: 'story',
    slots: 1,
    story: {
      width: 1080, height: 1920, fps: 30,
      segments: [{
        durMs: 6000,
        ops: [{ op: 'look', v: 1, params: { id: 'golden_hour', strength: 0.85 } }],
        kenBurns: { from: { x: 0.5, y: 0.55, scale: 1.12 }, to: { x: 0.5, y: 0.45, scale: 1 } }
      }]
    }
  },
  reel_triptych: {
    kind: TEMPLATE_KIND,
    v: TEMPLATE_VERSION,
    id: 'reel_triptych',
    name: 'Triptych Reel',
    type: 'reel',
    slots: 3,
    story: {
      width: 1080, height: 1920, fps: 30,
      segments: [
        { durMs: 3200, transition: { type: 'crossfade', durMs: 500 }, kenBurns: { from: { x: 0.5, y: 0.5, scale: 1 }, to: { x: 0.5, y: 0.5, scale: 1.1 } } },
        { durMs: 3200, transition: { type: 'crossfade', durMs: 500 }, kenBurns: { from: { x: 0.5, y: 0.5, scale: 1.1 }, to: { x: 0.5, y: 0.5, scale: 1 } } },
        { durMs: 3600, kenBurns: { from: { x: 0.5, y: 0.5, scale: 1 }, to: { x: 0.5, y: 0.45, scale: 1.12 } } }
      ]
    }
  },
  reel_mono_slide: {
    kind: TEMPLATE_KIND,
    v: TEMPLATE_VERSION,
    id: 'reel_mono_slide',
    name: 'Mono Slide Reel',
    type: 'reel',
    slots: 4,
    story: {
      width: 1080, height: 1920, fps: 30,
      segments: [0, 1, 2, 3].map((i) => ({
        durMs: 2800,
        ops: [{ op: 'look', v: 1, params: { id: 'mono_classic', strength: 1 } }],
        ...(i < 3 ? { transition: { type: 'slide', durMs: 400 } } : {})
      }))
    }
  },
  collage_four: {
    kind: TEMPLATE_KIND,
    v: TEMPLATE_VERSION,
    id: 'collage_four',
    name: 'Four Up',
    type: 'collage',
    slots: 4,
    collage: { layout: 'four_grid', width: 1080, height: 1080, gutter: 10, radius: 20, background: '#101014' }
  },
  collage_hero: {
    kind: TEMPLATE_KIND,
    v: TEMPLATE_VERSION,
    id: 'collage_hero',
    name: 'Hero + Three',
    type: 'collage',
    slots: 4,
    collage: { layout: 'four_hero_top', width: 1080, height: 1350, gutter: 8, radius: 16, background: '#0f0f10' }
  }
})

export const templateIds = () => Object.keys(TEMPLATES)

/* -------------------------------------------------------------- validation */

export function validateTemplate (t) {
  if (!t || typeof t !== 'object') throw new TypeError('template: not an object')
  if (t.kind !== TEMPLATE_KIND) throw new Error('template: wrong kind')
  if (t.v !== TEMPLATE_VERSION) throw new Error(`template: unsupported version ${t.v}`)
  if (typeof t.id !== 'string' || !/^[a-z0-9_]{2,40}$/.test(t.id)) throw new Error('template: bad id')
  if (typeof t.name !== 'string' || !t.name) throw new Error('template: needs a name')
  if (!['story', 'reel', 'collage'].includes(t.type)) throw new Error('template: type must be story|reel|collage')
  if (!Number.isInteger(t.slots) || t.slots < 1 || t.slots > 12) throw new Error('template: slots must be 1..12')
  if (t.type === 'collage') {
    if (!t.collage || !COLLAGE_LAYOUTS[t.collage.layout]) throw new Error('template: unknown collage layout')
    if (COLLAGE_LAYOUTS[t.collage.layout].cells.length < t.slots) {
      throw new Error('template: more slots than layout cells')
    }
  } else {
    if (!t.story || !Array.isArray(t.story.segments) || t.story.segments.length !== t.slots) {
      throw new Error('template: story segments must match slots')
    }
    for (const seg of t.story.segments) {
      for (const op of seg.ops || []) {
        if (op.op === 'look' && !LOOKS[op.params?.id]) throw new Error(`template: unknown look ${op.params?.id}`)
      }
    }
  }
  return t
}

/* ----------------------------------------------------------- instantiation */

/**
 * Expand a template + the user's picked sources into a renderable structure.
 * sourceRefs are ASSET IDS (the caller decodes/loads them); count must match
 * the template's slots.
 *
 * → { type: 'timeline', timeline } | { type: 'collage', layout, options, refs }
 */
export function instantiateTemplate (idOrTemplate, sourceRefs) {
  const t = typeof idOrTemplate === 'string' ? TEMPLATES[idOrTemplate] : idOrTemplate
  if (!t) throw new RangeError(`unknown template: ${idOrTemplate}`)
  validateTemplate(t)
  if (!Array.isArray(sourceRefs) || sourceRefs.length !== t.slots ||
      sourceRefs.some((r) => typeof r !== 'string' || !r)) {
    throw new RangeError(`template ${t.id}: needs exactly ${t.slots} source refs`)
  }
  if (t.type === 'collage') {
    return { type: 'collage', layout: t.collage.layout, options: { ...t.collage }, refs: [...sourceRefs] }
  }
  const timeline = validateTimeline({
    kind: TIMELINE_KIND,
    v: TIMELINE_VERSION,
    width: t.story.width,
    height: t.story.height,
    fps: t.story.fps,
    segments: t.story.segments.map((seg, i) => ({ type: 'image', ref: sourceRefs[i], ...seg }))
  })
  return { type: 'timeline', timeline }
}
