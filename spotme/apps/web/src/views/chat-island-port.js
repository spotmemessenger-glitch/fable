/**
 * Chat island — the ChatPort adapter (ADR-035 final slice, session 2).
 *
 * Builds the display-ready port the React ChatShell consumes. Everything the
 * package sees is shaped HERE from the same lib/rooms.js + lib/db.js the
 * legacy view uses; every mutation routes to the same rooms.* call the legacy
 * view makes, so persisted shapes cannot move (§(g) tier 3).
 *
 * Browser side effects (file pickers, canvas, MediaRecorder, geolocation,
 * clipboard, overlays) are injected as `ui` — implemented for the app by
 * chat-island-media.js, faked by apps/web/test/chat-viewonce-react.test.js,
 * which pins the view-once contract: the locked row NEVER carries the photo
 * bytes, the burn (rooms.viewOnceOpen) commits BEFORE the reveal, and the
 * tombstone survives because the engine is the one doing it.
 *
 * No flag read here — the single one lives in chat-island.js.
 */

/** Stub/preview labels — same grammar as the engine's preview (pinned by
 *  chat-characterization). Used for stubs AND reply/copy snippets. */
export function stubLabel (m) {
  switch (m.kind) {
    case 'image': return m.viewOnce ? 'Private photo' : 'Photo'
    case 'video': return 'Video'
    case 'voice': return `Voice note (${m.dur || 0}s)`
    case 'file': return m.fileName || 'File'
    case 'location': return m.live === false ? 'Live location ended'
      : m.live ? 'Live location' : 'Location'
    default: return 'Message'
  }
}

/** '🔥 5s' / '🔥 2m' — sender-chosen burst timer; 10s is the viewer default. */
const burstChip = (m) => {
  const secs = m.burst || 10
  return `🔥 ${secs >= 60 ? `${secs / 60}m` : `${secs}s`}`
}

const privateLabel = (m) => {
  const noun = m.kind === 'video' ? 'Private video' : 'Private photo'
  if (!m.burst) return `${noun} — tap to open`
  return `${noun} · ${m.burst >= 60 ? `${m.burst / 60}m` : `${m.burst}s`} — tap to open`
}

/** Legacy renderReacts grammar: aggregate per emoji, in arrival order. */
function reactionChips (reactions = []) {
  const counts = new Map()
  for (const r of reactions) counts.set(r.emoji, (counts.get(r.emoji) || 0) + 1)
  return Array.from(counts, ([emoji, count]) => ({ emoji, count }))
}

/**
 * The display-ready media payload for a row, or null when the kind renders as
 * text/stub. A view-once row carries ONLY the sender-made 16px mask — never
 * m.data — exactly the legacy rule (chat.js buildBubble: "Nothing here may
 * ever reference m.data").
 */
function mediaOf (m, mine, conn, mapLink) {
  if ((m.kind === 'image' || m.kind === 'video') && m.viewOnce) {
    if (mine) {
      return {
        type: 'viewOnceMine',
        label: m.kind === 'video' ? 'Private video' : 'Private photo',
        chip: burstChip(m),
        opened: Boolean(conn.seenByPeer?.has?.(m.id))
      }
    }
    return { type: 'viewOnce', maskUrl: m.mask || null, label: privateLabel(m), chip: burstChip(m) }
  }
  if (m.kind === 'image' && m.data) {
    return { type: 'photo', url: m.data, caption: m.text || '' }
  }
  if (m.kind === 'voice' && m.data) {
    return { type: 'voice', url: m.data, durLabel: `${m.dur || 0}s` }
  }
  if (m.kind === 'file') {
    const kb = Math.max(1, Math.round((m.fileSize || 0) / 1024))
    return { type: 'file', url: m.data || null, name: m.fileName || 'File', sizeLabel: `${kb} KB` }
  }
  if (m.kind === 'location') {
    const ended = m.live === false
    return {
      type: 'location',
      mapUrl: ended ? null : mapLink(m.lat, m.lon),
      label: ended ? 'Live location ended' : (m.live ? 'Live location' : 'Current location'),
      live: Boolean(m.live)
    }
  }
  return null
}

/**
 * @param {{ db:object, rooms:object, fmtTime:(ts:number)=>string, fmtDay:(ts:number)=>string }} deps
 * @param {{ nav(p:string):void, toast(m:string):void }} ctx
 * @param {string} roomId
 * @param {object} ui - browser side effects (chat-island-media.js shape)
 */
export function buildChatPort ({ db, rooms, fmtTime, fmtDay }, ctx, roomId, ui) {
  const convo = db.convo(roomId)
  const conn = convo && rooms.ensure(roomId)
  if (!conn) return null
  const myId = db.profile().id
  const group = convo.kind === 'group'

  const dayLabel = (ts) =>
    new Date(ts).toDateString() === new Date().toDateString() ? 'Today' : fmtDay(ts)

  function rowOf (m) {
    const mine = m.from === myId
    const isText = !m.kind || m.kind === 'text'
    const orig = m.replyTo ? conn.store.list().find((x) => x.id === m.replyTo) : null
    const media = m.kind === 'system' ? null : mediaOf(m, mine, conn, ui.mapLink)
    return {
      id: m.id,
      mine,
      kind: m.kind === 'system' ? 'system' : (isText ? 'text' : (media ? 'media' : 'stub')),
      text: m.kind === 'system'
        ? (m.sys === 'timer' ? (m.secs ? '⏱ Timer messages on' : '⏱ Timer messages off') : '')
        : (isText ? m.text : stubLabel(m)),
      name: mine ? 'You' : (m.name || convo.peer?.name || ''),
      showName: group,
      timeLabel: fmtTime(m.ts),
      dayKey: new Date(m.ts).toDateString(),
      dayLabel: dayLabel(m.ts),
      // The pinned legacy derivation: failed wins; else readUpTo >= ts.
      status: m.failed ? 'failed' : (conn.readUpTo >= m.ts ? 'read' : 'sent'),
      edited: Boolean(m.editedAt),
      replyPreview: orig
        ? {
            name: orig.from === myId ? 'You' : (orig.name || ''),
            text: (!orig.kind || orig.kind === 'text') ? orig.text : stubLabel(orig)
          }
        : null,
      reactions: reactionChips(m.reactions),
      canEdit: mine && isText,
      copyText: isText ? (m.text || null)
        : (m.kind === 'location' && m.live !== false ? ui.mapLink(m.lat, m.lon) : null),
      ...(media ? { media } : {})
    }
  }

  /* Snapshot cache, invalidated on any conn/db notify (useSyncExternalStore
   * needs a stable object between notifies). */
  let snap = null
  let recordingLabel = ''
  let recorder = null
  let recTimer = null
  let recStartedAt = 0
  const listeners = new Set()
  const invalidate = () => { snap = null; for (const fn of listeners) fn() }

  function buildSnapshot () {
    const current = db.convo(roomId) || convo
    const typing = conn.typing && conn.typing.until > Date.now() ? conn.typing : null
    let presenceLabel = ''
    if (conn.peerCount > 0) presenceLabel = 'Online'
    else if (current.peerSeen) presenceLabel = `Last seen ${fmtDay(current.peerSeen)}`
    return {
      header: {
        name: current.title || current.peer?.name || 'Chat',
        presenceLabel,
        avatarUrl: current.peer?.avatar || null
      },
      rows: conn.store.list().map(rowOf),
      typingLabel: typing ? `${typing.name || 'Someone'} is typing…` : '',
      recordingLabel
    }
  }

  const sendAttach = (partial) => {
    const m = rooms.sendAttachment(roomId, partial, () => {})
    if (!m) ctx.toast('Could not send that')
    invalidate()
  }

  /**
   * Spend the one view — legacy tapViewOnce/openViewOnce order EXACTLY:
   * fetch bytes if this device does not hold them, commit the burn FIRST
   * (rooms.viewOnceOpen tombstones locally + deletes server slices + starts
   * the sender's countdown), then reveal a function-scoped copy, then report
   * the open (rooms.viewOnceOpened). Nothing about the revealed state is ever
   * written anywhere — the copy dies with this call.
   */
  async function openViewOnce (id) {
    const m = conn.store.list().find((x) => x.id === id)
    if (!m || !m.viewOnce) return
    let data = m.data
    if (!data) {
      try { data = await rooms.fetchAttachment(roomId, id) } catch {
        ctx.toast('That private photo is no longer available')
        return
      }
    }
    const secs = Math.max(1, m.burst || 10)
    try { rooms.viewOnceOpen(roomId, id, secs) } catch { /* offline */ }
    invalidate()
    await ui.revealViewOnce({ kind: m.kind, data }, secs)
    rooms.viewOnceOpened(roomId, id)
    invalidate()
    ctx.toast('Burst — the photo is gone')
  }

  async function toggleVoiceRecord () {
    if (recorder) {
      const rec = recorder
      recorder = null
      clearInterval(recTimer)
      recordingLabel = ''
      invalidate()
      try {
        const { dataURL, dur } = await rec.stop()
        sendAttach({ kind: 'voice', data: dataURL, dur })
      } catch { ctx.toast('Could not record — check the microphone permission') }
      return
    }
    try {
      recorder = await ui.recordVoice()
      recStartedAt = Date.now()
      const label = () => {
        const s = Math.round((Date.now() - recStartedAt) / 1000)
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
      }
      recordingLabel = label()
      recTimer = setInterval(() => { recordingLabel = label(); invalidate() }, 500)
      invalidate()
    } catch {
      recorder = null
      ctx.toast('Could not record — check the microphone permission')
    }
  }

  return {
    subscribe (fn) {
      listeners.add(fn)
      const offConn = conn.on(invalidate)
      const offDb = db.subscribe(invalidate)
      return () => { listeners.delete(fn); offConn(); offDb() }
    },
    snapshot () {
      if (!snap) snap = buildSnapshot()
      return snap
    },

    sendText: (text, replyToId) => {
      const partial = { text }
      if (replyToId) partial.replyTo = replyToId
      const msgTtl = db.convo(roomId)?.msgTtl || 0
      if (msgTtl) partial.ttl = msgTtl
      rooms.sendMessage(roomId, partial)
      invalidate()
    },
    retry: (id) => { rooms.retryMessage(roomId, id); invalidate() },
    markRead: () => rooms.markRead(roomId),
    setTyping: (on) => rooms.typing(roomId, on),

    react: (id, emoji) => { rooms.react(roomId, id, emoji); invalidate() },
    editText: (id, text) => {
      if (rooms.editMessage(roomId, id, text) === null) ctx.toast('Only your own messages can be edited')
      invalidate()
    },
    deleteMessage: (id, forEveryone) => {
      if (forEveryone) rooms.deleteMessage(roomId, id)
      else conn.store.remove(id)   // local only — nothing is broadcast (legacy "Delete for me")
      invalidate()
    },
    copy: (text) => { ui.copy(text, ctx) },

    openPhoto: (id) => {
      const m = conn.store.list().find((x) => x.id === id)
      if (m?.data) ui.openPhoto(m.data)
    },
    openViewOnce: (id) => { void openViewOnce(id) },

    attachPhoto: (viewOnce) => {
      ui.pickPhoto(viewOnce)
        .then((partial) => { if (partial) sendAttach(partial) })
        .catch(() => ctx.toast('Could not read that photo'))
    },
    attachFile: () => {
      ui.pickFile()
        .then((partial) => { if (partial) sendAttach(partial) })
        .catch((e) => ctx.toast(e?.message || 'Could not read that file'))
    },
    attachLocation: () => {
      ui.getLocation()
        .then(({ lat, lon }) => { rooms.sendMessage(roomId, { kind: 'location', lat, lon }); invalidate() })
        .catch(() => ctx.toast('Location is not available'))
    },
    toggleVoiceRecord: () => { void toggleVoiceRecord() },

    back: () => ctx.nav('#/chat'),
    toast: (m) => ctx.toast(m)
  }
}
