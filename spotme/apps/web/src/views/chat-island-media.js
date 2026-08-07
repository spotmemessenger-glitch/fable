/**
 * Chat island — browser side effects for the React chat (session 2).
 *
 * Every raw platform API the ChatPort needs lives HERE: file pickers,
 * canvas compression + the view-once mask, MediaRecorder, geolocation,
 * clipboard, and the fullscreen/reveal overlays. The @spotme/ui package is
 * fence-forbidden from all of it and only ever receives display-ready
 * URLs/labels through chat-island-port.js.
 *
 * All helpers come from lib/media.js — the same ones the legacy view uses.
 * No flag read here — the single one lives in chat-island.js.
 */
import {
  compressImage, maskDataURL, fileToDataURL, recordVoice, currentLocation,
  mapLink, PHOTO_STD
} from '../lib/media.js'

/** One-shot hidden file input; resolves null on cancel. */
function pickNative (accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept) input.accept = accept
    input.style.display = 'none'
    document.body.appendChild(input)
    const done = (file) => { input.remove(); resolve(file || null) }
    input.addEventListener('change', () => done(input.files?.[0]))
    input.addEventListener('cancel', () => done(null))
    input.click()
  })
}

/** @returns the `ui` object chat-island-port.js expects. */
export function browserMediaUI (root) {
  return {
    mapLink,
    recordVoice,
    getLocation: currentLocation,

    /** → sendAttachment partial, or null on cancel. A private photo gets the
     *  sender-made 16px mask (legacy contract: the receiver's locked tile
     *  shows the mask, never the bytes). */
    async pickPhoto (viewOnce) {
      const file = await pickNative('image/*')
      if (!file) return null
      const data = await compressImage(file, PHOTO_STD.edge, PHOTO_STD.q)
      if (!viewOnce) return { kind: 'image', data }
      const mask = await maskDataURL(data)
      return { kind: 'image', data, viewOnce: true, mask }
    },

    async pickFile () {
      const file = await pickNative('')
      if (!file) return null
      const data = await fileToDataURL(file)
      return { kind: 'file', data, fileName: file.name, fileSize: file.size }
    },

    copy (text, ctx) {
      if (!text) { ctx.toast('Nothing to copy'); return }
      navigator.clipboard?.writeText(text)
        .then(() => ctx.toast('Copied'))
        .catch(() => ctx.toast('Could not copy'))
    },

    /** Fullscreen photo — same overlay grammar as the legacy openImage. */
    openPhoto (data) {
      const overlay = document.createElement('div')
      overlay.className = 'imgview'
      const img = document.createElement('img')
      img.src = data
      img.alt = ''
      overlay.appendChild(img)
      overlay.addEventListener('click', () => overlay.remove())
      root.appendChild(overlay)
    },

    /**
     * The reveal, over a function-scoped copy of the bytes — the burn has
     * ALREADY been committed by the caller. Resolves when the countdown ends
     * or the viewer closes early (closing early consumes it too, like the
     * legacy viewer). Ghost-click armour: 400ms.
     */
    revealViewOnce ({ kind, data }, secs) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div')
        overlay.className = 'imgview burstview'
        const media = document.createElement(kind === 'video' ? 'video' : 'img')
        media.src = data
        if (kind === 'video') { media.autoplay = true; media.loop = true; media.playsInline = true }
        const count = document.createElement('span')
        count.className = 'bcount'
        overlay.appendChild(media)
        overlay.appendChild(count)
        root.appendChild(overlay)

        // Wall clock, not a tick count (throttled background tabs).
        const endsAt = Date.now() + secs * 1000
        let done = false
        const finish = () => {
          if (done) return
          done = true
          clearInterval(tick)
          overlay.remove()
          resolve()
        }
        const tick = setInterval(() => {
          const left = Math.max(0, (endsAt - Date.now()) / 1000)
          count.textContent = String(Math.ceil(left))
          if (left <= 0) finish()
        }, 250)
        count.textContent = String(secs)
        const openedAt = Date.now()
        overlay.addEventListener('click', () => {
          if (Date.now() - openedAt < 400) return
          finish()
        })
      })
    }
  }
}
