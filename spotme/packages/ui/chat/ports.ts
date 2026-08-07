/**
 * Chat — ports (final slice, behind spotme.ui.chat).
 *
 * SESSION 1: message list + composer core — text send, day dividers, status
 * ticks, typing line, retry of a failed text.
 * SESSION 2 (this file's additions): display-ready media rows (photo,
 * view-once locked tile, voice, file, location), the attach sheet, the
 * long-press message sheet (reply / edit / delete / react / copy), reaction
 * chips, and reply composition. Calls, translation composer modes, live
 * location sharing UI, group management and crypto-facing UI are LATER
 * sessions and have no port surface here.
 *
 * Display-ready by construction: the app-side adapter (views/chat-island*.js)
 * pre-shapes every row — mine/theirs resolved, timestamps formatted, the
 * Read/Sent/Not delivered verdict already decided from conn.readUpTo, media
 * as URLs/labels (never blobs, never File, never canvas) — so this package
 * never sees the message store, room keys, the transport, or the network.
 * A view-once row NEVER carries the photo bytes: only the sender-made 16px
 * mask thumbnail rides in `media.maskUrl`; the reveal is entirely app-side
 * behind `openViewOnce`. Every mutation is a callback into the same
 * lib/rooms.js the legacy view uses (the engine is REUSED, never rewritten),
 * which keeps the ADR-035 §(g) no-persisted-shape rule trivially true here.
 *
 * The contract these rows encode is pinned by
 * apps/web/test/chat-characterization.test.js (status/day-divider grammar,
 * replyTo riding the envelope, reactions aggregating on the target) and
 * apps/web/test/chat-viewonce-react.test.js (view-once burn semantics).
 */

export type MessageStatus = 'sent' | 'read' | 'failed';

/** Display-ready media payloads. URLs and labels only — the adapter owns
 *  every blob/File/canvas/audio API. */
export type MediaView =
  | { type: 'photo'; url: string; caption: string }
  | { type: 'viewOnce'; maskUrl: string | null; label: string; chip: string }
  | { type: 'viewOnceMine'; label: string; chip: string; opened: boolean }
  | { type: 'voice'; url: string; durLabel: string }
  | { type: 'video'; url: string; caption: string }
  | { type: 'file'; url: string | null; name: string; sizeLabel: string }
  | { type: 'location'; mapUrl: string | null; label: string; live: boolean };

export interface ReactionChip {
  emoji: string;
  count: number;
}

/** SESSION 3 — composer language modes (translation / transliteration).
 *  Everything is display-ready strings shaped app-side: the engines
 *  (lib/translate.js, spotme-core/core/translit.js) NEVER enter this package.
 *  The preview mirrors the legacy tlprev panel: tag line, hero line, sub. */
export interface ComposerPreview {
  tag: string;
  main: string;
  /** 'Detected Tamil (romanized)' — empty string hides the line. */
  sub: string;
}

export interface ComposerView {
  /** Which feature owns the composer (legacy composeMode). */
  mode: 'translate' | 'translit' | null;
  translateOn: boolean;
  translitOn: boolean;
  /** 'Tamil' — the 🌐 target chip label. */
  translateLangLabel: string;
  /** 'Auto' or a pinned language — the 文A ▾ chip label. */
  translitLangLabel: string;
  preview: ComposerPreview | null;
}

/** Incoming-message reading line (legacy .tr block): 'Tamil · Translated' +
 *  the translated text, or 'Translating…' + '…' while pending. */
export interface TranslationLine {
  tag: string;
  text: string;
  pending: boolean;
}

export interface MessageRowView {
  /** Message id — opaque handle for retry/keying, never displayed. */
  id: string;
  mine: boolean;
  /** 'media' rows carry `media`; kinds without a session yet arrive as a
   *  stub label ("Video") until theirs lands. */
  kind: 'text' | 'system' | 'stub' | 'media';
  text: string;
  /** Sender display name — shown on their rows in groups. */
  name: string;
  showName: boolean;
  /** Already formatted (legacy fmtTime). */
  timeLabel: string;
  /** Groups rows under one divider (legacy: toDateString()). */
  dayKey: string;
  /** 'Today' or the legacy fmtDay label. */
  dayLabel: string;
  /** Only meaningful on mine — the tick line. */
  status: MessageStatus;
  edited: boolean;
  /** Quoted preview when this row replies to another; null otherwise. */
  replyPreview: { name: string; text: string } | null;
  /** Aggregated reaction chips (legacy renderReacts grammar: emoji, or
   *  "emoji N" when N > 1). Empty array hides the strip. */
  reactions: ReactionChip[];
  /** Only the author rewrites their own words, and only plain text. */
  canEdit: boolean;
  /** What Copy puts on the clipboard; null hides the Copy item. */
  copyText: string | null;
  /** Present exactly when kind === 'media'. */
  media?: MediaView;
  /** SESSION 3 — Forward/Share appear in the sheet only when true (legacy:
   *  never view-once/burst, and only text/location/fetched media). */
  canForward?: boolean;
  /** SESSION 3 — incoming reading line; absent/null hides it. */
  translation?: TranslationLine | null;
}

/** SESSION 4 — crypto-facing system lines, as finished sentences shaped
 *  app-side (views/chat-island-crypto.js): the encryption claim, the Verify
 *  entry point (v2 rooms only), and the undecryptable / device-key warning.
 *  No key material, no identity objects — display strings only. */
export interface SecurityView {
  /** The first-run encryption claim line (legacy sysLine). */
  sysText: string;
  /** v2 rooms only — shows the Verify link on the claim line. */
  canVerify: boolean;
  /** Undecryptable-room or device-key warning banner; null hides it. */
  warnText: string | null;
}

export interface ChatSnapshot {
  header: { name: string; presenceLabel: string; avatarUrl: string | null };
  rows: MessageRowView[];
  /** "Peer is typing…" line; empty string hides it. */
  typingLabel: string;
  /** "0:07" while a voice note records; empty string = not recording. */
  recordingLabel: string;
  /** SESSION 3 — absent hides every language control (old adapters and
   *  fixtures keep working untouched). */
  composer?: ComposerView;
  /** SESSION 4 — absent hides the crypto lines (old adapters/fixtures keep
   *  working untouched). */
  security?: SecurityView;
}

export interface ChatPort {
  subscribe(fn: () => void): () => void;
  /** MUST return a cached object, invalidated on notify (useSyncExternalStore). */
  snapshot(): ChatSnapshot;

  /** Send a text draft; replyToId rides the envelope as replyTo (the
   *  characterization suite pins it travelling untouched). */
  sendText(text: string, replyToId?: string): void;
  /** Retry a failed text (rooms.retryMessage). */
  retry(id: string): void;
  /** The thread is visible — clear unread + send the receipt. */
  markRead(): void;
  /** Composer activity for the peer's typing indicator. */
  setTyping(on: boolean): void;

  /** Message-sheet mutations — each routes to the same rooms.* call the
   *  legacy sheet makes. */
  react(id: string, emoji: string): void;
  editText(id: string, text: string): void;
  deleteMessage(id: string, forEveryone: boolean): void;
  copy(text: string): void;

  /** Fullscreen photo viewer — app-side overlay. */
  openPhoto(id: string): void;
  /** Spend the one view. The adapter burns FIRST (rooms.viewOnceOpen), then
   *  reveals from a function-scoped copy — bytes never enter this package. */
  openViewOnce(id: string): void;

  /** Attach-sheet entries. Pickers, geolocation and recording are app-side;
   *  each resolves into a rooms.sendMessage/sendAttachment over there. */
  attachPhoto(viewOnce: boolean): void;
  attachFile(): void;
  attachLocation(): void;
  /** Tap starts recording, tap again stops-and-sends (recordingLabel in the
   *  snapshot tracks the session). */
  toggleVoiceRecord(): void;

  /* SESSION 3 — all optional, so session-2 adapters/fixtures stay valid.
   * The composer modes drive lib/translate.js + the translit engine APP-SIDE;
   * this package only ever calls these and reads snapshot strings. */
  /** Every keystroke's trimmed draft — the adapter debounces the engines and
   *  pushes the resulting preview into snapshot().composer.preview. */
  draftChanged?(text: string): void;
  /** 🌐 switch — one tap on/off, never opens a list (legacy trBtn). */
  toggleTranslate?(): void;
  /** 🌐 chip — app-side language action sheet (legacy trChip). */
  pickTranslateLang?(): void;
  /** 文A switch — whole-chat transliteration on/off (legacy txBtn). */
  toggleTranslit?(): void;
  /** 文A ▾ chip — Auto-detect + pinned languages (legacy xlitChip). */
  pickTranslitLang?(): void;
  /** Forward stays inside Spot Me — app-side conversation picker + the same
   *  clone-send the legacy forwardTo makes. */
  forward?(id: string): void;
  /** Share hands the message to the OS share sheet (app-side). */
  share?(id: string): void;

  /** SESSION 4 — the safety-number entry point: routes to the verify screen
   *  (legacy: ctx.nav('#/verify/<roomId>')). Optional so session-2/3
   *  adapters and fixtures stay valid. */
  openVerify?(): void;

  back(): void;
  toast(msg: string): void;
}

/** Fixture port for tests. */
export function fixtureChatPort(
  rows?: MessageRowView[],
): ChatPort & { calls: string[]; setSnapshot: (next: ChatSnapshot) => void } {
  const row = (over: Partial<MessageRowView>): MessageRowView => ({
    id: 'm1', mine: false, kind: 'text', text: 'hello', name: 'Asha', showName: false,
    timeLabel: '10:02', dayKey: 'today', dayLabel: 'Today', status: 'sent',
    edited: false, replyPreview: null, reactions: [], canEdit: false,
    copyText: 'hello', ...over,
  });
  let snap: ChatSnapshot = {
    header: { name: 'Asha', presenceLabel: 'Online', avatarUrl: null },
    rows: rows ?? [
      row({ id: 'm0', text: 'yesterday says hi', dayKey: 'yest', dayLabel: 'Mon' }),
      row({ id: 'm1', text: 'vanakkam', copyText: 'vanakkam', reactions: [{ emoji: '❤️', count: 2 }, { emoji: '👍', count: 1 }] }),
      row({ id: 'm2', mine: true, text: 'hi!', status: 'read', timeLabel: '10:03', canEdit: true, copyText: 'hi!' }),
      row({ id: 'm3', mine: true, text: 'still there?', status: 'sent', timeLabel: '10:04', edited: true, canEdit: true }),
      row({ id: 'm4', mine: true, text: 'this one died', status: 'failed', timeLabel: '10:05', canEdit: true }),
      row({ id: 'm5', kind: 'system', text: '⏱ Timer messages on', copyText: null }),
      row({
        id: 'm6', text: 'replying to you', timeLabel: '10:06',
        replyPreview: { name: 'Me', text: 'hi!' },
      }),
    ],
    typingLabel: '',
    recordingLabel: '',
  };
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  const notify = () => { for (const fn of listeners) fn(); };
  const port = {
    calls,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    snapshot: () => snap,
    sendText: (t: string, replyToId?: string) => {
      calls.push(replyToId ? `send:${t}:replyTo=${replyToId}` : `send:${t}`);
      snap = {
        ...snap,
        rows: [...snap.rows, row({ id: `s${calls.length}`, mine: true, text: t, dayKey: 'today', dayLabel: 'Today' })],
      };
      notify();
    },
    retry: (id: string) => calls.push(`retry:${id}`),
    markRead: () => calls.push('markRead'),
    setTyping: (on: boolean) => calls.push(`typing:${on}`),
    react: (id: string, emoji: string) => calls.push(`react:${id}:${emoji}`),
    editText: (id: string, text: string) => calls.push(`edit:${id}:${text}`),
    deleteMessage: (id: string, forEveryone: boolean) => calls.push(`delete:${id}:${forEveryone}`),
    copy: (text: string) => calls.push(`copy:${text}`),
    openPhoto: (id: string) => calls.push(`openPhoto:${id}`),
    openViewOnce: (id: string) => calls.push(`openViewOnce:${id}`),
    attachPhoto: (viewOnce: boolean) => calls.push(`attachPhoto:${viewOnce}`),
    attachFile: () => calls.push('attachFile'),
    attachLocation: () => calls.push('attachLocation'),
    toggleVoiceRecord: () => calls.push('voiceRecord'),
    draftChanged: (t: string) => calls.push(`draft:${t}`),
    toggleTranslate: () => calls.push('toggleTranslate'),
    pickTranslateLang: () => calls.push('pickTranslateLang'),
    toggleTranslit: () => calls.push('toggleTranslit'),
    pickTranslitLang: () => calls.push('pickTranslitLang'),
    forward: (id: string) => calls.push(`forward:${id}`),
    share: (id: string) => calls.push(`share:${id}`),
    openVerify: () => calls.push('openVerify'),
    back: () => calls.push('back'),
    toast: (m: string) => calls.push(`toast:${m}`),
    /** Test hook: replace the snapshot and notify (session-3 tests drive the
     *  composer state through this). */
    setSnapshot (next: ChatSnapshot) { snap = next; notify(); },
  };
  return port;
}
