/**
 * Verify — the session-4 flag branch and VerifyPort adapter, in one place.
 *
 * `spotme.ui.verify` (default OFF) is read HERE and nowhere else; the legacy
 * screen (views/verify.js) carries a one-line branch and is otherwise
 * unmodified (ADR-035 §(f) #1, #2). Flag off → null → legacy renders; that
 * is the whole of §(g) tier 1.
 *
 * THE ENGINE IS REUSED, NEVER REWRITTEN. Every crypto call here is the SAME
 * call views/verify.js makes — loadIdentity, exportPublicKeyB64,
 * safetyNumber, readRecord, applyToRecord, recordVerification, setRoomTrust,
 * isEnforcing, encodeVerificationPayload, verifyScannedPayload — and every
 * result crosses the port as a finished display string. The React package
 * receives digits, sentences and a QR data URL; never a key, a payload, or a
 * crypto module. ADR-008 §12 is untouched: this file only READS identity and
 * the trust record through the modules that already existed.
 *
 * The legacy screen's three rules survive:
 *   1. Nothing computed on the render path — mount paints 'loading', then the
 *      10,400-hash derivation runs and pushes 'ready'.
 *   2. Claims stay modest — the enforcement-aware footer is decided here.
 *   3. e2e_v1 rooms get the honest "nothing to verify" paragraph.
 */
import { uiFlag, mountIsland, unmountIsland } from '../lib/island.js'

/** The v2 payload expires; re-encoding on this interval keeps the on-screen
 *  code scannable (legacy QR_REFRESH_MS). */
const QR_REFRESH_MS = 60_000

/**
 * @param {HTMLElement} root
 * @param {{ nav(p:string):void, toast(m:string):void }} ctx
 * @param {string} roomId
 * @returns {null | (() => void)} null when the flag is off (render legacy).
 */
export function reactVerify (root, ctx, roomId) {
  if (!uiFlag('verify')) return null
  let teardown = () => { void unmountIsland() }
  mount(root, ctx, roomId).then((extra) => { if (extra) teardown = extra })
  return () => teardown()
}

async function mount (root, ctx, roomId) {
  try {
    const [{ db }, idStore, e2e, sn, pinStore, pin, enforce, qrScan, { default: qrcode }] =
      await Promise.all([
        import('../lib/db.js'),
        import('../lib/crypto/identity-store.js'),
        import('../lib/crypto/e2e-v2.js'),
        import('../lib/crypto/safety-number.js'),
        import('../lib/crypto/identity-pin-store.js'),
        import('../lib/crypto/identity-pin.js'),
        import('../lib/crypto/identity-enforcement.js'),
        import('../lib/qr-scan.js'),
        import('qrcode-generator')
      ])

    const port = buildVerifyPort({ db, idStore, e2e, sn, pinStore, pin, enforce, qrScan, qrcode }, ctx, roomId)
    const host = document.createElement('div')
    host.className = 'island-host'
    root.appendChild(host)
    await mountIsland('verify', host, (mod) => mod.__mountVerify(port))
    return () => { port.teardown(); void unmountIsland() }
  } catch {
    ctx.toast('This screen could not load — turn the preview flag off to restore the classic screen')
    return null
  }
}

/** Legacy trustLine, as port data. */
function trustBanner (record, pin) {
  if (!record) return null
  if (record.state === pin.REVOKED) {
    return { warn: true, text: 'You marked this contact’s key as no longer trusted on this device.' }
  }
  if (record.state === pin.CHANGED) {
    return {
      warn: true,
      text: 'This contact is now publishing a DIFFERENT key from the one this device ' +
            'trusts. Spot Me has not adopted it. Verify in person before you accept it — ' +
            'a change you did not expect is what an interceptor looks like.'
    }
  }
  if (record.state === pin.VERIFIED) {
    return { warn: false, text: 'You have verified this contact’s key on this device.' }
  }
  return null
}

/** Legacy scanFailureText — a failure named precisely (a stale code and
 *  somebody else's key are different problems, only one alarming). */
function scanFailureText (SCAN_ERR, error, peerName) {
  switch (error) {
    case SCAN_ERR.WRONG_ROOM:
      return 'That code is for a different chat. Open this chat on both phones and try again.'
    case SCAN_ERR.EXPIRED:
      return 'That code has expired. Ask them to reopen this screen and scan the new one.'
    case SCAN_ERR.OLD_FORMAT:
      return 'That code was made by an older version of Spot Me. Ask them to update and try again.'
    case SCAN_ERR.WRONG_SAFETY_VERSION:
      return 'That code was made by a different version of Spot Me. Both phones need the same version.'
    case SCAN_ERR.WRONG_SELF_KEY:
      return 'That code is not for this device.'
    case SCAN_ERR.WRONG_PEER_KEY:
      return `That code does not carry the key this device has for ${peerName}. ` +
             'Do not send anything private until you have sorted out why.'
    case SCAN_ERR.DIGITS_DIFFER:
      return 'The codes do NOT match. Stop sending anything private and tell them on a ' +
             'different channel — this is what an interceptor looks like.'
    default:
      return 'That did not look like a Spot Me verification code.'
  }
}

/** Exported for tests; no flag read here (the single one is in reactVerify). */
export function buildVerifyPort ({ db, idStore, e2e, sn, pinStore, pin, enforce, qrScan, qrcode }, ctx, roomId) {
  const convo = db.convo(roomId)
  const me = db.profile()
  const peerName = convo?.peer?.name || 'this person'
  const peerId = convo?.peer?.id || ''

  let cancelled = false
  let qrTimer = null
  let scanner = null
  let overlay = null

  /* Port state — everything display-ready. */
  const state = {
    phase: 'loading',
    peerName,
    message: '',
    banner: null,
    changed: null,
    digits: '',
    qrUrl: null,
    scan: { available: qrScan.canScan(), status: '', scanning: false },
    footer: ''
  }
  if (!qrScan.canScan()) state.scan.status = qrScan.scanErrorMessage(qrScan.unavailableReason())

  let snap = null
  const listeners = new Set()
  const notify = () => { snap = null; for (const fn of listeners) fn() }

  /* Derivation inputs, held HERE only — never in the snapshot. */
  let selfKey = null
  let peerKey = null
  let digitsRaw = null
  let record = null

  const footerText = () => enforce.isEnforcing()
    ? 'Spot Me remembers a successful check on this device. If this contact’s key ' +
      'changes later, messages stop until you verify or accept the new one.'
    : 'Spot Me remembers a successful check on this device, and marks the chat if ' +
      'this contact’s key changes later. It does not yet stop you sending to a ' +
      'changed key — check here if anything looks wrong.'

  const changedNote = () => enforce.isEnforcing()
    ? 'Messages to this contact are not being sent until you choose.'
    : 'You can still send messages while you decide — they go to the key you ' +
      'already trusted, not the new one.'

  /** QR data URL — the encoded payload becomes an image URL and nothing else
   *  crosses the port (legacy paintQr, re-run on the expiry interval). */
  const paintQr = () => {
    if (cancelled) return
    try {
      const payload = sn.encodeVerificationPayload(
        { publicKeyB64: selfKey, userId: me.id },
        { publicKeyB64: peerKey, userId: peerId },
        { roomId, at: Date.now() }
      )
      const qr = qrcode(0, 'M')
      qr.addData(payload)
      qr.make()
      const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
      state.qrUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
    } catch {
      state.qrUrl = null
    }
    notify()
  }

  const applyRecord = () => {
    state.banner = trustBanner(record, pin)
    state.changed = record?.state === pin.CHANGED ? { note: changedNote() } : null
  }

  /* AFTER first paint, never during it (legacy rule 1): the shell mounts on
   * 'loading' before the 10,400 hashes start. */
  ;(async () => {
    if (!convo) {
      state.phase = 'missing'
      state.message = 'This conversation is no longer on this device.'
      notify()
      return
    }
    if (convo.e2eVersion !== e2e.E2E_V2) {
      state.phase = 'unverifiable'
      state.message =
        `There is nothing to verify for this chat. It was created before Spot Me ` +
        `agreed keys on the devices themselves, so its key comes from the two account ` +
        `IDs — which means the server can work it out. Start a new chat with ` +
        `${peerName} to get one that can be verified.`
      notify()
      return
    }
    try {
      const identity = await idStore.loadIdentity()
      if (cancelled) return
      if (!identity?.publicKey) throw new Error('no-identity')
      selfKey = await e2e.exportPublicKeyB64(identity)
      peerKey = convo.peerKey
      if (!peerKey) throw new Error('no-peer-key')

      digitsRaw = await sn.safetyNumber(
        { publicKeyB64: selfKey, userId: me.id },
        { publicKeyB64: peerKey, userId: peerId }
      )
      if (cancelled) return

      record = await pinStore.readRecord(peerId).catch(() => null)
      if (cancelled) return

      state.phase = 'ready'
      state.digits = sn.formatSafetyNumber(digitsRaw)
      state.footer = footerText()
      applyRecord()
      paintQr()
      qrTimer = setInterval(paintQr, QR_REFRESH_MS)
    } catch (error) {
      if (cancelled) return
      const why = String(error?.message)
      state.phase = 'error'
      state.message = why === 'no-peer-key'
        ? `Spot Me does not have ${peerName}’s key on this device yet, so there is ` +
          `nothing to compare. Open the chat, send a message, and try again.`
        : why === 'no-identity'
          ? 'This device could not load its own encryption key, so it cannot work out a ' +
            'safety number. That is the same fault the chat screen warns about.'
          : 'Could not work out a safety number on this device.'
      notify()
    }
  })()

  /** Legacy A5 settle: apply the decision to the record, refresh the room's
   *  verdict so the block does not outlive the decision that cleared it. */
  const settle = async (type, key) => {
    const out = await pinStore.applyToRecord(peerId, { type, at: Date.now(), key })
    if (cancelled) return
    if (!out.ok) {
      state.scan.status = 'That could not be saved. Check that Spot Me is allowed to store data here.'
      notify()
      return
    }
    enforce.setRoomTrust(roomId, out.next)
    record = out.next
    applyRecord()
    state.scan.status = type === pin.ACCEPT
      ? `Accepted. Spot Me will use ${peerName}’s new key — but nobody has checked it, ` +
        'so compare the digits below when you next get the chance.'
      : `Kept the key you already trusted. If ${peerName} really did change phones, ` +
        'their messages will not open until you accept the new key or verify it.'
    notify()
  }

  const closeScanOverlay = () => {
    scanner?.stop()
    scanner = null
    overlay?.remove()
    overlay = null
    state.scan.scanning = false
  }

  /** The camera lives in an app-side overlay — video/canvas never enter the
   *  package. Decode + payload verification are the legacy calls verbatim. */
  const startScan = async () => {
    if (state.scan.scanning || !qrScan.canScan() || state.phase !== 'ready') return
    state.scan.scanning = true
    state.scan.status = 'Point the camera at their code…'
    notify()
    overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:60'
    const video = document.createElement('video')
    video.style.cssText = 'width:100%;max-width:320px;border-radius:12px'
    const canvas = document.createElement('canvas')
    canvas.style.display = 'none'
    overlay.appendChild(video)
    overlay.appendChild(canvas)
    document.body.appendChild(overlay)
    scanner = await qrScan.startScanning({
      video,
      canvas,
      onError: (reason) => {
        closeScanOverlay()
        state.scan.status = qrScan.scanErrorMessage(reason)
        notify()
      },
      onResult: async (payload) => {
        closeScanOverlay()
        if (cancelled) return
        const out = await sn.verifyScannedPayload(payload, digitsRaw, {
          roomId, at: Date.now(), selfKey, peerKey
        })
        if (cancelled) return
        if (!out.match) {
          state.scan.status = scanFailureText(sn.SCAN_ERR, out.error, peerName)
          notify()
          return
        }
        /* Record the key that was ACTUALLY compared, never one re-read
         * afterwards — that gap is where a substitution would land. */
        const saved = await idStore.recordVerification(peerId, out.verifiedKey)
        if (cancelled) return
        if (saved.ok) { record = saved.next; applyRecord() }
        state.scan.status = saved.ok
          ? `Verified. Spot Me will remember this, and will tell you if ${peerName}’s key changes.`
          : 'The codes matched, but this device could not save that. Try again, or ' +
            'check that Spot Me is allowed to store data here.'
        notify()
      }
    })
  }

  return {
    subscribe (fn) { listeners.add(fn); return () => listeners.delete(fn) },
    snapshot () {
      if (!snap) {
        snap = {
          phase: state.phase,
          peerName: state.peerName,
          message: state.message,
          banner: state.banner,
          changed: state.changed,
          digits: state.digits,
          qrUrl: state.qrUrl,
          scan: { ...state.scan },
          footer: state.footer
        }
      }
      return snap
    },
    back: () => ctx.nav(`#/thread/${roomId}`),
    acceptNewKey: () => { if (record?.state === pin.CHANGED) void settle(pin.ACCEPT, record.proposedKey) },
    keepOldKey: () => { if (record?.state === pin.CHANGED) void settle(pin.REJECT) },
    startScan: () => { void startScan() },
    /** App-side teardown: the QR interval dies with the screen and the camera
     *  never outlives it (legacy teardown, same three handles). */
    teardown () {
      cancelled = true
      if (qrTimer) clearInterval(qrTimer)
      closeScanOverlay()
    }
  }
}
