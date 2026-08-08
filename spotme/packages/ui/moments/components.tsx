/**
 * Nearby Moments UI components (Phase 5D) — pure, prop-driven, accessible.
 * URLs in user text are UNTRUSTED (M6): rendered as inert text, never a link,
 * never fetched or unfurled. No engagement counters exist anywhere. No age or
 * gender control exists (A3).
 */

import { useState } from 'react';
import type { MomentView, MomentReaction, MomentVisibility, StoryView } from './ports';
import { MOMENT_REACTIONS } from './ports';

const URL_TOKEN = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;

/** Render user text with URLs INERT: plain marked spans, no <a>, no fetch (M6). */
export function UntrustedText(props: { text: string }) {
  const parts = props.text.split(URL_TOKEN);
  return (
    <span>
      {parts.map((p, i) =>
        URL_TOKEN.test(p) ? (
          <span key={i} className="mo-untrusted-url" role="note" aria-label="Unverified link (not clickable)">
            {p} <span className="mo-note">(unverified link)</span>
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}

/* ------------------------------------------------------------ reactions */

export function ReactionBar(props: { my: MomentReaction | null; onReact(r: MomentReaction | null): void }) {
  return (
    <div role="group" aria-label="React" className="mo-reactions">
      {MOMENT_REACTIONS.map((r) => (
        <button
          key={r}
          type="button"
          className="mo-touch"
          aria-pressed={props.my === r}
          onClick={() => props.onReact(props.my === r ? null : r)}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ post card */

export function MomentCard(props: {
  moment: MomentView;
  onReact(r: MomentReaction | null): void;
  onOpenComments?(): void;
  onReport(): void;
  onBlock(): void;
  onHide(): void;
}) {
  const m = props.moment;
  return (
    <article className="mo-card" aria-label={`Post by ${m.author.displayName}`}>
      <header>
        <strong>{m.author.displayName}</strong>
        {m.author.distanceBand && <span className="mo-note"> · {m.author.distanceBand}</span>}
        <span className="mo-vis">{m.visibility}</span>
      </header>
      {m.text && <p><UntrustedText text={m.text} /></p>}
      {m.media.map((md) => (
        <img key={md.mediaId} src={md.thumbnailUrl} alt={md.alt} className="mo-media" />
      ))}
      {m.coarseCellLabel && <p className="mo-area">Approximate area only</p>}
      {m.ranking && (
        <details className="mo-why">
          <summary>Why this ranking</summary>
          <ul>
            {m.ranking.components.map((c) => (
              <li key={c.signal}>{c.signal}: {c.value.toFixed(2)} × {c.weight.toFixed(2)} = {c.weighted.toFixed(3)}</li>
            ))}
            {m.ranking.omittedSignals.map((s) => <li key={s} className="mo-omitted">{s}: unknown — omitted</li>)}
          </ul>
        </details>
      )}
      <ReactionBar my={m.myReaction} onReact={props.onReact} />
      <footer>
        {props.onOpenComments && <button className="mo-touch" onClick={props.onOpenComments}>Comments</button>}
        <button className="mo-touch" onClick={props.onReport}>Report</button>
        <button className="mo-touch" onClick={props.onBlock}>Block</button>
        <button className="mo-touch" onClick={props.onHide}>Hide</button>
      </footer>
    </article>
  );
}

/* ------------------------------------------------------------ visibility (M5) */

const TIER_LABEL: Record<MomentVisibility, string> = {
  private: 'Private — only you',
  friends: 'Friends — people you follow back',
  nearby: 'Nearby — anyone around your approximate area',
  public: 'Public — anyone in your city',
};

export function VisibilityControl(props: { value: MomentVisibility; onChange(v: MomentVisibility): void }) {
  return (
    <fieldset className="mo-visibility">
      <legend>Who can see this?</legend>
      {(Object.keys(TIER_LABEL) as MomentVisibility[]).map((v) => (
        <label key={v} className="mo-tier">
          <input type="radio" name="mo-visibility" value={v} checked={props.value === v} onChange={() => props.onChange(v)} />
          {TIER_LABEL[v]}
        </label>
      ))}
    </fieldset>
  );
}

/** The M5 plain-language explanation — shown BEFORE any location attaches. */
export function LocationExplanation(props: { onConfirm(): void; onCancel(): void }) {
  return (
    <div role="alertdialog" aria-label="About attaching your location" className="mo-explain">
      <p>
        Attaching a location shares your <strong>approximate area only</strong> — a
        rough grid square about 100 m across, never your exact position. It stays
        on this one post, and anyone who can see the post can see that area.
        You can always post without a location.
      </p>
      <button className="mo-touch mo-primary" onClick={props.onConfirm}>Attach approximate area</button>
      <button className="mo-touch" onClick={props.onCancel}>Don't attach</button>
    </div>
  );
}

/* ------------------------------------------------------------ stories rail */

export function StoriesRail(props: { stories: StoryView[]; onOpen?(id: string): void }) {
  if (props.stories.length === 0) return null;
  return (
    <nav aria-label="Stories" className="mo-rail">
      {props.stories.map((s) => (
        <button key={s.id} className="mo-story mo-touch" onClick={() => props.onOpen?.(s.id)} aria-label={`Story by ${s.author.displayName}`}>
          <img src={s.thumbnailUrl} alt="" aria-hidden />
          <span>{s.author.displayName}</span>
        </button>
      ))}
    </nav>
  );
}

/* ------------------------------------------------------------ comments (flat → render-side tree) */

export interface CommentView { id: string; parentId: string | null; author: { displayName: string }; text: string }

/** Nesting is RENDER-SIDE only — the data stays flat (M4). One level deep. */
export function CommentList(props: { comments: CommentView[] }) {
  const tops = props.comments.filter((c) => c.parentId === null);
  const replies = (id: string) => props.comments.filter((c) => c.parentId === id);
  return (
    <ul className="mo-comments" aria-label="Comments">
      {tops.map((c) => (
        <li key={c.id}>
          <strong>{c.author.displayName}</strong> <UntrustedText text={c.text} />
          {replies(c.id).length > 0 && (
            <ul>
              {replies(c.id).map((r) => (
                <li key={r.id}><strong>{r.author.displayName}</strong> <UntrustedText text={r.text} /></li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------ virtual list */

/** Minimal windowed list: renders only the visible slice between two spacers,
 *  so a long feed never mounts thousands of nodes. */
export function VirtualList<T>(props: {
  items: T[];
  itemHeight: number;
  viewportHeight: number;
  renderItem(item: T, index: number): React.JSX.Element;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const { items, itemHeight, viewportHeight } = props;
  const start = Math.max(0, Math.floor(scrollTop / itemHeight) - 2);
  const visible = Math.ceil(viewportHeight / itemHeight) + 4;
  const end = Math.min(items.length, start + visible);
  return (
    <div
      className="mo-virtual"
      style={{ height: viewportHeight, overflowY: 'auto' }}
      onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}
      role="feed"
      aria-busy={false}
    >
      <div style={{ height: start * itemHeight }} aria-hidden />
      {items.slice(start, end).map((it, i) => props.renderItem(it, start + i))}
      <div style={{ height: (items.length - end) * itemHeight }} aria-hidden />
    </div>
  );
}
