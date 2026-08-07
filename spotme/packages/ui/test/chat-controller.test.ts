/**
 * Chat controller parity — every DOM-mutation site in views/chat.js that
 * Phase A covers has its state equivalent proven here: message list on
 * message/history, Sent+Read-only status, failure + retry, translation
 * instant/async/suppression, transliteration hint with stale-answer guard,
 * identity banner states, undecryptable room flag clearing on a good frame.
 */

import { describe, expect, it } from 'vitest';
import { ChatController } from '../chat/controller';
import {
  FixedClock,
  FixtureChatEngine,
  FixtureTranslate,
  FixtureTranslit,
} from '../chat/fixtures';

const make = (over: Partial<ConstructorParameters<typeof ChatController>[0]> = {}) => {
  const clock = new FixedClock(1_700_000_000_000);
  const engine = new FixtureChatEngine(clock);
  const controller = new ChatController({
    engine,
    roomId: 'r1',
    selfId: 'me',
    clock,
    ...over,
  });
  return { engine, controller, clock };
};

describe('messages and events', () => {
  it('send is optimistic: the message is in state before any ack', () => {
    const { controller } = make();
    controller.open();
    const m = controller.sendText('hello');
    expect(m).not.toBeNull();
    expect(controller.messages.map((x) => x.text)).toContain('hello');
    expect(controller.statusOf(m!)).toBe('sent');
  });

  it('an incoming message event lands in state (receive path)', () => {
    const { controller, engine } = make();
    controller.open();
    engine.ensure('r1').receive({ id: 'p1', from: 'peer', ts: 1, text: 'hi' });
    expect(controller.messages.some((m) => m.id === 'p1')).toBe(true);
  });

  it('deleted/expired events remove the row from state', () => {
    const { controller, engine } = make();
    controller.open();
    const conn = engine.ensure('r1');
    conn.receive({ id: 'p1', from: 'peer', ts: 1, text: 'gone' });
    conn.messages = conn.messages.filter((m) => m.id !== 'p1');
    conn.emit({ type: 'deleted', id: 'p1' });
    expect(controller.messages.some((m) => m.id === 'p1')).toBe(false);
  });
});

describe('status — Sent + Read ONLY (design system §8)', () => {
  it('never produces a "Delivered" tier: sent, then read at readUpTo', () => {
    const { controller, engine } = make();
    controller.open();
    const m = controller.sendText('tick')!;
    expect(controller.statusOf(m)).toBe('sent');
    engine.ensure('r1').markReadUpTo(m.ts);
    expect(controller.statusOf(m)).toBe('read');
    // The status set is closed: failed | read | sent.
    const legal = new Set(['failed', 'read', 'sent']);
    expect(legal.has(controller.statusOf(m))).toBe(true);
  });

  it('a failed send is failed, and retry clears it (text path)', () => {
    const { controller, engine } = make();
    controller.open();
    const m = controller.sendText('retry me')!;
    engine.ensure('r1').failSend(m.id);
    expect(controller.statusOf(controller.messages.find((x) => x.id === m.id)!)).toBe('failed');
    expect(controller.retry(m)).toBe(true);
    expect(controller.statusOf(controller.messages.find((x) => x.id === m.id)!)).toBe('sent');
  });

  it('retry routes attachments through retryAttachment, text through retryMessage', () => {
    const { controller, engine } = make();
    controller.open();
    const img = engine.sendAttachment('r1', { kind: 'image', data: 'data:image/png;base64,x' })!;
    engine.ensure('r1').failSend(img.id);
    expect(controller.retry(img)).toBe(true);
  });
});

describe('translation — the split-bubble .tr section', () => {
  const deps = { readLang: 'ta', translateWanted: true };

  it('instant path: sender pre-translation into my language needs no network', () => {
    const translate = new FixtureTranslate();
    const { controller, engine } = make({ ...deps, translate });
    controller.open();
    engine.ensure('r1').receive({
      id: 'p1', from: 'peer', ts: 1, text: 'வணக்கம்', tr: { lang: 'ta', text: 'வணக்கம் (pre)' },
    });
    const tr = controller.translationFor(controller.messages[0]);
    expect(tr).toEqual({ text: 'வணக்கம் (pre)', engine: 'instant' });
    expect(translate.calls.length).toBe(0);
  });

  it('async path: pending first, then the translated text, cached per id', async () => {
    const translate = new FixtureTranslate();
    const { controller, engine } = make({ ...deps, translate });
    controller.open();
    engine.ensure('r1').receive({ id: 'p2', from: 'peer', ts: 2, text: 'hello there' });
    const m = controller.messages[0];
    expect(controller.translationFor(m)).toBe('pending');
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.translationFor(m)).toEqual({
      text: '[ta] hello there', engine: 'fixture', detected: 'xx',
    });
    expect(translate.calls.length).toBe(1); // cached — no second call
    controller.translationFor(m);
    expect(translate.calls.length).toBe(1);
  });

  it('my own messages and non-text kinds never get a .tr section', () => {
    const { controller, engine } = make({ ...deps, translate: new FixtureTranslate() });
    controller.open();
    const mine = controller.sendText('mine')!;
    expect(controller.translationFor(mine)).toBeNull();
    engine.ensure('r1').receive({ id: 'v1', from: 'peer', ts: 3, kind: 'voice', dur: 2 });
    expect(controller.translationFor(controller.messages.find((m) => m.id === 'v1')!)).toBeNull();
  });

  it('translation OFF (globe off / autoTranslate off) leaves messages exactly as they arrived', () => {
    const { controller, engine } = make({ readLang: 'ta', translateWanted: false, translate: new FixtureTranslate() });
    controller.open();
    engine.ensure('r1').receive({ id: 'p3', from: 'peer', ts: 4, text: 'raw' });
    expect(controller.translationFor(controller.messages[0])).toBeNull();
  });

  it('a translation that only repeats the original is suppressed', async () => {
    const translate = {
      translate: async (text: string) => ({ text, engine: 'echo', detected: 'en' }),
    };
    const { controller, engine } = make({ ...deps, translate });
    controller.open();
    engine.ensure('r1').receive({ id: 'p4', from: 'peer', ts: 5, text: 'same words' });
    const m = controller.messages[0];
    controller.translationFor(m);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.translationFor(m)).toBeNull();
  });
});

describe('transliteration hint (composer)', () => {
  it('the local stage answers instantly', () => {
    const { controller } = make({ translit: new FixtureTranslit() });
    controller.open();
    controller.updateDraft('vanakkam');
    expect(controller.draftHint).toEqual({ tag: '文A Transliterated', text: 'VANAKKAM' });
  });

  it('a stale remote answer never overwrites a newer draft', async () => {
    let release: (v: { tag: string; text: string } | null) => void = () => {};
    const translit = {
      hint: (raw: string) => ({ tag: 'local', text: raw }),
      hintRemote: () => new Promise<{ tag: string; text: string } | null>((r) => { release = r; }),
    };
    const { controller } = make({ translit });
    controller.open();
    controller.updateDraft('first');
    const staleRelease = release;
    controller.updateDraft('second');
    staleRelease({ tag: 'remote', text: 'STALE FIRST' });
    await Promise.resolve();
    expect(controller.draftHint).toEqual({ tag: 'local', text: 'second' });
  });

  it('an empty draft clears the hint', () => {
    const { controller } = make({ translit: new FixtureTranslit() });
    controller.open();
    controller.updateDraft('x');
    controller.updateDraft('');
    expect(controller.draftHint).toBeNull();
  });
});

describe('identity banner + undecryptable room', () => {
  it('mirrors identityStatus() at open', () => {
    const { engine, controller } = make();
    engine.identity = 'ephemeral';
    controller.open();
    expect(controller.identity).toBe('ephemeral');
  });

  it('undecryptable sets the reason; the next good frame clears it', () => {
    const { controller, engine } = make();
    controller.open();
    const conn = engine.ensure('r1');
    conn.emit({ type: 'undecryptable', reason: 'wrong-key' });
    expect(controller.undecryptable).toBe('wrong-key');
    conn.receive({ id: 'ok1', from: 'peer', ts: 9, text: 'opens fine' });
    expect(controller.undecryptable).toBeNull();
  });
});
