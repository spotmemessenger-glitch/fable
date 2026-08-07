/**
 * Chat island — crypto-facing display strings (ADR-035 final slice, session 4).
 *
 * The ONE adapter file allowed to touch lib/crypto, and only to READ status:
 * identityStatus() returns a state word ('ok' | 'ephemeral' | 'unavailable' |
 * 'unknown'), never key material. Everything leaves this file as finished
 * sentences — the package renders strings and cannot tell them from any other
 * copy (the ADR-008 §12 hard stop is untouched: nothing here generates,
 * persists, or publishes anything).
 *
 * The sentences are the LEGACY sentences, verbatim (chat.js sysLine /
 * keyWarning), pinned by apps/web/test/chat-crypto-react.test.js. The
 * undecryptable state machine (wrong-key may upgrade no-key, an incoming
 * message clears) lives in chat-island-port.js, which passes the reason in.
 */
import { identityStatus } from '../lib/crypto/identity-store.js'

/**
 * @param {{ e2eVersion?: string, undecryptableReason: string | null,
 *   peerName?: string }} state
 * @returns {{ sysText: string, canVerify: boolean, warnText: string | null }}
 */
export function buildSecurityView ({ e2eVersion, undecryptableReason, peerName }) {
  const v2 = e2eVersion === 'e2e_v2'
  const sysText = v2
    /* "Messages", not a bare "Encrypted": calls are NOT end-to-end encrypted
     * (ADR-004) and an unqualified claim would be read as covering them. */
    ? 'Messages are encrypted with keys made on your devices. Translation runs on-device when possible.'
    : 'Older chat — its key came from both account IDs, so the server could read it.'

  let warnText = null
  if (v2 && undecryptableReason) {
    /* F2 (owner decision): NEVER tell someone to delete a conversation. */
    warnText = undecryptableReason === 'wrong-key'
      ? (peerName || 'The other person') + '’s security key changed — ' +
        'reconnecting automatically. New messages will open in a moment; ' +
        'you can check the connection under Verify.'
      : 'Messages are arriving but this device can’t unlock them yet. ' +
        'Check your connection and reopen the chat — it often clears on its own.'
  } else if (v2) {
    /* Only 'ephemeral' and 'unavailable' warn — 'unknown' would fire on every
     * cold open of a healthy device (legacy keyWarning). */
    const state = identityStatus()
    if (state === 'ephemeral') {
      warnText = 'This device can’t save its encryption key, so the other person can’t read what you send here. Reloading won’t fix it.'
    } else if (state === 'unavailable') {
      warnText = 'This device can’t store encryption keys at all — private browsing is the usual cause. Open Spot Me in a normal window.'
    }
  }
  return { sysText, canVerify: v2, warnText }
}
