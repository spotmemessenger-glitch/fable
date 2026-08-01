/**
 * Spot Me — verify a conversation's keys.
 *
 * WHY THIS SCREEN EXISTS. ADR-001 stopped the server DERIVING a room key. It
 * did not stop the server HANDING OUT the public keys: `/api/v2/auth/keys/:id`
 * is the only source of a peer's. A compromised server answers with a key it
 * holds, agrees one room key with each side, relays between them, and reads
 * everything — while both clients display "encrypted" and every test passes.
 *
 * The only defence is two people comparing something out of band. This is that
 * screen. ADR-003 has the construction and its limits.
 *
 * THREE THINGS THIS SCREEN MUST NOT DO, each of which is easy to do by accident:
 *
 *   1. Compute on the render path. A safety number is 10,400 SHA-512s —
 *      measured at ~750 ms on a desktop and slower on a phone. Deriving it
 *      during paint would freeze the open. It is derived after first paint,
 *      behind a spinner.
 *   2. Claim more than it can. A number proves the two devices agree on two
 *      public keys AT THIS MOMENT. It is not a promise about the past, and this
 *      build does not remember that you checked.
 *   3. Show a blank for `e2e_v1`. Those rooms have no per-device identity, so
 *      there is nothing to compare — and that is exactly the rooms whose keys
 *      the server CAN recompute. Saying so plainly is the honest answer;
 *      showing an empty panel would read as "nothing to worry about".
 */
import './groups.css'
import { el } from '../lib/ui.js'
import { db } from '../lib/db.js'
import { loadIdentity } from '../lib/crypto/identity-store.js'
import { exportPublicKeyB64, E2E_V2 } from '../lib/crypto/e2e-v2.js'
import {
  safetyNumber, formatSafetyNumber, encodeVerificationPayload,
  verifyScannedPayload, SCAN_ERR
} from '../lib/crypto/safety-number.js'
import { readRecord } from '../lib/crypto/identity-pin-store.js'
import { recordVerification } from '../lib/crypto/identity-store.js'
import { VERIFIED, CHANGED, REVOKED } from '../lib/crypto/identity-pin.js'
import { canScan, unavailableReason, scanErrorMessage, startScanning } from '../lib/qr-scan.js'
import qrcode from 'qrcode-generator'

/**
 * A QR is a picture of a string, and that string EXPIRES.
 *
 * The v2 payload carries an issue time and is refused after
 * PAYLOAD_MAX_AGE_MS, so a code rendered once and left on screen becomes
 * unscannable while still looking perfectly valid. Re-rendering on an interval
 * is what stops "it just says expired" being the normal experience for anyone
 * who opens this screen and then goes to find the other person.
 */
const QR_REFRESH_MS = 60_000

/** Render a payload as an SVG QR. Error-correction 'M' and the smallest type
 *  that fits — `0` asks the library to choose. */
function qrSvg (payload) {
  const qr = qrcode(0, 'M')
  qr.addData(payload)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
}

/** A scan that did not verify, said in a way that names the actual problem.
 *  A single "that didn't work" would hide the difference between a stale code
 *  and somebody else's key, and only one of those is alarming. */
function scanFailureText (error, peerName) {
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

/** What the stored trust state should say on this screen. */
function trustLine (record) {
  if (!record) return null
  if (record.state === REVOKED) {
    return { cls: 'sys warn', text: 'You marked this contact’s key as no longer trusted on this device.' }
  }
  if (record.state === CHANGED) {
    return {
      cls: 'sys warn',
      text: 'This contact is now publishing a DIFFERENT key from the one this device ' +
            'trusts. Spot Me has not adopted it. Verify in person before you accept it — ' +
            'a change you did not expect is what an interceptor looks like.'
    }
  }
  if (record.state === VERIFIED) {
    return { cls: 'gm-sub', text: 'You have verified this contact’s key on this device.' }
  }
  return null
}

/* Derivation is expensive and the inputs never change for a given pair of keys,
 * so a reopen is instant. Keyed by the two keys rather than the room: if either
 * side's key is ever substituted the cache key changes with it, which is the
 * one case where a stale number would be actively dangerous. */
const cache = new Map()

async function numberFor (selfKey, selfId, peerKey, peerId) {
  const cacheKey = `${selfKey}|${peerKey}`
  if (!cache.has(cacheKey)) {
    cache.set(cacheKey, safetyNumber(
      { publicKeyB64: selfKey, userId: selfId },
      { publicKeyB64: peerKey, userId: peerId }
    ))
  }
  return cache.get(cacheKey)
}

export function render (root, ctx, roomId) {
  const convo = db.convo(roomId)
  const me = db.profile()
  const peerName = convo?.peer?.name || 'this person'
  let cancelled = false
  /* Both must be torn down when the screen closes: a live interval keeps
   * redrawing a detached node, and a live scanner keeps the camera on. */
  let qrTimer = null
  let scanner = null
  /* ONE teardown, returned from every exit. The early returns below currently
   * happen before either handle exists, so sharing this changes nothing today —
   * which is the point: the next person to add a timer above them does not have
   * to notice that there are three ways out of this function. */
  const teardown = () => {
    cancelled = true
    if (qrTimer) clearInterval(qrTimer)
    scanner?.stop()
  }

  /* Same shell as group-manage.js: a `bar` with a back button, an `h1`, and a
   * `scroll-y` body. Reusing those classes rather than inventing new ones means
   * this screen inherits the app's existing layout instead of needing a
   * stylesheet of its own. */
  const body = el('div', { class: 'vf-body' })
  root.appendChild(el('div', { class: 'v-groups' }, [
    el('div', { class: 'bar' }, [
      el('button', {
        class: 'gm-back', type: 'button', 'aria-label': 'Back',
        onclick: () => ctx.nav(`#/thread/${roomId}`)
      }, ['\u2039']),
      el('span', { class: 'sp' })
    ]),
    el('h1', { class: 'h1', text: 'Verify encryption' }),
    el('div', { class: 'scroll-y' }, [body])
  ]))

  /* A room that never had a device identity has nothing to compare. Said in
   * full rather than hidden: these are precisely the rooms whose key the server
   * can recompute, so an empty screen would be the most misleading option. */
  if (!convo) {
    body.appendChild(el('p', { class: 'gm-sub', text: 'This conversation is no longer on this device.' }))
    return teardown
  }
  if (convo.e2eVersion !== E2E_V2) {
    body.appendChild(el('p', {
      text: `There is nothing to verify for this chat. It was created before Spot Me ` +
            `agreed keys on the devices themselves, so its key comes from the two account ` +
            `IDs — which means the server can work it out. Start a new chat with ` +
            `${peerName} to get one that can be verified.`
    }))
    return teardown
  }

  const spinner = el('p', { class: 'gm-sub', text: 'Working out this chat’s safety number…' })
  body.appendChild(spinner)

  /* AFTER first paint, never during it. The screen is on the glass with its
   * spinner before the 10,400 hashes start. */
  ;(async () => {
    try {
      const identity = await loadIdentity()
      if (cancelled) return
      if (!identity?.publicKey) throw new Error('no-identity')
      const selfKey = await exportPublicKeyB64(identity)
      const peerKey = convo.peerKey
      if (!peerKey) throw new Error('no-peer-key')

      const digits = await numberFor(selfKey, me.id, peerKey, convo.peer?.id || '')
      if (cancelled) return

      spinner.remove()
      const peerId = convo.peer?.id || ''

      /* THE STORED ANSWER, SHOWN FIRST. Until A4 this screen could only ever
       * say "compare these"; the trust record now survives a reload, so the
       * first thing someone sees is where they already got to. */
      const record = await readRecord(peerId).catch(() => null)
      const line = trustLine(record)
      if (line) body.appendChild(el('div', { class: line.cls }, [line.text]))

      body.appendChild(el('p', {
        text: `Compare these 60 digits with ${peerName}, out loud or on another app you ` +
              `already trust. If they match on both phones, no one is sitting in the middle ` +
              `of this conversation.`
      }))
      body.appendChild(el('div', { class: 'safety-number', text: formatSafetyNumber(digits) }))
      body.appendChild(el('p', {
        class: 'gm-sub',
        text: 'If they do not match, stop sending anything private and tell them on a ' +
              'different channel. A mismatch means the two phones disagree about each ' +
              'other’s keys, which is what an interceptor looks like.'
      }))

      /* ------------------------------------------------------- the code --- */

      const qrBox = el('div', { class: 'vf-qr', style: 'max-width:260px;margin:16px auto' })
      body.appendChild(el('p', {
        class: 'gm-sub',
        text: 'Or scan each other’s codes — faster than reading digits, and it checks the ' +
              'same two keys.'
      }))
      body.appendChild(qrBox)

      /* Re-rendered on a timer: the payload expires, and a code that has gone
       * stale on screen looks identical to one that has not. */
      const paintQr = () => {
        if (cancelled) return
        try {
          qrBox.innerHTML = qrSvg(encodeVerificationPayload(
            { publicKeyB64: selfKey, userId: me.id },
            { publicKeyB64: peerKey, userId: peerId },
            { roomId, at: Date.now() }
          ))
        } catch { qrBox.textContent = 'Could not draw this device’s code.' }
      }
      paintQr()
      qrTimer = setInterval(paintQr, QR_REFRESH_MS)

      /* ------------------------------------------------------- scanning --- */

      const status = el('p', { class: 'gm-sub' })
      const video = el('video', { style: 'width:100%;max-width:320px;border-radius:12px;display:none' })
      const canvas = el('canvas', { style: 'display:none' })
      const scanBtn = el('button', { class: 'btn', type: 'button' }, ['Scan their code'])
      body.appendChild(scanBtn)
      body.appendChild(video)
      body.appendChild(canvas)
      body.appendChild(status)

      if (!canScan()) {
        scanBtn.disabled = true
        status.textContent = scanErrorMessage(unavailableReason())
      }

      scanBtn.onclick = async () => {
        scanBtn.disabled = true
        video.style.display = 'block'
        status.textContent = 'Point the camera at their code…'
        scanner = await startScanning({
          video,
          canvas,
          onError: (reason) => {
            video.style.display = 'none'
            scanBtn.disabled = false
            status.textContent = scanErrorMessage(reason)
          },
          onResult: async (payload) => {
            video.style.display = 'none'
            scanBtn.disabled = false
            if (cancelled) return
            /* The context is what makes the scan mean something: the code must
             * name THIS conversation, be fresh, and name the two keys this
             * device is actually using. verifyScannedPayload checks all of that
             * BEFORE comparing digits — see safety-number.js. */
            const out = await verifyScannedPayload(payload, digits, {
              roomId, at: Date.now(), selfKey, peerKey
            })
            if (cancelled) return
            if (!out.match) { status.textContent = scanFailureText(out.error, peerName); return }

            /* Record the key that was ACTUALLY compared, never one re-read
             * afterwards — that gap is where a substitution would land. */
            const saved = await recordVerification(peerId, out.verifiedKey)
            if (cancelled) return
            status.textContent = saved.ok
              ? `Verified. Spot Me will remember this, and will tell you if ${peerName}’s key changes.`
              : 'The codes matched, but this device could not save that. Try again, or ' +
                'check that Spot Me is allowed to store data here.'
            if (saved.ok) {
              const fresh = trustLine(saved.next)
              if (fresh) body.insertBefore(el('div', { class: fresh.cls }, [fresh.text]), body.firstChild)
            }
          }
        })
      }

      /* CORRECTED, and it used to say the opposite. Before A1-A4 this screen
       * ended with "Spot Me does not yet remember that you checked, and it will
       * not warn you if these digits change later" — true when written, and
       * false now that the trust record persists and a changed key is detected.
       * What is still true is the last part: detection is not yet a block. */
      body.appendChild(el('p', {
        class: 'gm-sub',
        text: 'Spot Me remembers a successful check on this device, and marks the chat if ' +
              'this contact’s key changes later. It does not yet stop you sending to a ' +
              'changed key — check here if anything looks wrong.'
      }))
    } catch (error) {
      if (cancelled) return
      spinner.remove()
      const why = String(error?.message)
      body.appendChild(el('p', {
        text: why === 'no-peer-key'
          ? `Spot Me does not have ${peerName}’s key on this device yet, so there is ` +
            `nothing to compare. Open the chat, send a message, and try again.`
          : why === 'no-identity'
            ? 'This device could not load its own encryption key, so it cannot work out a ' +
              'safety number. That is the same fault the chat screen warns about.'
            : 'Could not work out a safety number on this device.'
      }))
    }
  })()

  return teardown
}
