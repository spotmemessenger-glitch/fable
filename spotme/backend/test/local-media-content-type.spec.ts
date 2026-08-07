/**
 * MOMENT MEDIA MUST BE SERVABLE AS MEDIA — without reopening the XSS door the
 * blanket `application/octet-stream` was closing.
 *
 * The local media route answered every download with `octet-stream` +
 * `nosniff`. For chat attachments that is exactly right: they are ciphertext,
 * and letting a stored content type drive that header is how a blob store
 * starts serving `text/html` back to a browser.
 *
 * Moments broke the assumption. Those objects are plaintext photos and videos
 * that a browser must DECODE in an `<img>`/`<video>`, and `octet-stream` +
 * `nosniff` is precisely the pair that forbids it — every moment video failed
 * with MEDIA_ERR_SRC_NOT_SUPPORTED and every photo rendered blank.
 *
 * The fix carries the type in the SIGNED url and clamps it to an allow-list at
 * both ends. These tests pin all three properties at once:
 *   1. real media gets its real type;
 *   2. a scriptable or textual type can never be served, however it arrives;
 *   3. the type is covered by the signature, so it cannot be swapped by anyone
 *      holding an otherwise-valid download url.
 */
import { LocalStorageAdapter } from '../src/storage/local-storage.adapter';
import { safeServeType, RENDERABLE_MEDIA_TYPES } from '../src/storage/storage.interface';

const KEY = 'moments/0d92ce7e9ed0e9202fb6427a4b1c0c19/mm-11111111-2222-3333-4444-555555555555';

const parse = (url: string) => {
  const q = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  return {
    key: String(q.get('key')),
    expires: Number(q.get('expires')),
    sig: String(q.get('sig')),
    ct: q.get('ct') ?? '',
  };
};

describe('local media content type', () => {
  const adapter = new LocalStorageAdapter();

  it('serves a video as video, not as an opaque blob', async () => {
    const url = await adapter.getDownloadUrl(KEY, 'video/mp4');
    const p = parse(url);
    expect(p.ct).toBe('video/mp4');
    expect(safeServeType(p.ct)).toBe('video/mp4');
    expect(adapter.verify(p.key, p.expires, 'GET', p.sig, p.ct)).toBe(true);
  });

  it('serves a photo as an image', async () => {
    const p = parse(await adapter.getDownloadUrl(KEY, 'image/jpeg'));
    expect(safeServeType(p.ct)).toBe('image/jpeg');
    expect(adapter.verify(p.key, p.expires, 'GET', p.sig, p.ct)).toBe(true);
  });

  it('tolerates a charset parameter on a stored type', () => {
    expect(safeServeType('video/mp4; charset=binary')).toBe('video/mp4');
    expect(safeServeType('IMAGE/JPEG')).toBe('image/jpeg');
  });

  /* The whole reason the blanket octet-stream existed. These must never be
   * served as themselves, whether they reach the route from a stored mime
   * type, a signed parameter, or a tampered one. */
  it.each([
    'text/html',
    'image/svg+xml',
    'application/javascript',
    'text/javascript',
    'application/xhtml+xml',
    'text/plain',
    '',
    'nonsense',
  ])('never serves %p as itself', (bad) => {
    expect(safeServeType(bad)).toBe('application/octet-stream');
    expect(RENDERABLE_MEDIA_TYPES).not.toContain(bad);
  });

  it('refuses to SIGN a type outside the allow-list — it never reaches the route', async () => {
    const p = parse(await adapter.getDownloadUrl(KEY, 'text/html'));
    expect(p.ct).toBe('');
  });

  it('covers the content type with the signature — a swapped ct fails verification', async () => {
    const p = parse(await adapter.getDownloadUrl(KEY, 'video/mp4'));
    // Same key, same expiry, same signature — only the type changed.
    expect(adapter.verify(p.key, p.expires, 'GET', p.sig, 'image/jpeg')).toBe(false);
    expect(adapter.verify(p.key, p.expires, 'GET', p.sig, '')).toBe(false);
  });

  it('chat attachments are unaffected: no type asked, none signed, opaque as before', async () => {
    const chatKey = 'rooms/room123/att456/0';
    const p = parse(await adapter.getDownloadUrl(chatKey));
    expect(p.ct).toBe('');
    expect(safeServeType(p.ct)).toBe('application/octet-stream');
    expect(adapter.verify(p.key, p.expires, 'GET', p.sig, '')).toBe(true);
  });

  it('a download url still does not double as an upload url', async () => {
    const p = parse(await adapter.getDownloadUrl(KEY, 'video/mp4'));
    expect(adapter.verify(p.key, p.expires, 'PUT', p.sig, p.ct)).toBe(false);
  });
});
