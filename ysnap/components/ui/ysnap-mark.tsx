import { cn } from "@/lib/cn";

/**
 * The YSNAP mark: a lowercase "y" whose left arm terminates in a chat bubble
 * (translation / conversation) and whose dot reads as a camera lens ring
 * (vision). Drawn as SVG rather than shipped as a PNG, so it is inherently
 * background-free, scales to any size without softening, and can be re-toned
 * per placement.
 *
 * Gradient ids are keyed by tone rather than generated per instance: every
 * instance of a tone shares one identical definition, so a duplicate id is
 * harmless, and it keeps this a server component (useId would force "use
 * client" on a file that renders in the navbar of every page).
 */

type Tone = "brand" | "silver" | "blue";

/** [start, mid, end] gradient stops + the knocked-out detail colour. */
const TONES: Record<Tone, { stops: [string, string, string]; knock: string }> = {
  /* default cyan→blue, used in the navbar and footer */
  brand: { stops: ["#2FD9F5", "#2C9BF0", "#1E62EE"], knock: "#0B1533" },
  /* brushed steel — for the coloured hero wash, where a blue mark would
     disappear into the blue background behind it */
  silver: { stops: ["#FFFFFF", "#D8DDE5", "#8B939F"], knock: "#2B3038" },
  /* saturated cyan→blue with more contrast, for small sizes on white */
  blue: { stops: ["#2FD9F5", "#2C9BF0", "#1B57E0"], knock: "#0B1533" },
};

export function YsnapMark({
  className,
  tone = "brand",
}: {
  className?: string;
  tone?: Tone;
}) {
  const { stops, knock } = TONES[tone];
  const gid = `ysnap-mark-${tone}`;
  const paint = `url(#${gid})`;

  return (
    <svg
      viewBox="0 0 64 64"
      className={cn("shrink-0", className)}
      fill="none"
      aria-hidden
    >
      <defs>
        <linearGradient id={gid} x1="12" y1="8" x2="52" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={stops[0]} />
          <stop offset="0.52" stopColor={stops[1]} />
          <stop offset="1" stopColor={stops[2]} />
        </linearGradient>
      </defs>

      {/* y — right arm falling through the junction and on into the
          descender, which hooks back to the left at the baseline. One stroke,
          so the corner at the junction stays a single continuous form. */}
      <path
        d="M45.5 24.5 L30.4 54 Q27.4 59.8 20 57.4"
        stroke={paint}
        strokeWidth="10.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* y — left arm dropping from under the bubble to meet it */}
      <path d="M21.8 27 L31.4 46.6" stroke={paint} strokeWidth="10.4" strokeLinecap="round" />

      {/* chat bubble: tail drawn first so the disc covers its root */}
      <path d="M13.2 24.6 L7.6 33.4 L17.4 29.6 Z" fill={paint} />
      <circle cx="20.4" cy="18.8" r="10.6" fill={paint} />
      <circle cx="15.8" cy="18.8" r="1.95" fill={knock} />
      <circle cx="20.4" cy="18.8" r="1.95" fill={knock} />
      <circle cx="25" cy="18.8" r="1.95" fill={knock} />

      {/* lens ring — the y's dot as a camera aperture. Held clear of the
          right arm so the two never visually fuse at small sizes. */}
      <circle cx="51" cy="11.6" r="6.4" fill={paint} />
      <circle cx="51" cy="11.6" r="2.6" fill={knock} />
    </svg>
  );
}
