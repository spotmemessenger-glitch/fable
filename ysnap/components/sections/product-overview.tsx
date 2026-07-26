"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AnimatePresence,
  motion,
  useInView,
  useReducedMotion,
  useScroll,
  useTransform,
  type MotionValue,
} from "framer-motion";
import { cn } from "@/lib/cn";
import { EASE } from "@/lib/motion";
import { Section, SectionHeading } from "@/components/ui/section";
import { Reveal } from "@/components/ui/reveal";
import { ParallaxGlow } from "@/components/ui/parallax-glow";
import { ArrowRightIcon } from "@/components/ui/icons";

/* -------------------------------------------------------------------- data */

/** One spectrum hue per language: `bg` tints the bubble, `fg` keeps the text legible. */
type Lang = { code: string; name: string; word: string; bg: string; fg: string };

const LANGS: Lang[] = [
  { code: "FR", name: "Français", word: "Bonjour", bg: "76 125 255", fg: "47 95 232" },
  { code: "JA", name: "日本語", word: "こんにちは", bg: "255 107 94", fg: "200 60 48" },
  { code: "HI", name: "हिन्दी", word: "नमस्ते", bg: "245 158 11", fg: "170 104 4" },
  { code: "ES", name: "Español", word: "Hola", bg: "52 184 113", fg: "26 126 74" },
  { code: "AR", name: "العربية", word: "مرحبا", bg: "16 179 163", fg: "10 120 110" },
  { code: "RU", name: "Русский", word: "Привет", bg: "110 110 247", fg: "76 76 212" },
];

type WaveBar = { height: number; peak: number; duration: number; delay: number };

/** Deterministic pseudo-random bars so server and client render identically. */
const WAVE_BARS: WaveBar[] = Array.from({ length: 24 }, (_, i) => {
  const wave = Math.sin(i * 0.9 + 1) * 0.5 + 0.5;
  const jitter = ((i * 37) % 23) / 23;
  return {
    height: 22 + wave * 58,
    peak: 0.55 + jitter * 1.05,
    duration: 0.9 + jitter * 0.8,
    delay: (i % 7) * 0.09,
  };
});

/** Per-bar violet -> accent blend so the waveform reads as one vertical gradient. */
const waveBarColor = (i: number): string => {
  const t = i / (WAVE_BARS.length - 1);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  // violet #6e6ef7 -> accent #4c7dff
  return `rgb(${mix(110, 76)} ${mix(110, 125)} ${mix(247, 255)} / 0.45)`;
};

type ModeChip = { label: string; icon: ReactNode; hue: string };

const iconProps = {
  viewBox: "0 0 24 24",
  className: "h-4 w-4",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const MODE_CHIPS: ModeChip[] = [
  {
    label: "Coins",
    hue: "bg-amber/10 text-amber",
    icon: (
      <svg {...iconProps} aria-hidden>
        <circle cx="9" cy="9" r="5.25" />
        <path d="M15.4 6.9a5.25 5.25 0 1 1-8.5 8.5" />
      </svg>
    ),
  },
  {
    label: "Plants",
    hue: "bg-green/10 text-green",
    icon: (
      <svg {...iconProps} aria-hidden>
        <path d="M12 21v-7" />
        <path d="M12 14C8 14 6 11.5 6 8c3.5 0 6 2 6 6z" />
        <path d="M12 14c4 0 6-2.5 6-6-3.5 0-6 2-6 6z" />
      </svg>
    ),
  },
  {
    label: "Food",
    hue: "bg-coral/10 text-coral",
    icon: (
      <svg {...iconProps} aria-hidden>
        <path d="M4 12h16" />
        <path d="M4 12a8 8 0 0 0 16 0" />
        <path d="M9.5 8V5.5" />
        <path d="M14.5 8V5.5" />
      </svg>
    ),
  },
  {
    label: "Math",
    hue: "bg-violet/10 text-violet",
    icon: (
      <svg {...iconProps} aria-hidden>
        <path d="M4 13.5h2.5l2.7 5L13 5.5h7" />
      </svg>
    ),
  },
  {
    label: "Landmarks",
    hue: "bg-amber/10 text-amber",
    icon: (
      <svg {...iconProps} aria-hidden>
        <path d="m4.5 9.5 7.5-5 7.5 5" />
        <path d="M7 12.5v5" />
        <path d="M12 12.5v5" />
        <path d="M17 12.5v5" />
        <path d="M5 20h14" />
      </svg>
    ),
  },
  {
    label: "Animals",
    hue: "bg-coral/10 text-coral",
    icon: (
      <svg {...iconProps} aria-hidden>
        <circle cx="6.5" cy="10.5" r="1.4" />
        <circle cx="10" cy="7" r="1.4" />
        <circle cx="14" cy="7" r="1.4" />
        <circle cx="17.5" cy="10.5" r="1.4" />
        <path d="M12 18.5c-2.1 0-3.75-1.3-3.75-2.9 0-1.7 1.75-3.6 3.75-3.6s3.75 1.9 3.75 3.6c0 1.6-1.65 2.9-3.75 2.9z" />
      </svg>
    ),
  },
];

/* --------------------------------------------------------------- mini visuals */

/**
 * Live translation scene for the wide card: a source bubble cycling through
 * world languages, a beam carrying the meaning across the full card width, and
 * a rail of language chips that lights up in step. Fills the double-width cell
 * that two stacked bubbles left mostly empty.
 */
function TranslationScene() {
  const reduce = useReducedMotion();
  const [index, setIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inView = useInView(rootRef, { amount: 0.2 });

  useEffect(() => {
    if (reduce || !inView) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % LANGS.length), 2600);
    return () => window.clearInterval(id);
  }, [reduce, inView]);

  const lang = LANGS[index];

  return (
    <div ref={rootRef} className="relative" aria-hidden>
      {/* ambient hue wash that shifts with the active language */}
      <motion.div
        className="pointer-events-none absolute -inset-8 -z-10 rounded-full blur-3xl"
        animate={{ background: `radial-gradient(closest-side, rgb(${lang.bg} / 0.14), transparent 70%)` }}
        transition={{ duration: 1.1, ease: EASE }}
      />

      {/* source → beam → target, spanning the whole card */}
      <div className="flex items-center gap-3 sm:gap-4">
        <div
          className="shrink-0 rounded-2xl rounded-bl-md px-4 py-2.5 transition-colors duration-500"
          style={{ backgroundColor: `rgb(${lang.bg} / 0.12)` }}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={lang.word}
              className="block min-w-20 text-center text-[15px] font-semibold"
              style={{ color: `rgb(${lang.fg})` }}
              initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
              transition={{ duration: 0.4, ease: EASE }}
            >
              {lang.word}
            </motion.span>
          </AnimatePresence>
        </div>

        {/* the beam — a pulse of meaning travelling left to right */}
        <div className="relative h-px min-w-0 flex-1 bg-[linear-gradient(90deg,transparent,rgb(11_12_14/0.1),rgb(11_12_14/0.1),transparent)]">
          {!reduce && (
            <motion.span
              className="absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
              style={{ backgroundColor: `rgb(${lang.bg})`, boxShadow: `0 0 10px rgb(${lang.bg} / 0.8)` }}
              animate={{ left: ["0%", "100%"], opacity: [0, 1, 1, 0] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut", times: [0, 0.15, 0.85, 1] }}
            />
          )}
        </div>

        <div className="shrink-0 rounded-2xl rounded-br-md bg-ink px-4 py-2.5 shadow-[0_8px_20px_rgb(11_12_14/0.16)]">
          <span className="block min-w-16 text-center text-[15px] font-semibold text-white">
            Hello
          </span>
        </div>
      </div>

      {/* language rail — the active chip lifts into its own hue */}
      <ul className="mt-7 flex flex-wrap items-center gap-2">
        {LANGS.map((l, i) => {
          const on = i === index;
          return (
            <li
              key={l.code}
              className={cn(
                "rounded-full border px-3 py-1 text-[12px] font-medium transition-all duration-500",
                on ? "scale-105" : "scale-100",
              )}
              style={
                on
                  ? {
                      backgroundColor: `rgb(${l.bg} / 0.12)`,
                      borderColor: `rgb(${l.bg} / 0.35)`,
                      color: `rgb(${l.fg})`,
                    }
                  : {
                      backgroundColor: "transparent",
                      borderColor: "var(--color-hairline)",
                      color: "var(--color-faint)",
                    }
              }
            >
              {l.name}
            </li>
          );
        })}
        <li className="rounded-full border border-hairline px-3 py-1 text-[12px] font-medium text-faint">
          +114 more
        </li>
      </ul>
    </div>
  );
}

function VoiceWaveform() {
  const reduce = useReducedMotion();
  return (
    <div className="flex h-28 items-end justify-center gap-1 py-2" aria-hidden>
      {WAVE_BARS.map((bar, i) => (
        <motion.span
          key={i}
          className="w-1 origin-bottom rounded-full"
          style={{ height: `${bar.height}%`, backgroundColor: waveBarColor(i) }}
          animate={reduce ? undefined : { scaleY: [1, bar.peak, 1] }}
          transition={{
            duration: bar.duration,
            repeat: Infinity,
            ease: "easeInOut",
            delay: bar.delay,
          }}
        />
      ))}
    </div>
  );
}

function CameraViewfinder() {
  const reduce = useReducedMotion();
  return (
    <div className="relative h-28" aria-hidden>
      <span className="absolute top-1 left-2 h-5 w-5 rounded-tl-lg border-t-[1.5px] border-l-[1.5px] border-teal/50" />
      <span className="absolute top-1 right-2 h-5 w-5 rounded-tr-lg border-t-[1.5px] border-r-[1.5px] border-teal/50" />
      <span className="absolute bottom-1 left-2 h-5 w-5 rounded-bl-lg border-b-[1.5px] border-l-[1.5px] border-teal/50" />
      <span className="absolute right-2 bottom-1 h-5 w-5 rounded-br-lg border-r-[1.5px] border-b-[1.5px] border-teal/50" />
      <motion.div
        className="absolute inset-x-6 h-px"
        style={{
          top: "50%",
          background:
            "linear-gradient(90deg, transparent, rgb(16 179 163 / 0.55), transparent)",
        }}
        animate={reduce ? undefined : { top: ["18%", "82%", "18%"] }}
        transition={{ duration: 3.6, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}

/* -------------------------------------------------------------- card shell */

function OverviewCard({
  href,
  ariaLabel,
  className,
  children,
  delay,
  resting = false,
  parallaxY,
  glow,
}: {
  href: string;
  ariaLabel: string;
  className?: string;
  children: ReactNode;
  delay: number;
  /** exactly one card is visually "on" at rest */
  resting?: boolean;
  /** scroll-linked differential drift; undefined = no drift (mobile / reduced motion) */
  parallaxY?: MotionValue<number>;
  /** "r g b" — a soft corner wash in this card's own hue, warming on hover */
  glow?: string;
}) {
  return (
    <motion.div
      className={cn("min-w-0", className)}
      style={parallaxY ? { y: parallaxY } : undefined}
    >
      <Reveal delay={delay} className="h-full">
        <a
          href={href}
          aria-label={ariaLabel}
          className={cn(
            "group relative flex h-full cursor-pointer flex-col overflow-hidden rounded-card border border-hairline bg-canvas p-8 transition-all duration-300 hover:-translate-y-1 hover:shadow-lift",
            resting && "shadow-soft",
          )}
        >
          {glow ? (
            <div
              aria-hidden
              className="pointer-events-none absolute -top-20 -right-20 h-56 w-56 rounded-full opacity-70 blur-3xl transition-opacity duration-500 group-hover:opacity-100"
              style={{
                background: `radial-gradient(closest-side, rgb(${glow} / 0.18), transparent 70%)`,
              }}
            />
          ) : null}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
            style={{
              backgroundImage:
                "radial-gradient(circle at center, rgba(0,0,0,0.02) 1px, transparent 1px)",
              backgroundSize: "4px 4px",
            }}
          />
          <div className="relative flex h-full flex-col">{children}</div>
          <span
            aria-hidden
            className="absolute right-6 bottom-6 flex translate-y-1 items-center gap-1 text-sm font-medium text-faint opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100"
          >
            Explore
            <ArrowRightIcon className="h-3.5 w-3.5" />
          </span>
        </a>
      </Reveal>
    </motion.div>
  );
}

function CardFooter({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="mt-6">
      <h3 className="text-xl font-medium text-ink">{title}</h3>
      <p className="mt-1.5 text-[11px] font-medium tracking-[0.16em] text-faint uppercase">
        {meta}
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------- section */

export default function ProductOverview() {
  const reduce = useReducedMotion();
  const gridRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: gridRef,
    offset: ["start end", "end start"],
  });

  /* On mobile the grid is single-column and drift between stacked cards reads
     as jitter — only bind the transforms from md up. */
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  /* Differential vertical rates so the bento breathes while passing through
     the viewport. Asymmetric narrow-card values (44 vs 28) prevent the
     mirrored-columns look. Declared unconditionally to satisfy hooks rules. */
  const driftTranslation = useTransform(scrollYProgress, [0, 1], [12, -12]);
  const driftVoice = useTransform(scrollYProgress, [0, 1], [44, -44]);
  const driftCamera = useTransform(scrollYProgress, [0, 1], [28, -28]);
  const driftWorld = useTransform(scrollYProgress, [0, 1], [16, -16]);
  const drift = !reduce && isDesktop;

  return (
    <Section id="overview" tone="surface">
      {/* ambient glow — drifts counter to scroll (furthest layer, slowest) */}
      <ParallaxGlow
        className="absolute top-16 left-[-8%] h-[520px] w-[520px] rounded-full"
        style={{
          background:
            "radial-gradient(closest-side, rgb(76 125 255 / 0.05), transparent)",
        }}
      />
      <div className="shell">
        <SectionHeading
          eyebrow="One app"
          title={
            <>
              Three <span className="text-gradient">superpowers</span>. Zero
              barriers.
            </>
          }
          description="Language, voice and vision live together in a single app — one tap between you and understanding anything, anywhere."
        />

        <div ref={gridRef} className="grid gap-4 md:grid-cols-3">
          <OverviewCard
            href="#translation"
            ariaLabel="AI Translation — 120+ languages. Jump to the translation section."
            className="md:col-span-2"
            delay={0}
            resting
            parallaxY={drift ? driftTranslation : undefined}
            glow="76 125 255"
          >
            <div className="flex flex-1 flex-col justify-center">
              <TranslationScene />
            </div>
            <CardFooter title="AI Translation" meta="120+ languages" />
          </OverviewCard>

          <OverviewCard
            href="#voice"
            ariaLabel="Voice AI — cloning, text to speech and speech to text. Jump to the voice section."
            delay={0.08}
            parallaxY={drift ? driftVoice : undefined}
            glow="110 110 247"
          >
            <div className="flex flex-1 flex-col justify-center">
              <VoiceWaveform />
            </div>
            <CardFooter title="Voice AI" meta="Cloning · TTS · STT" />
          </OverviewCard>

          <OverviewCard
            href="#camera"
            ariaLabel="AI Camera — 16 modes. Jump to the camera section."
            delay={0.16}
            parallaxY={drift ? driftCamera : undefined}
            glow="16 179 163"
          >
            <div className="flex flex-1 flex-col justify-center">
              <CameraViewfinder />
            </div>
            <CardFooter title="AI Camera" meta="16 modes" />
          </OverviewCard>

          <OverviewCard
            href="#camera"
            /* Must describe the chips that actually render (MODE_CHIPS), not the
               full mode roster — naming modes with no matching chip promises
               screen-reader users content that isn't on the card. */
            ariaLabel="Understands your world — camera modes for coins, plants, food, math, landmarks and animals. Jump to the camera section."
            className="md:col-span-2"
            delay={0.24}
            parallaxY={drift ? driftWorld : undefined}
            glow="245 158 11"
          >
            <div className="flex h-full flex-col justify-center">
              <h3 className="text-xl font-medium text-ink">
                Understands your world
              </h3>
              <p className="mt-1.5 max-w-md text-sm text-muted">
                Point the camera at almost anything — YSNAP recognizes it and
                explains it in your language.
              </p>
              <ul className="mt-5 flex flex-wrap gap-2.5">
                {MODE_CHIPS.map((mode) => (
                  <li
                    key={mode.label}
                    className="flex items-center gap-2 rounded-full border border-hairline bg-surface py-1.5 pr-3.5 pl-1.5 text-sm text-muted"
                  >
                    <span
                      className={cn(
                        "flex size-6 items-center justify-center rounded-lg",
                        mode.hue,
                      )}
                    >
                      {mode.icon}
                    </span>
                    {mode.label}
                  </li>
                ))}
              </ul>
            </div>
          </OverviewCard>
        </div>
      </div>
    </Section>
  );
}
