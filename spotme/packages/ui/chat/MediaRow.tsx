/**
 * Chat — media bubbles (session 2, behind spotme.ui.chat).
 *
 * Purely presentational: every URL and label arrives display-ready over the
 * port. The view-once tile mirrors the legacy contract exactly — it renders
 * ONLY the sender-made mask thumbnail, never the photo bytes (they are not in
 * the row at all), and tapping it hands the burn to the adapter.
 */
import type { ChatPort, MessageRowView, MediaView } from './ports';

export function MediaBubble({ row, media, port }: {
  row: MessageRowView; media: MediaView; port: ChatPort;
}) {
  switch (media.type) {
    case 'photo':
      return (
        <button type="button" className="ch-imgmsg" aria-label="Open photo"
          onClick={() => port.openPhoto(row.id)}>
          <img src={media.url} alt="Photo" />
          {media.caption && <span className="ch-imgcap">{media.caption}</span>}
        </button>
      );
    case 'viewOnce':
      return (
        <button type="button" className="ch-vonce" onClick={() => port.openViewOnce(row.id)}>
          <span className="ch-vmask">
            {media.maskUrl && <img className="ch-vblur" src={media.maskUrl} alt="" />}
            <b className="ch-bchip">{media.chip}</b>
            <span className="ch-vfire" aria-hidden="true">🔥</span>
          </span>
          <span>{media.label}</span>
        </button>
      );
    case 'viewOnceMine':
      return (
        <div className="ch-vomine">
          <span>{media.label}</span>
          <span className="ch-bchip2">{media.chip}</span>
          {media.opened && <span className="ch-vocap">Opened</span>}
        </div>
      );
    case 'voice':
      return (
        <div className="ch-voice">
          {/* Decorative bars — a real amplitude waveform needs decoding the
              audio, which is app-side; fixed pseudo-random heights read as a
              voice note without it. */}
          <span className="ch-wave" aria-hidden="true">
            {Array.from({ length: 20 }, (_, i) => (
              <i key={i} style={{ height: `${30 + ((i * 37) % 53)}%` }} />
            ))}
          </span>
          {/* Playback of a display-ready URL; recording/encoding is app-side. */}
          <audio controls preload="metadata" src={media.url} aria-label="Voice note" />
          <span className="ch-vdur">{media.durLabel}</span>
        </div>
      );
    case 'video':
      return (
        <div className="ch-vidmsg">
          {/* Real playback of a display-ready URL (session 3 — the stub row
              retires for fetched videos). */}
          <video controls playsInline preload="metadata" src={media.url} aria-label="Video message" />
          {media.caption && <span className="ch-imgcap">{media.caption}</span>}
        </div>
      );
    case 'file':
      return media.url ? (
        <a className="ch-file" href={media.url} download={media.name}>
          <b>{media.name}</b>
          <span>{media.sizeLabel}</span>
        </a>
      ) : (
        <div className="ch-file ch-file-gone">
          <b>{media.name}</b>
          <span>{media.sizeLabel}</span>
        </div>
      );
    case 'location':
      return (
        <div className={`ch-loc${media.live ? ' ch-loc-live' : ''}`}>
          <b>{media.label}</b>
          {media.mapUrl && (
            <a href={media.mapUrl} target="_blank" rel="noopener noreferrer">Open map</a>
          )}
        </div>
      );
  }
}

export function ReactionChips({ chips }: { chips: MessageRowView['reactions'] }) {
  if (!chips.length) return null;
  return (
    <div className="ch-reacts">
      {chips.map((c) => (
        <span key={c.emoji}>{c.count > 1 ? `${c.emoji} ${c.count}` : c.emoji}</span>
      ))}
    </div>
  );
}
