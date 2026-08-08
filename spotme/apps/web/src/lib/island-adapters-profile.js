/**
 * Slice-4 island adapter — Profile & Settings.
 *
 * Builds a ProfilePort over the same lib code the legacy view uses (db, lobby,
 * rooms, media, crop, voice, notify, push, registry API) and mounts the React
 * surface via the slice-1 island host. The port boundary is the media/network
 * fence: photo upload + crop, AI avatars (DiceBear fetch), voice cloning, and
 * the username registry all run HERE — the package only ever sees strings and
 * booleans, never a File, canvas, mic stream, or fetch.
 *
 * §(g) tier 3: every persisted write on this path is the exact key and shape
 * the legacy view writes — db.setProfile / db.setSettings with the same keys,
 * and localStorage.clear() behind the same double-confirm danger flow.
 */
import { db, randomHex } from './db.js'
import { lobby } from './discovery.js'
import { rooms } from './rooms.js'
import { LANGS } from './translate.js'
import { compressImage, AVATAR_EDGE, AVATAR_QUALITY } from './media.js'
import { deleteClone } from './voice.js'
import { openVoiceCloneSheet } from './voice-clone-sheet.js'
import { openCrop } from './crop.js'
import { el, actionSheet } from './ui.js'
import { notifyState, enableNotify, chime, notifyBlockedReason } from './notify.js'
import { subscribePush } from './push.js'
import { API_BASE as REGISTRY_API } from './api.js'
import { mountIsland, unmountIsland } from './island.js'

const USERNAME_RE = /^[a-z0-9_]{2,}$/
const LAST_SEEN_LABELS = { everyone: 'Everyone', contacts: 'My contacts', nobody: 'Nobody' }
const AI_STYLES = ['adventurer', 'bottts', 'fun-emoji', 'avataaars']
const AI_COUNT = 12

const langNative = (code) => LANGS.find((l) => l.code === code)?.native || code
const langEnglish = (code) => LANGS.find((l) => l.code === code)?.name || code

function notifLabel () {
  const state = notifyState()
  return state === 'granted' ? 'On'
    : state === 'denied' ? 'Blocked in browser'
    : state === 'unsupported'
      ? (notifyBlockedReason() === 'ios-needs-install' ? 'Add to Home Screen' : 'Not supported')
      : 'Tap to allow'
}

export function profileIsland (root, ctx) {
  let snap = null
  const listeners = new Set()
  const invalidate = () => { snap = null; listeners.forEach((fn) => fn()) }

  function compute () {
    const p = db.profile() || {}
    const s = db.settings()
    return {
      me: { name: p.name || 'Me', avatarUrl: p.avatar || null },
      raw: { name: p.name || '', about: p.about || '', phone: p.phone || '', username: p.username || '' },
      hasRecovery: Boolean(p.claimSecret),
      voice: {
        hasVoice: Boolean(p.voiceId),
        createdLabel: p.voiceCreatedTs
          ? new Date(p.voiceCreatedTs).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
          : 'earlier'
      },
      langLabel: `${langNative(p.lang)} · ${langEnglish(p.lang)}`,
      lastSeenLabel: LAST_SEEN_LABELS[s.lastSeen] || LAST_SEEN_LABELS.everyone,
      notifLabel: notifLabel(),
      toggles: {
        showOnMap: Boolean(s.showOnMap),
        appBlur: s.appBlur !== false,
        sound: s.sound !== false,
        vibrate: s.vibrate !== false,
        autoTranslate: Boolean(p.autoTranslate),
        translit: Boolean(p.translit),
        readAloud: Boolean(s.readAloud),
        demoMode: Boolean(s.demoMode)
      },
      blocked: db.blocked().map((b) => ({ id: b.id, name: b.name || 'Unknown', avatarUrl: b.avatar || null })),
      langs: LANGS.map((l) => ({ code: l.code, native: l.native, name: l.name })),
      selectedLang: p.lang
    }
  }

  /** Push the changed name/about to every open conversation right away. */
  function broadcastProfile () {
    const p = db.profile()
    for (const convo of db.convos()) {
      rooms.get(convo.roomId)?.net.sendProfile({ name: p.name, lang: p.lang, about: p.about || '' })
    }
  }

  /* ------------------------------------------------------------ avatars */

  async function fetchGeneratedAvatar (style, seed) {
    const res = await fetch(`https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}`)
    if (!res.ok) throw new Error(`avatar fetch failed (${res.status})`)
    const svg = await res.text()
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
  }

  const filePick = el('input', { type: 'file', accept: 'image/*', style: 'display:none' })
  filePick.addEventListener('change', async () => {
    const file = filePick.files?.[0]
    filePick.value = ''
    if (!file) return
    try {
      const { dataURL } = await compressImage(file, AVATAR_EDGE, AVATAR_QUALITY)
      const cropped = await openCrop(dataURL)
      if (!cropped) return
      db.setProfile({ avatar: cropped })
      lobby.announce()
      ctx.toast('Photo updated')
    } catch { ctx.toast('Could not read that image') }
  })
  root.appendChild(filePick)

  function openAiAvatarSheet () {
    const backdrop = el('div', { class: 'ai-back' })
    const close = () => backdrop.remove()
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })
    const grid = el('div', { class: 'ai-grid' })
    const loading = el('div', { class: 'ai-loading', text: 'Generating avatars…' })
    backdrop.appendChild(el('div', { class: 'ai-sheet' }, [
      el('div', { class: 'ai-title', text: 'Generated avatars' }),
      el('div', { class: 'ai-sub', text: 'Made by the DiceBear avatar service — pick one you like.' }),
      loading,
      grid
    ]))
    root.appendChild(backdrop)

    const seedBase = db.profile().name || 'spot'
    const jobs = Array.from({ length: AI_COUNT }, (_, n) =>
      fetchGeneratedAvatar(AI_STYLES[n % AI_STYLES.length], `${seedBase}${n}`))
    Promise.allSettled(jobs).then((results) => {
      if (!backdrop.isConnected) return
      loading.remove()
      const urls = results.filter((r) => r.status === 'fulfilled').map((r) => r.value)
      if (!urls.length) {
        close()
        ctx.toast('Avatar service unreachable')
        filePick.click()
        return
      }
      for (const dataURL of urls) {
        grid.appendChild(el('button', {
          class: 'ai-cell', type: 'button', 'aria-label': 'Use this avatar',
          onclick () {
            db.setProfile({ avatar: dataURL })
            lobby.announce()
            ctx.toast('Avatar updated')
            close()
          }
        }, [el('img', { src: dataURL, alt: '' })]))
      }
    })
  }


  /* ---------------------------------------------------------------- port */

  const port = {
    subscribe (fn) {
      listeners.add(fn)
      const unsubs = [db.subscribe(invalidate), lobby.subscribe(invalidate)]
      return () => { listeners.delete(fn); unsubs.forEach((u) => u()) }
    },
    snapshot () { return (snap ??= compute()) },

    saveField (key, next) {
      if (key === 'name') {
        if (!next) { ctx.toast('A name is required'); return false }
        db.setProfile({ name: next })
        lobby.announce()
        broadcastProfile()
        ctx.toast('Name updated')
        return true
      }
      if (key === 'about') {
        db.setProfile({ about: next })
        broadcastProfile()
        ctx.toast(next ? 'About updated' : 'About cleared')
        return true
      }
      db.setProfile({ phone: next })
      ctx.toast(next ? 'Phone number saved' : 'Phone number removed')
      return true
    },

    async copyRecovery () {
      const secret = db.profile().claimSecret
      if (!secret) { ctx.toast('No recovery code on this device'); return }
      try {
        await navigator.clipboard.writeText(secret)
        ctx.toast('Recovery code copied — save it somewhere safe. It signs you back in if this device forgets you.')
      } catch { ctx.toast('Could not copy the code') }
    },
    async copyUsername () {
      try {
        await navigator.clipboard.writeText('@' + db.profile().username)
        ctx.toast('Username copied')
      } catch { ctx.toast('Could not copy the username') }
    },

    async checkUsername (handle) {
      if (!USERNAME_RE.test(handle)) return 'error'
      try {
        const res = await fetch(`${REGISTRY_API}/api/username?check=${encodeURIComponent(handle)}`)
        const data = await res.json()
        return data.available ? 'ok' : 'taken'
      } catch { return 'error' }
    },
    async claimUsername (handle) {
      if (!USERNAME_RE.test(handle)) return 'error'
      const current = db.profile().username || ''
      try {
        const me = db.profile()
        const res = await fetch(`${REGISTRY_API}/api/username`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: handle, id: me.id, name: me.name, secret: me.claimSecret })
        })
        if (res.status === 409) return 'taken'
        if (!res.ok) return 'error'
        db.setProfile({ username: handle })
        // Hand the old name back only once the new one is safely held.
        if (current && current !== handle) {
          fetch(`${REGISTRY_API}/api/username`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'release', username: current, secret: me.claimSecret, id: me.id })
          }).catch(() => { /* the old name stays taken; harmless */ })
        }
        ctx.toast(current ? 'Username changed' : 'Username claimed')
        return 'ok'
      } catch { return 'error' }
    },

    changePhoto () {
      actionSheet([
        { label: 'Upload a photo', fn: () => filePick.click() },
        { label: 'AI avatar', fn: openAiAvatarSheet }
      ], 'Change photo')
    },
    createVoice: () => openVoiceCloneSheet(root, ctx),
    deleteVoice () {
      actionSheet([{
        label: 'Delete voice',
        danger: true,
        async fn () {
          const voiceId = db.profile().voiceId
          if (!voiceId) return
          try {
            await deleteClone(voiceId)
          } catch (e) {
            if (!/404|not[_ ]?found/i.test(String(e?.message || ''))) {
              ctx.toast(String(e?.message || 'Could not delete the voice'))
              return
            }
          }
          db.setProfile({ voiceId: null, voiceCreatedTs: null })
          ctx.toast('Voice deleted — you can record a new one')
        }
      }], 'Delete your cloned voice? Voice notes use a standard voice until you record a new one.')
    },

    openLastSeen () {
      const current = db.settings().lastSeen || 'everyone'
      actionSheet(
        ['everyone', 'contacts', 'nobody'].map((value) => ({
          label: (value === current ? '✓ ' : '') + LAST_SEEN_LABELS[value],
          fn: () => db.setSettings({ lastSeen: value })
        })),
        'Who can see your last seen & online'
      )
    },

    async askNotify () {
      const state = notifyState()
      if (state === 'denied') {
        ctx.toast('Notifications are blocked for this site — allow them in your browser settings')
        return
      }
      if (state === 'unsupported') {
        ctx.toast(notifyBlockedReason() === 'ios-needs-install'
          ? 'On iPhone: tap Share, then Add to Home Screen, and open Spot Me from there'
          : 'This browser cannot show notifications')
        return
      }
      await enableNotify()
      invalidate()
      if (notifyState() !== 'granted') return
      chime()
      const push = await subscribePush()
      if (!push.ok && push.reason === 'not-configured') {
        ctx.toast('Alerts on. Waking a fully closed app is not switched on for this build yet.')
      }
      invalidate()
    },

    async invite () {
      try {
        const roomId = randomHex(8)
        const secret = randomHex(16)
        db.upsertConvo({
          roomId,
          secret,
          kind: 'dm',
          mode: 'meet',
          title: 'Invited chat',
          peer: { id: null, name: 'Invited chat', avatar: null, lang: 'en' }
        })
        rooms.ensure(roomId)
        const link = location.origin + location.pathname + '#r=' + roomId + '&k=' + secret
        if (navigator.share) {
          try {
            await navigator.share({ title: 'Spot Me', text: 'Chat with me on Spot Me', url: link })
          } catch (err) {
            if (err?.name !== 'AbortError') {
              await navigator.clipboard.writeText(link).then(
                () => ctx.toast('Link copied — send it to your friend'),
                () => ctx.toast('Could not copy the link'))
            }
          }
        } else {
          await navigator.clipboard.writeText(link).then(
            () => ctx.toast('Link copied — send it to your friend'),
            () => ctx.toast('Could not copy the link'))
        }
        ctx.openThread(roomId)
      } catch { ctx.toast('Could not create the invite') }
    },

    clearAll () {
      // Double confirm: destroying every chat and the profile deserves two gates.
      actionSheet([{
        label: 'Clear all data',
        danger: true,
        fn () {
          actionSheet([{
            label: 'Really delete',
            danger: true,
            fn () {
              try { localStorage.clear() } catch { /* private mode */ }
              location.reload()
            }
          }], 'This cannot be undone. Your username claim stays taken. Really delete?')
        }
      }], 'Delete everything from this device?')
    },

    setToggle (key, on) {
      if (key === 'showOnMap') { db.setSettings({ showOnMap: on }); lobby.announce(); return }
      if (key === 'appBlur') { db.setSettings({ appBlur: on }); return }
      if (key === 'sound') { db.setSettings({ sound: on }); if (on) chime(); return }
      if (key === 'vibrate') { db.setSettings({ vibrate: on }); return }
      if (key === 'autoTranslate') { db.setProfile({ autoTranslate: on }); return }
      if (key === 'translit') { db.setProfile({ translit: on }); return }
      if (key === 'readAloud') { db.setSettings({ readAloud: on }); return }
      if (key === 'demoMode') db.setSettings({ demoMode: on })
    },

    setLang (code) {
      db.setProfile({ lang: code })
      ctx.toast(`Messages now translate into ${langEnglish(code)}`)
    },

    unblock (id) {
      const person = db.blocked().find((b) => b.id === id)
      db.unblock(id)
      ctx.toast(`${person?.name || 'They'} can reach you again`)
    }
  }

  const host = document.createElement('div')
  host.className = 'island-host'
  root.appendChild(host)
  mountIsland('profile', host, (mod) => mod.__mountProfile(port)).catch(() => {
    host.textContent = 'This screen could not load. Turn the preview flag off to restore the classic view.'
  })
  return () => { void unmountIsland() }
}
