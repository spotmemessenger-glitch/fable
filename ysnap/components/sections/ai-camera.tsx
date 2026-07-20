"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";
import { EASE, spring } from "@/lib/motion";
import { Section, SectionHeading } from "@/components/ui/section";
import { PhoneFrame } from "@/components/ui/phone";
import { PlayIcon, PauseIcon } from "@/components/ui/icons";

/* ------------------------------------------------------------------ data */

type VfProps = { className?: string };

type CameraMode = {
  id: string;
  label: string;
  /** Live-status pill shown inside the viewfinder. */
  chip: string;
  /** One-line description of what this mode does, shown under the result. */
  blurb: string;
  /** "r g b" — this mode's accent. Tints chrome only; the page stays white. */
  accent: string;
  /** Path data for the pill glyph. */
  icon: string;
  Viewfinder: ComponentType<VfProps>;
  result: ReactNode;
};

type FactRow = { label: string; value: string };

const COIN_FACTS: FactRow[] = [
  { label: "Country", value: "India" },
  { label: "Mint", value: "Bombay" },
  { label: "Year", value: "1947" },
  { label: "Est. value", value: "$18–24" },
];

type Macro = { label: string; grams: string; pct: number; accent?: boolean };

const MACROS: Macro[] = [
  { label: "Protein", grams: "4g", pct: 16 },
  { label: "Fat", grams: "6g", pct: 24 },
  { label: "Carbs", grams: "25g", pct: 100, accent: true },
  { label: "Fiber", grams: "2g", pct: 8 },
];

type MathStep = { title: string; math: string };

const MATH_STEPS: MathStep[] = [
  { title: "Factor the quadratic", math: "(x − 2)(x − 3) = 0" },
  { title: "Set each factor to zero", math: "x − 2 = 0  or  x − 3 = 0" },
  { title: "Solve for x", math: "x = 2 or x = 3" },
];

const ESSAY_ACTIONS = ["Rewrite", "Summarize", "Translate", "Read aloud", "Explain"] as const;

/* Declared before MODES: `const` bindings are not hoisted, so the array
   initializer below could not reach these paths if they lived further down. */
const ICON = {
  coin: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0z",
  leaf: "M4 20C4 11 11 4 20 4c0 9-7 16-16 16z M4 20c3.5-5.5 7.5-9.5 12-12",
  pulse: "M3 12h4l2.5-6 3.5 12 2.5-6H21",
  flame:
    "M12 21c-3.6 0-6-2.3-6-5.6 0-2.5 1.5-4.2 2.9-5.8.3 1.1 1 1.9 1.9 2.5C10.5 9 11.3 5.7 14 3c.3 2.8 1.5 4.4 2.8 6 1.1 1.4 2.2 2.8 2.2 4.9 0 3.8-3 7.1-7 7.1z",
  graph: "M4 4v15a1 1 0 0 0 1 1h15 M7 15c3.5 0 5-7 10-8",
  doc: "M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M14 3v4h4 M9.5 12h5 M9.5 15.5h5",
  shield: "M12 3l7 3v5.5c0 4.2-2.8 7.3-7 9.5-4.2-2.2-7-5.3-7-9.5V6l7-3z M12 9v4 M12 15.5v.5",
  droplet: "M12 3.5S6 9.5 6 13.5a6 6 0 0 0 12 0c0-4-6-10-6-10z",
} as const;

/* Function components below are hoisted, so the array can live up here. */
const MODES: CameraMode[] = [
  {
    id: "coin",
    label: "Coin",
    chip: "Identifying coin",
    blurb: "Reads mint marks, year and condition, then values the coin against live collector data.",
    accent: "217 158 46", // warm gold
    icon: ICON.coin,
    Viewfinder: CoinViewfinder,
    result: <CoinResult />,
  },
  {
    id: "plant",
    label: "Plant",
    chip: "Recognising plant",
    blurb: "Identifies the species from leaf shape and venation, then reads its health and care needs.",
    accent: "52 184 113", // soft green
    icon: ICON.leaf,
    Viewfinder: PlantViewfinder,
    result: <PlantResult />,
  },
  {
    id: "medical",
    label: "Medical",
    chip: "Analysing skin",
    blurb: "Flags visual patterns worth a professional look — guidance, never a diagnosis.",
    accent: "56 165 232", // sky blue
    icon: ICON.pulse,
    Viewfinder: MedicalViewfinder,
    result: <MedicalResult />,
  },
  {
    id: "food",
    label: "Food",
    chip: "Estimating nutrition",
    blurb: "Recognises the dish, estimates the portion and breaks down calories and macros.",
    accent: "240 138 58", // soft orange
    icon: ICON.flame,
    Viewfinder: FoodViewfinder,
    result: <FoodResult />,
  },
  {
    id: "math",
    label: "Math",
    chip: "Solving equation",
    blurb: "Reads handwritten or printed maths and works through the solution step by step.",
    accent: "76 125 255", // royal blue
    icon: ICON.graph,
    Viewfinder: MathViewfinder,
    result: <MathResult />,
  },
  {
    id: "essay",
    label: "Essay",
    chip: "Scanning text",
    blurb: "Lifts text off the page, then rewrites, summarises, translates or reads it aloud.",
    accent: "124 92 240", // purple
    icon: ICON.doc,
    Viewfinder: EssayViewfinder,
    result: <EssayResult />,
  },
];

/** Math leads: the most visually complete demo of the six. */
const DEFAULT_MODE = MODES.findIndex((m) => m.id === "math");

/* ------------------------------------------------------------------ section */

export default function AICamera() {
  const reduce = useReducedMotion();
  const [active, setActive] = useState(DEFAULT_MODE);
  const [playing, setPlaying] = useState(false);

  /* Autoplay is strictly opt-in: it never starts on its own, and any manual
     selection stops it, so the user always holds control of the demo. */
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => setActive((i) => (i + 1) % MODES.length), 4500);
    return () => window.clearInterval(id);
  }, [playing]);

  const select = (i: number) => {
    setActive(i);
    setPlaying(false);
  };

  const mode = MODES[active];
  const accent = mode.accent;

  return (
    /* No pin, no scrub, no ScrollTrigger: this is an ordinary section, so the
       page scrolls straight past it unless the visitor chooses to interact. */
    <Section id="camera" tone="surface">
      <div className="shell">
        <SectionHeading
          eyebrow="AI Camera"
          title={
            <>
              Point it at <span className="text-gradient">anything.</span>
            </>
          }
          description="The camera that understands the world in front of it. Pick a mode to see it work."
        />

        <div className="flex flex-col gap-7 lg:grid lg:grid-cols-[190px_264px_minmax(0,1fr)] lg:items-start lg:gap-10">
          {/* ------------------------------------------------ rail (lg+) */}
          <div className="hidden lg:order-1 lg:block">
            <ModeList active={active} onSelect={select} />
            <PlayToggle playing={playing} onToggle={() => setPlaying((p) => !p)} accent={accent} />
          </div>

          {/* ------------------------------------------------ phone */}
          <div className="order-1 mx-auto w-full max-w-[264px] lg:order-2">
            <PhoneFrame width={264}>
              <div
                aria-hidden
                className="absolute inset-0 bg-[linear-gradient(180deg,#f7f8fb_0%,#ffffff_65%)]"
              />
              <div aria-hidden className="absolute inset-x-0 top-11 z-[3] text-center">
                <span className="text-[9px] font-semibold uppercase tracking-[0.3em] text-faint">
                  AI Camera
                </span>
              </div>

              {/* viewfinder — crossfade + scale + blur between modes */}
              <AnimatePresence mode="wait">
                <motion.div
                  key={mode.id}
                  className="absolute inset-0 z-[2] flex items-center justify-center pb-16 pt-10"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.05, filter: "blur(8px)" }}
                  animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, filter: "blur(0px)" }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, filter: "blur(8px)" }}
                  transition={{ duration: 0.5, ease: EASE }}
                >
                  <mode.Viewfinder className="h-auto w-[84%]" />
                </motion.div>
              </AnimatePresence>

              {/* live-status chip, tinted to the active mode */}
              <AnimatePresence mode="wait">
                <motion.div
                  key={`${mode.id}-chip`}
                  aria-hidden
                  className="absolute bottom-[86px] left-1/2 z-[5] flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border border-hairline bg-white/85 px-3 py-1 backdrop-blur"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
                  transition={{ duration: 0.35, ease: EASE }}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: `rgb(${accent})` }} />
                  <span className="text-[10.5px] font-medium tracking-wide text-ink-soft">{mode.chip}</span>
                </motion.div>
              </AnimatePresence>

              {/* brackets + scan sweep — replays on every mode change */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-[9%] bottom-[27%] top-[17%] z-[4]"
              >
                <Brackets className="absolute inset-0" accent={accent} />
                {!reduce && (
                  <motion.div
                    key={`${mode.id}-scan`}
                    className="absolute left-1 right-1 h-12"
                    style={{
                      background: `linear-gradient(to bottom, rgb(${accent} / 0), rgb(${accent} / 0.14))`,
                    }}
                    initial={{ top: "-12%" }}
                    animate={{ top: ["-12%", "88%"] }}
                    transition={{
                      duration: 2.6,
                      repeat: Infinity,
                      repeatType: "reverse",
                      ease: "easeInOut",
                    }}
                  >
                    <div
                      className="absolute inset-x-0 bottom-0 h-[2px] rounded-full"
                      style={{
                        backgroundColor: `rgb(${accent} / 0.6)`,
                        boxShadow: `0 0 12px rgb(${accent} / 0.5)`,
                      }}
                    />
                  </motion.div>
                )}
              </div>

              {/* shutter */}
              <div aria-hidden className="absolute bottom-5 left-1/2 z-[5] -translate-x-1/2">
                <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-ink/20">
                  <div className="h-9 w-9 rounded-full bg-ink/80" />
                </div>
              </div>
            </PhoneFrame>
          </div>

          {/* --------------------------- segmented control (below lg) */}
          <div className="order-2 lg:hidden">
            <div className="-mx-6 overflow-x-auto px-6 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <ul className="flex w-max items-center gap-2">
                {MODES.map((m, i) => {
                  const on = i === active;
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => select(i)}
                        aria-pressed={on}
                        className={cn(
                          "flex h-11 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors duration-300",
                          on ? "text-ink" : "border-hairline text-faint",
                        )}
                        style={
                          on
                            ? {
                                backgroundColor: `rgb(${m.accent} / 0.1)`,
                                borderColor: `rgb(${m.accent} / 0.35)`,
                              }
                            : undefined
                        }
                      >
                        <span
                          className="h-1.5 w-1.5 rounded-full transition-opacity duration-300"
                          style={{ backgroundColor: `rgb(${m.accent})`, opacity: on ? 1 : 0.35 }}
                        />
                        {m.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="mt-4 flex justify-center">
              <PlayToggle
                playing={playing}
                onToggle={() => setPlaying((p) => !p)}
                accent={accent}
                className="mt-0"
              />
            </div>
          </div>

          {/* ------------------------------------------------ result panel */}
          <div className="order-3 min-w-0 lg:order-3">
            <AnimatePresence mode="wait">
              <motion.div
                key={mode.id}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 22, filter: "blur(8px)" }}
                animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -16, filter: "blur(8px)" }}
                transition={{ duration: 0.5, ease: EASE }}
              >
                <div
                  className="rounded-card border bg-surface p-6 shadow-soft transition-colors duration-500"
                  style={{ borderColor: `rgb(${accent} / 0.2)` }}
                >
                  {mode.result}
                </div>
                <p className="mt-4 text-sm leading-relaxed text-muted">{mode.blurb}</p>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        <p className="mt-10 text-center text-[13px] text-faint">
          Six of the 12 AI camera modes, shown as they appear in the app.
        </p>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ controls */

/** Vertical pill rail (lg+). The active pill is a shared-layout element, so it
 *  glides between rows rather than popping. */
function ModeList({ active, onSelect }: { active: number; onSelect: (i: number) => void }) {
  const reduce = useReducedMotion();
  return (
    <ul className="flex flex-col gap-1.5">
      {MODES.map((m, i) => {
        const on = i === active;
        return (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => onSelect(i)}
              aria-pressed={on}
              className="group relative flex w-full cursor-pointer items-center gap-3 rounded-full px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {on && (
                <motion.span
                  aria-hidden
                  layoutId="camera-mode-pill"
                  className="absolute inset-0 rounded-full"
                  style={{
                    backgroundColor: `rgb(${m.accent} / 0.09)`,
                    boxShadow: `inset 0 0 0 1px rgb(${m.accent} / 0.22)`,
                  }}
                  transition={reduce ? { duration: 0 } : spring}
                />
              )}
              <span
                className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors duration-300"
                style={{
                  backgroundColor: `rgb(${m.accent} / ${on ? 0.16 : 0.07})`,
                  color: `rgb(${m.accent})`,
                }}
              >
                <GlyphIcon d={m.icon} className="h-[15px] w-[15px]" />
              </span>
              <span
                className={cn(
                  "relative text-sm font-medium transition-colors duration-300",
                  on ? "text-ink" : "text-faint group-hover:text-ink",
                )}
              >
                {m.label}
              </span>
              <span
                aria-hidden
                className="relative ml-auto h-1.5 w-1.5 rounded-full transition-opacity duration-300"
                style={{ backgroundColor: `rgb(${m.accent})`, opacity: on ? 1 : 0 }}
              />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Opt-in autoplay. Never runs until pressed; pressing again stops it. */
function PlayToggle({
  playing,
  onToggle,
  accent,
  className,
}: {
  playing: boolean;
  onToggle: () => void;
  accent: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "mt-5 flex cursor-pointer items-center gap-2 rounded-full border px-4 py-2 text-[13px] font-medium transition-colors duration-300",
        playing ? "text-ink" : "border-hairline text-muted hover:text-ink",
        className,
      )}
      style={
        playing
          ? { backgroundColor: `rgb(${accent} / 0.1)`, borderColor: `rgb(${accent} / 0.3)` }
          : undefined
      }
    >
      {playing ? <PauseIcon className="h-3.5 w-3.5" /> : <PlayIcon className="h-3.5 w-3.5" />}
      {playing ? "Pause demo" : "Play demo"}
    </button>
  );
}

/* ------------------------------------------------------------------ chrome */

function Brackets({ className, accent }: { className?: string; accent?: string }) {
  const corner = "absolute h-5 w-5 transition-colors duration-500";
  const tint = accent ? { borderColor: `rgb(${accent} / 0.5)` } : undefined;
  return (
    <div aria-hidden className={cn("pointer-events-none", className)}>
      <div style={tint} className={cn(corner, !accent && "border-ink/35", "left-0 top-0 rounded-tl-lg border-l-[1.5px] border-t-[1.5px]")} />
      <div style={tint} className={cn(corner, !accent && "border-ink/35", "right-0 top-0 rounded-tr-lg border-r-[1.5px] border-t-[1.5px]")} />
      <div style={tint} className={cn(corner, !accent && "border-ink/35", "bottom-0 left-0 rounded-bl-lg border-b-[1.5px] border-l-[1.5px]")} />
      <div style={tint} className={cn(corner, !accent && "border-ink/35", "bottom-0 right-0 rounded-br-lg border-b-[1.5px] border-r-[1.5px]")} />
    </div>
  );
}

function GlyphIcon({ d, className }: { d: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("h-[18px] w-[18px]", className)}
    >
      <path d={d} />
    </svg>
  );
}

/* ------------------------------------------------------------------ result-card building blocks */

function CardHeader({
  icon,
  title,
  sub,
  badge,
}: {
  icon: ReactNode;
  title: string;
  sub?: string;
  badge?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/[0.08] text-accent">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[17px] font-medium leading-tight text-ink">{title}</h3>
        {sub ? <p className="mt-1 text-[13px] text-faint">{sub}</p> : null}
      </div>
      {badge ? <AccentBadge>{badge}</AccentBadge> : null}
    </div>
  );
}

function AccentBadge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-full border border-accent/20 bg-accent/[0.07] px-2.5 py-1 text-[11px] font-medium leading-none text-accent-deep">
      {children}
    </span>
  );
}

/** Fills from zero each time its panel mounts, so switching modes builds the graph. */
function MeterBar({ pct, className }: { pct: number; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.06]", className)}>
      <motion.div
        className="h-full rounded-full bg-accent"
        initial={reduce ? { width: `${pct}%` } : { width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.9, ease: EASE, delay: 0.25 }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ results */

function CoinResult() {
  return (
    <div className="flex flex-col gap-4">
      <CardHeader icon={<GlyphIcon d={ICON.coin} />} title="1947 One Rupee · India" sub="King George VI series" />
      <div>
        <AccentBadge>Rare · Independence year</AccentBadge>
      </div>
      <dl className="border-y border-hairline">
        {COIN_FACTS.map((f) => (
          <div
            key={f.label}
            className="flex items-baseline justify-between border-b border-hairline py-2.5 text-sm last:border-b-0"
          >
            <dt className="text-faint">{f.label}</dt>
            <dd className="font-medium tabular-nums text-ink">{f.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[13.5px] leading-relaxed text-muted">
        Struck the year British India became two nations — the last rupee of an empire.
      </p>
    </div>
  );
}

function PlantResult() {
  return (
    <div className="flex flex-col gap-4">
      <CardHeader
        icon={<GlyphIcon d={ICON.leaf} />}
        title="Monstera deliciosa"
        sub="Swiss cheese plant"
        badge="Air-purifying"
      />
      <div className="flex items-center gap-3 rounded-xl border border-hairline bg-sunken/60 px-3.5 py-3">
        <span className="text-accent">
          <GlyphIcon d={ICON.droplet} />
        </span>
        <p className="text-sm text-muted">
          Water <span className="font-medium text-ink">every 7 days</span>
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-faint">Health</span>
          <span className="font-medium text-ink">
            Thriving <span className="tabular-nums text-muted">· 92%</span>
          </span>
        </div>
        <MeterBar pct={92} />
      </div>
      <p className="text-[13.5px] leading-relaxed text-muted">
        Loves bright, indirect light — wipe the leaves monthly so they can breathe.
      </p>
    </div>
  );
}

function MedicalResult() {
  return (
    <div className="flex flex-col gap-4">
      <CardHeader icon={<GlyphIcon d={ICON.pulse} />} title="Visual analysis" sub="Skin · forearm" />
      <div className="rounded-xl border border-hairline px-3.5 py-3">
        <p className="text-[12px] uppercase tracking-[0.12em] text-muted">Possible condition</p>
        <p className="mt-1 text-[15px] font-medium text-ink">Mild contact dermatitis</p>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-faint">Confidence</span>
          <span className="font-medium tabular-nums text-ink">87%</span>
        </div>
        <MeterBar pct={87} />
      </div>
      <div className="flex items-start gap-2.5 rounded-xl bg-sunken px-3.5 py-3">
        <span className="mt-0.5 shrink-0 text-muted">
          <GlyphIcon d={ICON.shield} className="h-4 w-4" />
        </span>
        <p className="text-[13px] font-medium leading-snug text-muted">
          Not a diagnosis. Always consult a healthcare professional.
        </p>
      </div>
    </div>
  );
}

function FoodResult() {
  return (
    <div className="flex flex-col gap-4">
      <CardHeader
        icon={<GlyphIcon d={ICON.flame} />}
        title="Masala Dosa"
        sub="South Indian · 1 serving"
        badge="168 kcal"
      />
      <ul className="flex flex-col gap-2.5">
        {MACROS.map((m, i) => (
          <li key={m.label} className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-[12px] text-muted">{m.label}</span>
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-ink/[0.05]">
              <motion.span
                className={cn("block h-full rounded-full", m.accent ? "bg-accent" : "bg-ink/70")}
                initial={{ width: 0 }}
                animate={{ width: `${m.pct}%` }}
                transition={{ duration: 0.9, ease: EASE, delay: 0.25 + i * 0.08 }}
              />
            </span>
            <span className="w-9 shrink-0 text-right text-[12px] font-medium tabular-nums text-ink">
              {m.grams}
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t border-hairline pt-3 text-[13.5px] leading-relaxed text-muted">
        Lighter pairing: sambar over chutney.
      </p>
    </div>
  );
}

function MathResult() {
  return (
    <div className="flex flex-col gap-4">
      <CardHeader icon={<GlyphIcon d={ICON.graph} />} title="Solved in three steps" sub="x² − 5x + 6 = 0" />
      <ol className="flex flex-col gap-2">
        {MATH_STEPS.map((s, i) => (
          <motion.li
            key={s.title}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.4, ease: EASE, delay: 0.3 + i * 0.14 }}
            className="flex items-center gap-3 rounded-xl border border-hairline px-3.5 py-2.5"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sunken text-[11px] font-semibold tabular-nums text-ink-soft">
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.12em] text-faint">{s.title}</p>
              <p
                className="text-[14px] font-medium italic text-ink"
                style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
              >
                {s.math}
              </p>
            </div>
          </motion.li>
        ))}
      </ol>
      <div className="flex items-center gap-4">
        <ParabolaGlyph className="h-16 w-auto shrink-0" />
        <p className="text-[12.5px] leading-snug text-faint">The curve crosses zero at x = 2 and x = 3.</p>
      </div>
    </div>
  );
}

function EssayResult() {
  return (
    <div className="flex flex-col gap-4">
      <CardHeader icon={<GlyphIcon d={ICON.doc} />} title="Essay scanned" sub="412 words · English" />
      <div className="flex flex-wrap gap-2">
        {ESSAY_ACTIONS.map((a) => (
          <span
            key={a}
            className="rounded-full border border-hairline bg-surface px-3.5 py-1.5 text-[13px] font-medium text-ink-soft"
          >
            {a}
          </span>
        ))}
      </div>
      <div className="rounded-xl border border-hairline bg-sunken/60 px-3.5 py-3">
        <p className="text-[11px] uppercase tracking-[0.12em] text-faint">Summary</p>
        <p className="mt-1 text-[13.5px] leading-relaxed text-muted">
          Argues that later school start times improve results, citing sleep research and attendance data.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ viewfinder illustrations */

function CoinViewfinder({ className }: VfProps) {
  return (
    <svg viewBox="0 0 200 200" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <circle cx="100" cy="100" r="76" className="stroke-accent/50" strokeWidth="1.5" strokeDasharray="2 7" />
      <circle cx="100" cy="100" r="62" className="stroke-ink" strokeWidth="1.5" />
      <circle cx="100" cy="100" r="54" className="stroke-ink/30" strokeWidth="1" />
      <text
        x="100"
        y="99"
        textAnchor="middle"
        fontSize="32"
        className="fill-ink"
        style={{ fontFamily: "Georgia, serif" }}
      >
        ₹
      </text>
      <text x="100" y="122" textAnchor="middle" fontSize="11" letterSpacing="3" className="fill-ink/60">
        1947
      </text>
      {/* laurel */}
      <path d="M74 140c-8-8-11-19-9-30" className="stroke-ink/50" strokeWidth="1.5" />
      <path d="M70 128l-8-3 M67 118l-8-1 M67 108l-8 2" className="stroke-ink/50" strokeWidth="1.5" />
      <path d="M126 140c8-8 11-19 9-30" className="stroke-ink/50" strokeWidth="1.5" />
      <path d="M130 128l8-3 M133 118l8-1 M133 108l8 2" className="stroke-ink/50" strokeWidth="1.5" />
    </svg>
  );
}

function PlantViewfinder({ className }: VfProps) {
  return (
    <svg viewBox="0 0 200 200" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <rect x="24" y="18" width="152" height="150" rx="16" className="stroke-accent/40" strokeWidth="1.5" strokeDasharray="2 7" />
      {/* monstera leaf */}
      <path
        d="M100 118C66 124 36 104 33 76 30 52 50 32 74 35c11 1.5 22 8 26 19 4-11 15-17.5 26-19 24-3 44 17 41 41-3 28-33 48-67 42z"
        className="stroke-ink"
        strokeWidth="1.5"
      />
      <path d="M100 54v62" className="stroke-ink/60" strokeWidth="1.2" />
      <path d="M52 60l38 18 M42 84l46 8 M58 104l34-2" className="stroke-ink/50" strokeWidth="1.2" />
      <path d="M148 60l-38 18 M158 84l-46 8 M142 104l-34-2" className="stroke-ink/50" strokeWidth="1.2" />
      <ellipse cx="88" cy="98" rx="2.5" ry="4" className="stroke-ink/50" strokeWidth="1.2" />
      <ellipse cx="112" cy="98" rx="2.5" ry="4" className="stroke-ink/50" strokeWidth="1.2" />
      {/* stem */}
      <path d="M100 118c0 22-4 40-8 58" className="stroke-ink" strokeWidth="1.5" />
    </svg>
  );
}

function MedicalViewfinder({ className }: VfProps) {
  return (
    <svg viewBox="0 0 200 200" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      {/* forearm */}
      <path d="M28 152c30-10 66-30 98-56 12-10 22-20 30-32" className="stroke-ink" strokeWidth="1.5" />
      <path d="M50 178c32-12 64-34 92-60 8-8 16-18 22-28" className="stroke-ink" strokeWidth="1.5" />
      <path d="M156 64c6-6 13-7 18-2" className="stroke-ink/60" strokeWidth="1.5" />
      {/* highlighted patch */}
      <ellipse
        cx="102"
        cy="134"
        rx="17"
        ry="11"
        transform="rotate(-24 102 134)"
        className="fill-accent/10 stroke-accent"
        strokeWidth="1.5"
        strokeDasharray="3 4"
      />
      <circle cx="98" cy="132" r="1.4" className="fill-ink/40" />
      <circle cx="106" cy="136" r="1.4" className="fill-ink/40" />
      <circle cx="102" cy="128" r="1.4" className="fill-ink/40" />
    </svg>
  );
}

function FoodViewfinder({ className }: VfProps) {
  return (
    <svg viewBox="0 0 200 200" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <circle cx="100" cy="102" r="88" className="stroke-accent/40" strokeWidth="1.5" strokeDasharray="2 7" />
      {/* plate */}
      <circle cx="100" cy="102" r="76" className="stroke-ink" strokeWidth="1.5" />
      <circle cx="100" cy="102" r="62" className="stroke-ink/25" strokeWidth="1" />
      {/* rolled dosa */}
      <g transform="rotate(-16 100 103)">
        <rect x="40" y="88" width="120" height="30" rx="15" className="stroke-ink" strokeWidth="1.5" />
        <path d="M78 90c-2 9-2 18 0 26 M118 90c-2 9-2 18 0 26" className="stroke-ink/40" strokeWidth="1.2" />
      </g>
      {/* chutney + sambar bowls */}
      <circle cx="152" cy="148" r="13" className="stroke-ink/60" strokeWidth="1.2" />
      <circle cx="152" cy="148" r="6" className="stroke-ink/25" strokeWidth="1" />
      <circle cx="48" cy="146" r="11" className="stroke-ink/60" strokeWidth="1.2" />
    </svg>
  );
}

function MathViewfinder({ className }: VfProps) {
  return (
    <svg viewBox="0 0 200 200" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M32 64h136 M32 96h136 M32 128h136 M32 160h136" className="stroke-ink/10" strokeWidth="1" />
      <text
        x="100"
        y="88"
        textAnchor="middle"
        fontSize="21"
        className="fill-ink italic"
        style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
      >
        x² − 5x + 6 = 0
      </text>
      <path d="M48 102c34 8 70 6 104-2" className="stroke-accent/70" strokeWidth="1.5" />
      <text
        x="100"
        y="122"
        textAnchor="middle"
        fontSize="13"
        className="fill-ink/50 italic"
        style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
      >
        (x − 2)(x − 3) = 0
      </text>
    </svg>
  );
}

function EssayViewfinder({ className }: VfProps) {
  return (
    <svg viewBox="0 0 200 200" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <rect x="28" y="22" width="144" height="152" rx="10" className="stroke-ink/20" strokeWidth="1.2" />
      <rect x="42" y="40" width="86" height="7" rx="3.5" className="fill-ink/70" />
      <rect x="42" y="62" width="118" height="5" rx="2.5" className="fill-ink/15" />
      <rect x="42" y="76" width="110" height="5" rx="2.5" className="fill-ink/15" />
      <rect x="38" y="87" width="126" height="13" rx="4" className="fill-accent/15" />
      <rect x="42" y="90" width="118" height="5" rx="2.5" className="fill-ink/30" />
      <rect x="42" y="104" width="96" height="5" rx="2.5" className="fill-ink/15" />
      <rect x="42" y="118" width="114" height="5" rx="2.5" className="fill-ink/15" />
      <rect x="42" y="132" width="72" height="5" rx="2.5" className="fill-ink/15" />
      <rect x="42" y="150" width="52" height="5" rx="2.5" className="fill-ink/25" />
    </svg>
  );
}

function ParabolaGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 132 76" fill="none" strokeLinecap="round" aria-hidden className={className}>
      <path d="M10 58h112 M22 8v60" className="stroke-ink/25" strokeWidth="1.2" />
      <path d="M36 12Q70 120 104 12" className="stroke-accent" strokeWidth="1.5" />
      <circle cx="57" cy="58" r="2.5" className="fill-accent" />
      <circle cx="83" cy="58" r="2.5" className="fill-accent" />
      <text x="57" y="72" textAnchor="middle" fontSize="9" className="fill-faint">
        2
      </text>
      <text x="83" y="72" textAnchor="middle" fontSize="9" className="fill-faint">
        3
      </text>
    </svg>
  );
}
