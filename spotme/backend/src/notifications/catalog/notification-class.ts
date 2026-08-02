/**
 * The typed vocabulary of the notification platform.
 *
 * A NOTIFICATION NEVER CARRIES MESSAGE CONTENT. These types describe *routing
 * and presentation policy* only — priority, collapse behaviour, TTL, the deep
 * link, the default user-preference level. There is deliberately no `content`
 * or `body-from-message` field anywhere in this file or the catalog: a push
 * says "something arrived, from whom", never what (ADR-001 / ADR-009).
 */

/** Every event class the platform can produce. Adding one = a catalog entry. */
export const NOTIFICATION_CLASSES = [
  'message',
  'knock', // chat request
  'call',
  'mention',
  'group', // join / leave / role
  'story',
  'security', // login / new-device / security alerts
  'login',
  'verification',
  'silent', // data-only prefetch (badge counts, key fetch) — no UI
] as const;

export type NotificationClass = (typeof NOTIFICATION_CLASSES)[number];

/**
 * Priority class → maps to per-transport provider params (see priority-map.ts).
 * `max` is reserved for calls (may pierce DND per prefs); `silent` renders no UI.
 */
export type NotificationPriority = 'max' | 'high' | 'normal' | 'low' | 'silent';

/**
 * How the provider folds repeats into a single tray entry.
 * - `per-room`     — one line per conversation (messages, mentions, group)
 * - `per-actor`    — one line per requester/author (knock, story)
 * - `never`        — a ringing call is not a "3 missed" summary
 * - `singleton`    — one line for the whole class (security/verification)
 */
export type CollapseStrategy = 'per-room' | 'per-actor' | 'never' | 'singleton';

/** The user-preference level at which a class is delivered by default. */
export type PreferenceLevel = 'all' | 'mentions' | 'none';

/** Notification channel (Android channel / iOS category / grouping label). */
export type NotificationChannel =
  | 'messages'
  | 'calls'
  | 'social'
  | 'security'
  | 'silent';

/** The immutable policy the catalog holds for one class. */
export interface NotificationPolicy {
  readonly class: NotificationClass;
  readonly priority: NotificationPriority;
  readonly collapse: CollapseStrategy;
  readonly channel: NotificationChannel;
  /** Time-to-live in seconds; the provider drops a stale push past this. */
  readonly ttlSeconds: number;
  /**
   * The GENERIC, content-free title/body. `{actor}` is the only interpolation
   * and it is display identity the server already knows (room membership) —
   * never message text.
   */
  readonly titleTemplate: string;
  readonly fallbackBody: string;
  /** Deep-link route template; `:room` / `:actor` / `:call` are filled locally. */
  readonly route: string;
  /** The minimum preference level at which this class still fires. */
  readonly minLevel: PreferenceLevel;
  /** May this class pierce Do-Not-Disturb when the user allows it? (calls only) */
  readonly canPierceDnd: boolean;
  /** Whether this class ships enabled-as-today by default (message/knock). */
  readonly defaultEnabled: boolean;
}
