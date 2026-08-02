/**
 * Spot Me — Creative Studio entry point.
 *
 * createStudio(deps) is the ONLY intended way in. With the master flag off —
 * the shipped state — the returned object is INERT: constructing it touches
 * no canvas, opens no database, schedules no timer, reads no clock; every
 * capability method throws StudioDisabledError. The fence test proves this by
 * injecting fakes that throw on any use. (Importing this module populates the
 * op REGISTRY — pure Maps of functions — and nothing else.)
 *
 * Everything is dependency-injected (clock, idb, canvas factory, fetch, auth
 * headers) so the module has zero imports from the rest of the app, tests run
 * headless, and the integration wiring is one explicit call site later:
 *
 *     createStudio({
 *       flags: ownerFlagOverrides,           // parented under AI_CAMERA_ENABLED at wiring time
 *       getAuthHeaders: authHeaders,         // lib/auth-headers.js
 *       idb: indexedDB, makeCanvas: (w, h) => new OffscreenCanvas(w, h)
 *     })
 */

import { DEFAULT_FLAGS, FLAG_PARENT, resolveFlags, assertShippedDark } from './flags.js'
import { systemClock } from './clock.js'
import { createEvaluator } from './evaluator.js'
import { createGlRuntime } from './gl-eval.js'
import { createEditDoc, parseEditDoc } from './opdoc.js'
import { createDraftsStore } from './drafts.js'
import { createCloudClient } from './studio-cloud.js'
import { createSegmenterSlot } from './masks.js'
import { validateTimeline, renderFrame, totalDurationMs } from './composer.js'
import { renderTimeline, probeEncoders } from './render-video.js'
import { renderCollage, collageLayoutIds } from './collage.js'
import { TEMPLATES, templateIds, instantiateTemplate } from './templates.js'
import { LOOKS, lookIds } from './looks.js'

// Registering the ops is a load-time side effect of these imports — pure data.
import './ops-color.js'
import './ops-spatial.js'
import './ops-geometry.js'
import './inpaint.js'
import './composite.js'

export { DEFAULT_FLAGS, FLAG_PARENT, resolveFlags, assertShippedDark }

export class StudioDisabledError extends Error {
  constructor (feature) {
    super(`creative studio: ${feature} is disabled by feature flag`)
    this.name = 'StudioDisabledError'
    this.feature = feature
  }
}

export function createStudio (deps = {}) {
  const flags = resolveFlags(deps.flags || {})

  if (!flags.CREATIVE_STUDIO_ENABLED) {
    // INERT. No dep is read, stored calls all throw. `flags` and `enabled`
    // are plain data so a caller can render a "not available" state.
    const dead = (feature) => () => { throw new StudioDisabledError(feature) }
    return Object.freeze({
      enabled: false,
      flags,
      editor: Object.freeze({ createDoc: dead('editor'), parseDoc: dead('editor'), render: dead('editor') }),
      looks: Object.freeze({ ids: dead('looks'), byId: dead('looks') }),
      removal: Object.freeze({ segmenter: Object.freeze({ available: () => false, register: dead('removal'), segment: dead('removal'), kinds: () => [] }) }),
      composer: Object.freeze({ validate: dead('composer'), renderFrame: dead('composer'), renderVideo: dead('composer'), probeEncoders: dead('composer'), totalDurationMs: dead('composer') }),
      collage: Object.freeze({ layouts: dead('collage'), render: dead('collage') }),
      templates: Object.freeze({ ids: dead('templates'), byId: dead('templates'), instantiate: dead('templates') }),
      drafts: Object.freeze({ available: () => false, save: dead('drafts'), list: dead('drafts'), openDraft: dead('drafts'), remove: dead('drafts'), prune: dead('drafts') }),
      cloud: Object.freeze({ enabled: () => false, inpaint: dead('cloud AI'), styleTransfer: dead('cloud AI'), stickerFromPhoto: dead('cloud AI'), captionSuggest: dead('cloud AI') }),
      dispose () {}
    })
  }

  const clock = deps.clock || systemClock()
  const gate = (flag, feature, value) => {
    if (flags[flag] !== true) throw new StudioDisabledError(feature)
    return value
  }

  // GL is preview acceleration: constructed only when the editor is on and a
  // canvas is reachable; createGlRuntime returns null rather than throwing.
  const glRuntime = flags.STUDIO_EDITOR_ENABLED
    ? createGlRuntime({ makeCanvas: deps.makeCanvas })
    : null
  const evaluator = createEvaluator({ glRuntime })
  const segmenter = createSegmenterSlot()
  const drafts = createDraftsStore({ flags, clock, idb: deps.idb })
  const cloud = createCloudClient({
    flags,
    fetchImpl: deps.fetchImpl,
    getAuthHeaders: deps.getAuthHeaders,
    base: deps.apiBase || ''
  })

  return Object.freeze({
    enabled: true,
    flags,

    editor: Object.freeze({
      createDoc: (init) => gate('STUDIO_EDITOR_ENABLED', 'editor', createEditDoc(init)),
      parseDoc: (json) => gate('STUDIO_EDITOR_ENABLED', 'editor', parseEditDoc(json)),
      render: (source, ops, opts) => gate('STUDIO_EDITOR_ENABLED', 'editor', evaluator.render(source, ops, opts))
    }),

    looks: Object.freeze({
      ids: () => gate('STUDIO_LOOKS_ENABLED', 'looks', lookIds()),
      byId: (id) => gate('STUDIO_LOOKS_ENABLED', 'looks', LOOKS[id] || null)
    }),

    removal: Object.freeze({
      // Local inpaint/masking runs through editor.render (ops). The semantic
      // engine slot is exposed here for the owner-approved integration.
      segmenter: Object.freeze({
        available: () => flags.STUDIO_BG_REPLACE_ENABLED && segmenter.available(),
        kinds: () => segmenter.kinds(),
        register: (engine) => gate('STUDIO_BG_REPLACE_ENABLED', 'segmenter', segmenter.register(engine)),
        segment: (img, opts) => gate('STUDIO_BG_REPLACE_ENABLED', 'segmenter', segmenter.segment(img, opts))
      })
    }),

    composer: Object.freeze({
      validate: (t) => gate('STUDIO_COMPOSER_ENABLED', 'composer', validateTimeline(t)),
      totalDurationMs: (t) => gate('STUDIO_COMPOSER_ENABLED', 'composer', totalDurationMs(t)),
      renderFrame: (t, tMs, extra) => gate('STUDIO_COMPOSER_ENABLED', 'composer',
        renderFrame(t, tMs, { evaluator, ...extra })),
      probeEncoders: (env) => gate('STUDIO_COMPOSER_ENABLED', 'composer', probeEncoders(env)),
      renderVideo: (t, extra) => gate('STUDIO_COMPOSER_ENABLED', 'composer',
        renderTimeline(t, { evaluator, makeCanvas: deps.makeCanvas, ...extra }))
    }),

    collage: Object.freeze({
      layouts: () => gate('STUDIO_COLLAGE_ENABLED', 'collage', collageLayoutIds()),
      render: (layoutId, images, options) => gate('STUDIO_COLLAGE_ENABLED', 'collage', renderCollage(layoutId, images, options))
    }),

    templates: Object.freeze({
      ids: () => gate('STUDIO_TEMPLATES_ENABLED', 'templates', templateIds()),
      byId: (id) => gate('STUDIO_TEMPLATES_ENABLED', 'templates', TEMPLATES[id] || null),
      instantiate: (id, refs) => gate('STUDIO_TEMPLATES_ENABLED', 'templates', instantiateTemplate(id, refs))
    }),

    drafts,          // internally flag-gated (answers {ok:false, reason:'disabled'})
    cloud,           // internally flag-gated (throws before any egress)

    dispose () { glRuntime?.dispose?.() }
  })
}
