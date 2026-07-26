import { cn } from "@/lib/cn";

/**
 * Ambient multilingual field — letters from many scripts, numerals, and tiny
 * flag chips drifting faintly behind the page. Sits with the fixed mesh
 * backdrop (pointer-events-none, aria-hidden) and stays deliberately
 * transparent so it adds life without competing with content.
 *
 * Flags are inline SVG rather than emoji: Windows renders flag emoji as
 * letter pairs ("FR"), so emoji would silently break for a large share of
 * visitors. Three simple band patterns cover the chosen set.
 *
 * Server component — pure static markup; all motion is CSS keyframes
 * (glyph-drift-a/b/c in globals.css), transform/opacity only.
 */

type Glyph = {
  ch: string;
  /** viewport position, percent */
  x: number;
  y: number;
  size: number; // px
  dur: number; // s
  delay: number; // s
  variant: "a" | "b" | "c";
  opacity?: number; // override, 0..1
};

/* Letters across scripts: Latin, Devanagari, Tamil, Japanese, Korean, Arabic,
   Greek, Cyrillic, Chinese — plus digits from Latin, Devanagari and Arabic-
   Indic sets. Positions hand-scattered, denser toward the edges so the column
   of content in the middle stays clean. */
const GLYPHS: readonly Glyph[] = [
  { ch: "अ", x: 6, y: 14, size: 34, dur: 17, delay: 0, variant: "a" },
  { ch: "7", x: 13, y: 34, size: 24, dur: 14, delay: 3.2, variant: "b" },
  { ch: "ك", x: 4, y: 52, size: 30, dur: 19, delay: 6.4, variant: "c" },
  { ch: "த", x: 10, y: 72, size: 32, dur: 16, delay: 1.6, variant: "a" },
  { ch: "Ω", x: 5, y: 88, size: 26, dur: 15, delay: 8.1, variant: "b" },
  { ch: "え", x: 16, y: 8, size: 28, dur: 18, delay: 4.8, variant: "c" },
  { ch: "٣", x: 20, y: 58, size: 25, dur: 14, delay: 10.3, variant: "a" },
  { ch: "Б", x: 24, y: 22, size: 27, dur: 16, delay: 7.2, variant: "b" },
  { ch: "5", x: 30, y: 80, size: 22, dur: 13, delay: 2.4, variant: "c" },
  { ch: "ह", x: 36, y: 12, size: 24, dur: 17, delay: 9.6, variant: "a" },
  { ch: "字", x: 44, y: 86, size: 30, dur: 19, delay: 5.5, variant: "b" },
  { ch: "9", x: 52, y: 6, size: 22, dur: 14, delay: 11.8, variant: "c" },
  { ch: "한", x: 58, y: 90, size: 28, dur: 16, delay: 0.8, variant: "a" },
  { ch: "λ", x: 64, y: 16, size: 24, dur: 15, delay: 6.9, variant: "b" },
  { ch: "٨", x: 70, y: 76, size: 26, dur: 18, delay: 3.7, variant: "c" },
  { ch: "क", x: 76, y: 10, size: 30, dur: 17, delay: 12.4, variant: "a" },
  { ch: "R", x: 82, y: 62, size: 26, dur: 14, delay: 8.8, variant: "b" },
  { ch: "の", x: 88, y: 26, size: 32, dur: 19, delay: 1.9, variant: "c" },
  { ch: "٤", x: 93, y: 44, size: 24, dur: 15, delay: 10.9, variant: "a" },
  { ch: "மி", x: 90, y: 70, size: 28, dur: 17, delay: 5.1, variant: "b" },
  { ch: "3", x: 96, y: 86, size: 22, dur: 13, delay: 7.7, variant: "c" },
  { ch: "ñ", x: 78, y: 88, size: 26, dur: 16, delay: 13.2, variant: "a" },
  { ch: "१", x: 40, y: 4, size: 24, dur: 15, delay: 4.1, variant: "b" },
  { ch: "Ж", x: 60, y: 4, size: 25, dur: 18, delay: 14.6, variant: "c" },
];

type Flag = {
  /** three vertical or horizontal bands (or two + disc for Japan) */
  kind: "v" | "h" | "disc";
  colors: readonly [string, string, string];
  x: number;
  y: number;
  dur: number;
  delay: number;
  variant: "a" | "b" | "c";
};

/* Band-pattern flags only — instantly readable at tiny sizes without detail:
   France, Italy, India (h-tricolour w/ navy hint), Germany, Nigeria, Japan. */
const FLAGS: readonly Flag[] = [
  { kind: "v", colors: ["#4A6FA5", "#F5F7FA", "#D65A5A"], x: 9, y: 26, dur: 18, delay: 2.2, variant: "b" }, // FR (softened)
  { kind: "v", colors: ["#5C9E6E", "#F5F7FA", "#D65A5A"], x: 86, y: 12, dur: 16, delay: 6.1, variant: "a" }, // IT
  { kind: "h", colors: ["#E8A34E", "#F5F7FA", "#5C9E6E"], x: 14, y: 90, dur: 17, delay: 9.4, variant: "c" }, // IN
  { kind: "h", colors: ["#3A3A3A", "#D65A5A", "#E8C34E"], x: 68, y: 92, dur: 15, delay: 4.3, variant: "b" }, // DE
  { kind: "v", colors: ["#5C9E6E", "#F5F7FA", "#5C9E6E"], x: 94, y: 58, dur: 19, delay: 0.9, variant: "c" }, // NG
  { kind: "disc", colors: ["#F5F7FA", "#D65A5A", "#F5F7FA"], x: 27, y: 6, dur: 16, delay: 11.7, variant: "a" }, // JP
];

function FlagChip({ flag }: { flag: Flag }) {
  const [c1, c2, c3] = flag.colors;
  return (
    <span
      className={cn(
        "absolute block overflow-hidden rounded-[3px]",
        flag.variant === "a" && "animate-[glyph-drift-a_var(--dur)_ease-in-out_var(--delay)_infinite]",
        flag.variant === "b" && "animate-[glyph-drift-b_var(--dur)_ease-in-out_var(--delay)_infinite]",
        flag.variant === "c" && "animate-[glyph-drift-c_var(--dur)_ease-in-out_var(--delay)_infinite]",
      )}
      style={
        {
          left: `${flag.x}%`,
          top: `${flag.y}%`,
          width: 26,
          height: 18,
          "--dur": `${flag.dur}s`,
          "--delay": `${flag.delay}s`,
          "--glyph-opacity": 0.16,
          opacity: 0,
        } as React.CSSProperties
      }
    >
      {flag.kind === "disc" ? (
        <svg viewBox="0 0 26 18" className="h-full w-full">
          <rect width="26" height="18" fill={c1} />
          <circle cx="13" cy="9" r="4.6" fill={c2} />
        </svg>
      ) : (
        <svg viewBox="0 0 26 18" className="h-full w-full">
          {flag.kind === "v" ? (
            <>
              <rect width="8.67" height="18" fill={c1} />
              <rect x="8.67" width="8.67" height="18" fill={c2} />
              <rect x="17.33" width="8.67" height="18" fill={c3} />
            </>
          ) : (
            <>
              <rect width="26" height="6" fill={c1} />
              <rect y="6" width="26" height="6" fill={c2} />
              <rect y="12" width="26" height="6" fill={c3} />
            </>
          )}
        </svg>
      )}
    </span>
  );
}

export default function AmbientGlyphs({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none fixed inset-0 overflow-hidden", className)}
    >
      {GLYPHS.map((g, i) => (
        <span
          key={i}
          className={cn(
            "absolute select-none font-display font-semibold text-ink",
            g.variant === "a" && "animate-[glyph-drift-a_var(--dur)_ease-in-out_var(--delay)_infinite]",
            g.variant === "b" && "animate-[glyph-drift-b_var(--dur)_ease-in-out_var(--delay)_infinite]",
            g.variant === "c" && "animate-[glyph-drift-c_var(--dur)_ease-in-out_var(--delay)_infinite]",
          )}
          style={
            {
              left: `${g.x}%`,
              top: `${g.y}%`,
              fontSize: g.size,
              "--dur": `${g.dur}s`,
              "--delay": `${g.delay}s`,
              "--glyph-opacity": g.opacity ?? 0.08,
              opacity: 0,
            } as React.CSSProperties
          }
        >
          {g.ch}
        </span>
      ))}
      {FLAGS.map((f, i) => (
        <FlagChip key={i} flag={f} />
      ))}
    </div>
  );
}
