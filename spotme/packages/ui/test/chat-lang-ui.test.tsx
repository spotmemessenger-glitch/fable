/**
 * Chat (final slice, session 3) — translation/transliteration composer modes
 * + interaction polish. The package sees display-ready strings ONLY: the
 * ComposerView/TranslationLine arrive over the snapshot, every gesture is a
 * port callback, and no engine is imported here (fence-enforced).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ChatShell } from '../chat/ChatShell';
import { fixtureChatPort, type ChatSnapshot, type MessageRowView } from '../chat/ports';

afterEach(cleanup);

const row = (over: Partial<MessageRowView>): MessageRowView => ({
  id: `r${Math.random()}`, mine: false, kind: 'text', text: 'x', name: 'Asha',
  showName: false, timeLabel: '10:00', dayKey: 'today', dayLabel: 'Today',
  status: 'sent', edited: false, replyPreview: null, reactions: [],
  canEdit: false, copyText: 'x', ...over,
});

const composed = (port: ReturnType<typeof fixtureChatPort>, over: Partial<ChatSnapshot>) => {
  act(() => { port.setSnapshot({ ...port.snapshot(), ...over }); });
};

const COMPOSER = {
  mode: 'translate' as const,
  translateOn: true,
  translitOn: false,
  translateLangLabel: 'Tamil',
  translitLangLabel: 'Auto',
  preview: null,
};

describe('chat shell — language controls', () => {
  it('no composer in the snapshot hides every language control (session 2 ports)', () => {
    const { container } = render(<ChatShell port={fixtureChatPort()} />);
    expect(container.querySelector('.ch-langbar')).toBeNull();
    expect(container.querySelector('.ch-tlprev')).toBeNull();
  });

  it('the 文A and 🌐 switches and their chips cross the port', () => {
    const port = fixtureChatPort();
    render(<ChatShell port={port} />);
    composed(port, { composer: { ...COMPOSER, translitOn: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Transliteration · on' }));
    fireEvent.click(screen.getByRole('button', { name: 'Translation · Tamil' }));
    fireEvent.click(screen.getByRole('button', { name: 'Language you type in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Translate their messages into' }));
    expect(port.calls).toEqual([
      'markRead', 'toggleTranslit', 'toggleTranslate', 'pickTranslitLang', 'pickTranslateLang',
    ]);
  });

  it('an off feature hides its chip; pressed state mirrors the snapshot', () => {
    const port = fixtureChatPort();
    const { container } = render(<ChatShell port={port} />);
    composed(port, { composer: { ...COMPOSER, translitOn: false } });
    expect(screen.queryByRole('button', { name: 'Language you type in' })).toBeNull();
    const switches = container.querySelectorAll('.ch-langsw');
    expect([...switches].map((s) => s.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });

  it('typing reports the trimmed draft through draftChanged', () => {
    const port = fixtureChatPort();
    render(<ChatShell port={port} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: ' vanakkam ' } });
    expect(port.calls).toContain('draft:vanakkam');
  });

  it('the preview panel renders tag, hero line and detection sub verbatim', () => {
    const port = fixtureChatPort();
    render(<ChatShell port={port} />);
    composed(port, {
      composer: {
        ...COMPOSER,
        preview: { tag: '文A Translation · Tamil', main: 'வணக்கம்', sub: 'Detected English' },
      },
    });
    expect(screen.getByText('文A Translation · Tamil')).toBeTruthy();
    expect(screen.getByText('வணக்கம்')).toBeTruthy();
    expect(screen.getByText('Detected English')).toBeTruthy();
  });

  it('an incoming translation line renders its tag and text on the row', () => {
    const port = fixtureChatPort([
      row({ id: 't1', text: 'எங்கே இருக்கிறாய்', translation: { tag: 'Tamil · Translated', text: 'where are you', pending: false } }),
    ]);
    render(<ChatShell port={port} />);
    expect(screen.getByText('Tamil · Translated')).toBeTruthy();
    expect(screen.getByText('where are you')).toBeTruthy();
  });
});

describe('chat shell — session 3 polish', () => {
  it('Forward and Share appear only for forwardable rows and cross the port', () => {
    const port = fixtureChatPort([row({ id: 'f1', canForward: true })]);
    render(<ChatShell port={port} />);
    fireEvent.contextMenu(screen.getByText('x'));
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    expect(port.calls).toContain('forward:f1');
    fireEvent.contextMenu(screen.getByText('x'));
    fireEvent.click(screen.getByRole('button', { name: 'Share…' }));
    expect(port.calls).toContain('share:f1');
  });

  it('a view-once row (canForward false) offers no Forward item', () => {
    const port = fixtureChatPort([row({ id: 'v1', canForward: false })]);
    render(<ChatShell port={port} />);
    fireEvent.contextMenu(screen.getByText('x'));
    expect(screen.queryByRole('button', { name: 'Forward' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Share…' })).toBeNull();
  });

  it('double-tap sends the heart through the same port.react the sheet uses', () => {
    const port = fixtureChatPort([row({ id: 'd1' })]);
    render(<ChatShell port={port} />);
    fireEvent.doubleClick(screen.getByText('x'));
    expect(port.calls).toContain('react:d1:❤️');
  });

  it('swiping a bubble right past the threshold composes a reply', () => {
    const port = fixtureChatPort([row({ id: 's1', text: 'swipe me', name: 'Asha' })]);
    const { container } = render(<ChatShell port={port} />);
    const bubble = container.querySelector('.ch-bubble')!;
    fireEvent.touchStart(bubble, { touches: [{ clientX: 10, clientY: 100 }] });
    fireEvent.touchMove(bubble, { touches: [{ clientX: 90, clientY: 102 }] });
    fireEvent.touchEnd(bubble);
    // The reply bar quotes the swiped row.
    expect(container.querySelector('.ch-replybar')!.textContent).toContain('swipe me');
  });

  it('a video row plays back for real; a voice row carries waveform bars', () => {
    const port = fixtureChatPort([
      row({ id: 'vid', kind: 'media', media: { type: 'video', url: 'blob:v', caption: 'clip' } }),
      row({ id: 'vox', kind: 'media', media: { type: 'voice', url: 'blob:a', durLabel: '7s' } }),
    ]);
    const { container } = render(<ChatShell port={port} />);
    const video = container.querySelector('.ch-vidmsg video') as HTMLVideoElement;
    expect(video?.getAttribute('src')).toBe('blob:v');
    expect(video?.hasAttribute('controls')).toBe(true);
    expect(screen.getByText('clip')).toBeTruthy();
    expect(container.querySelectorAll('.ch-wave i').length).toBe(20);
  });
});
