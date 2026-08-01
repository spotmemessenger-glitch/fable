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
import { safetyNumber, formatSafetyNumber } from '../lib/crypto/safety-number.js'

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
    return () => { cancelled = true }
  }
  if (convo.e2eVersion !== E2E_V2) {
    body.appendChild(el('p', {
      text: `There is nothing to verify for this chat. It was created before Spot Me ` +
            `agreed keys on the devices themselves, so its key comes from the two account ` +
            `IDs — which means the server can work it out. Start a new chat with ` +
            `${peerName} to get one that can be verified.`
    }))
    return () => { cancelled = true }
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
      /* Said plainly rather than implied. This build checks, it does not
       * remember — and a screen that let someone believe otherwise would be
       * worse than one that says so. */
      body.appendChild(el('p', {
        class: 'gm-sub',
        text: 'Spot Me does not yet remember that you checked, and it will not warn you ' +
              'if these digits change later. Verify again if anything looks wrong.'
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

  return () => { cancelled = true }
}
