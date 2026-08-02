/**
 * The presence seam (design §3.4, §11.3). A notification is only worth sending to
 * a recipient who is NOT already looking at a live socket — the shipped gateway
 * already excludes connected users, and the HTTP publish proxy needs the SAME
 * exclusion so the two producers never disagree.
 *
 * `PresencePort` is that one shared question ("who is connected right now?"),
 * injected so both the socket gateway and the Centrifugo/HTTP publish path can
 * answer it identically. It is OPTIONAL: a producer handed an already-filtered
 * recipient list (as the gateway does) needs no port; a producer without its own
 * presence view uses the port to filter.
 */
export const PRESENCE_PORT = 'NOTIF_PRESENCE_PORT';

export interface PresencePort {
  /** The set of userIds with at least one live socket anywhere (need no push). */
  connectedUsers(): Set<string> | Promise<Set<string>>;
}
