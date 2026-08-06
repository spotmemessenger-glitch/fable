/**
 * Is this user allowed in this direct-message room?
 *
 * THE HOLE THIS CLOSES. A DM room id is a pure function of two PUBLIC user ids:
 *
 *   roomId = `dm-${cyrb53('spotme-dm-room-v1:' + [a, b].sort().join(':'))}`
 *
 * and `onJoin` authorised DMs with nothing at all — `policy()` returns null for
 * anything that is not a group, and only `policy?.banned` was checked. So any
 * authenticated user who learned two user ids (username search returns them)
 * could compute the room id, join, and receive `replay(roomId, 0)` — the entire
 * stored history of a conversation they are not part of.
 *
 * Four things followed from that single join:
 *   - the whole ciphertext history, replayed on request;
 *   - for an `e2e_v1` room, the PLAINTEXT — its key is
 *     `cyrb53('spotme-dm-secret-v1:' + same two ids)`, derivable from exactly
 *     the same public inputs (ADR-001 is explicit that v1 keys are recomputable);
 *   - enrolment: `push.remember(roomId, userId)` writes a `RoomMember` row, so
 *     the intruder then received push notifications tagged with that roomId — a
 *     live feed of when the conversation was active;
 *   - the ability to SEND into the room, because `onAction` skips its refusal
 *     block entirely when `policy` is null.
 *
 * THE FIX, AND WHY IT IS SHAPED THIS WAY. The room id is derived from BOTH
 * participants, so it is self-authenticating: a caller can only produce a room
 * id that contains their own id. The server therefore recomputes it from the
 * AUTHENTICATED user plus the peer the caller claims, and compares. An attacker
 * cannot forge a room id for a pair they are not in, because their own id is an
 * input to the hash they would have to invert.
 *
 * No new state, no migration, and nothing here can lock a legitimate user out
 * of a room they can already derive client-side.
 */

/**
 * cyrb53, ported EXACTLY from `web/src/lib/reach.js:72`.
 *
 * This must agree with the client bit for bit. If it drifts, every DM join is
 * refused and the app looks completely broken — so `dm-room.spec.ts` fuzzes
 * both implementations against each other rather than trusting a handful of
 * fixed vectors.
 *
 * `Math.imul` is not an optimisation here: it is the only way to get JavaScript's
 * 32-bit multiply-with-overflow semantics, and plain `*` silently produces
 * different values for the same input.
 */
export function stableHash(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** The room id two users share, exactly as `directRoom()` builds it client-side. */
export function deriveDmRoomId(idA: string, idB: string): string {
  const [a, b] = [idA, idB].sort();
  return `dm-${stableHash(`spotme-dm-room-v1:${a}:${b}`)}`;
}

/**
 * Only `dm-` rooms get this treatment.
 *
 * Groups are already authorised by `policyFor`, and inbox rooms (`inbox-…`) are
 * derived from ONE id — the owner's — so a sender must be able to reach a room
 * that is not "theirs" by this rule. Applying the pair check to an inbox room
 * would break every knock.
 */
export const isDmRoom = (roomId: string): boolean => roomId.startsWith('dm-');

export type DmJoinVerdict =
  | { allow: true; reason: 'not-a-dm' | 'derived' | 'existing-member' }
  | { allow: false; reason: 'peer-mismatch' | 'stranger' };

/**
 * @param roomId       the room being joined
 * @param userId       the AUTHENTICATED caller — never taken from the payload
 * @param claimedPeer  who the caller says the other participant is (optional:
 *                     clients older than this change do not send it)
 * @param isKnownMember whether a `RoomMember` row already exists for this pair
 *
 * A caller that supplies a peer is held to it. A caller that supplies none
 * falls back to prior membership, so a client on an older bundle keeps working
 * in rooms it already belongs to while a stranger is refused.
 *
 * THE LIMIT OF THE FALLBACK, STATED PLAINLY: `RoomMember` rows were written BY
 * joining, which is the very thing that was unguarded. Anyone who already
 * exploited this is therefore grandfathered in by `existing-member`, and no
 * server-side check can distinguish those rows from legitimate ones. Closing
 * that needs the fallback removed once clients have rolled over — which is safe
 * to do precisely because the `derived` path needs no stored state.
 */
export function verifyDmJoin(
  roomId: string,
  userId: string,
  claimedPeer: string | undefined,
  isKnownMember: boolean,
): DmJoinVerdict {
  if (!isDmRoom(roomId)) return { allow: true, reason: 'not-a-dm' };
  if (claimedPeer) {
    return deriveDmRoomId(userId, claimedPeer) === roomId
      ? { allow: true, reason: 'derived' }
      : { allow: false, reason: 'peer-mismatch' };
  }
  return isKnownMember
    ? { allow: true, reason: 'existing-member' }
    : { allow: false, reason: 'stranger' };
}
