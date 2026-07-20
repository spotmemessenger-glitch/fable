"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Section, SectionHeading } from "@/components/ui/section";
import { Reveal } from "@/components/ui/reveal";
import { TiltCard } from "@/components/ui/tilt-card";

/**
 * CameraModes — bento grid of the 12 AI camera modes. Each card carries ONE
 * hue from the spectrum: the icon sits in a tinted chip, and the hover
 * example-result pill picks up the same hue for its dot and border. The grid
 * closes with a dark feature cell — a slowly rotating ring of all twelve hue
 * dots around an aperture glyph.
 */

type Hue = "accent" | "violet" | "teal" | "coral" | "amber" | "green" | "rose";

type Mode = {
  name: string;
  description: string;
  chip: string;
  hue: Hue;
  /** true → lg:col-span-2 for bento asymmetry */
  wide?: boolean;
  icon: ReactNode;
};

/** Static class/hex map so Tailwind sees every literal. One hue per card. */
const HUE_STYLES: Record<Hue, { chip: string; dot: string; orbit: string; hex: string }> = {
  accent: { chip: "bg-accent/10 text-accent", dot: "bg-accent/70", orbit: "bg-accent", hex: "#4c7dff" },
  violet: { chip: "bg-violet/10 text-violet", dot: "bg-violet/70", orbit: "bg-violet", hex: "#6e6ef7" },
  teal: { chip: "bg-teal/10 text-teal", dot: "bg-teal/70", orbit: "bg-teal", hex: "#10b3a3" },
  coral: { chip: "bg-coral/10 text-coral", dot: "bg-coral/70", orbit: "bg-coral", hex: "#ff6b5e" },
  amber: { chip: "bg-amber/10 text-amber", dot: "bg-amber/70", orbit: "bg-amber", hex: "#f59e0b" },
  green: { chip: "bg-green/10 text-green", dot: "bg-green/70", orbit: "bg-green", hex: "#34b871" },
  rose: { chip: "bg-rose/10 text-rose", dot: "bg-rose/70", orbit: "bg-rose", hex: "#f0559c" },
};

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const MODES: Mode[] = [
  {
    name: "Coins",
    description: "Identify currency, mint year, and collector value.",
    chip: "1947 One Rupee",
    hue: "amber",
    wide: true,
    icon: (
      <svg {...iconProps} className="h-6 w-6" aria-hidden>
        <circle cx="12" cy="12" r="8.25" />
        <circle cx="12" cy="12" r="4.75" />
        <path d="M12 5.2v1.4M12 17.4v1.4M5.2 12h1.4M17.4 12h1.4" />
      </svg>
    ),
  },
  {
    name: "Plants",
    description: "Name any houseplant or wildflower from one photo.",
    chip: "Monstera",
    hue: "green",
    icon: (
      <svg {...iconProps} className="h-6 w-6" aria-hidden>
        <path d="M5.5 18.5C5.5 11 11 5.5 19.5 5c-.5 8.5-6 14-14 13.5Z" />
        <path d="M6.5 17.5C9 13 12.5 9.5 17 7" />
      </svg>
    ),
  },
  {
    name: "Trees",
    description: "Species, age estimate, and care notes from bark or leaf.",
    chip: "Banyan",
    hue: "teal",
    icon: (
      <svg {...iconProps} className="h-6 w-6" aria-hidden>
        <circle cx="12" cy="12.5" r="7.75" />
        <path d="M12 7.75a4.75 4.75 0 0 1 4.75 4.75" />
        <path d="M12 10.5a2 2 0 0 1 2 2" />
        <path d="M12 12.5h.01" />
      </svg>
    ),
  },
  {
    name: "Food",
    description: "Recognize dishes and cuisines in a single frame.",
    chip: "Pad Thai",
    hue: "coral",
    icon: (
      <svg {...iconProps} className="h-6 w-6" aria-hidden>
        <path d="M5 16.5a7 7 0 0 1 14 0" />
        <path d="M3.5 16.5h17" />
        <circle cx="12" cy="7.5" r="1.25" />
      </svg>
    ),
  },
  {
    name: "Calories",
    description: "Estimate calories and macros before the first bite.",
    chip: "168 kcal",
    hue: "rose",
    icon: (
      <svg {...iconProps} className="h-6 w-6" aria-hidden>
        <path d="M12 3.5c2.6 3 5 5.4 5 8.7a5 5 0 0 1-10 0c0-3.3 2.4-5.7 5-8.7Z" />
        <path d="M12 16.5a1.9 1.9 0 0 1-1.9-1.9c0-1.1.8-1.9 1.9-2.9 1.1 1 1.9 1.8 1.9 2.9a1.9 1.9 0 0 1-1.9 1.9Z" />
      </svg>
    ),
  },
  {
    name: "Medical",
    description: "Understand labels, dosage, and generic equivalents.",
    chip: "87% confidence",
    hue: "accent",
    wide: true,
    icon: (
      <svg {...iconProps} className="h-6 w-6" aria-hidden>
        <path d="M12 3.25 18.75 5.7v4.9c0 4.6-2.9 7.9-6.75 9.9-3.85-2-6.75-5.3-6.75-9.9V5.7L12 3.25Z" />
        <path d="M12 8.75v6M9 11.75h6" />
      </svg>
    ),
  },
  {
    name: "Essay",
    description: "Turn pages of writing into a crisp summary.",
    chip: "Summarized",
    hue: "violet",
    icon: (
      <svg {...iconProps} className="h-6 w-6" aria-hidden>
        <path d="M13.5 3.25H6.75c-.69 0-1.25.56-1.25 1.25v15c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25V8.25l-5-5Z" />
        <path d="M13.5 3.25v5h5" />
        <path d="M9 13h6M9 16.25h3.75" />
      </svg>
    ),
  },
  {
    name: "OCR",
    description: "Lift printed or handwritten text from anything.",
    chip: "12 lines read",
    hue: "accent",
    icon: (
      <svg {...iconProps} className="h-6 w-6" aria-hidden>
        <path d="M4.5 8V6A1.5 1.5 0 0 1 6 4.5h2M16 4.5h2A1.5 1.5 0 0 1 19.5 6v2M19.5 16v2a1.5 1.5 0 0 1-1.5 1.5h-2M8 19.5H6A1.5 1.5 0 0 1 4.5 18v-2" />
        <path d="M9.25 16.25 12 8.5l2.75 7.75M10.15 13.75h3.7" />
      </svg>
    ),
  },
  {
    name: "Math",
    description: "Solve equations step by step from a snapshot.",
    chip: "x = 2, 3",
    hue: "violet",
    icon: (
      <svg {...iconProps} className="h-6 w-6" aria-hidden>
        <path d="M15.5 6.5H8.75L13.5 12l-4.75 5.5H15.5" />
        <path d="M18.75 4.25v3.5M17 6h3.5" />
      </svg>
    ),
  },
  {
    name: "Landmarks",
    description: "Know the story behind any monument you meet.",
    chip: "Taj Mahal",
    hue: "amber",
    icon: (
      <svg {...iconProps} className="h-6 w-6" aria-hidden>
        <path d="M6.5 19.5v-6.75a5.5 5.5 0 0 1 11 0v6.75" />
        <path d="M12 4.75h.01" />
        <path d="M4 19.5h16" />
      </svg>
    ),
  },
  {
    name: "Animals",
    description: "Identify breeds and species in the wild or at home.",
    chip: "Golden Retriever",
    hue: "coral",
    icon: (
      <svg {...iconProps} className="h-6 w-6" aria-hidden>
        <circle cx="7.25" cy="9.75" r="1.6" />
        <circle cx="12" cy="8" r="1.7" />
        <circle cx="16.75" cy="9.75" r="1.6" />
        <path d="M12 12.5c2.6 0 4.75 1.9 4.75 4a2.3 2.3 0 0 1-3 2.2 5.6 5.6 0 0 0-3.5 0 2.3 2.3 0 0 1-3-2.2c0-2.1 2.15-4 4.75-4Z" />
      </svg>
    ),
  },
  {
    name: "Objects",
    description: "Detect and label everything in the frame.",
    chip: "3 objects",
    hue: "teal",
    icon: (
      <svg {...iconProps} className="h-6 w-6" aria-hidden>
        <path d="M12 3.25 19.5 7.5v9L12 20.75 4.5 16.5v-9L12 3.25Z" />
        <path d="M12 12 19.5 7.5M12 12 4.5 7.5M12 12v8.75" />
      </svg>
    ),
  },
];

/**
 * Orbit animation for the dark finale cell. Transform-only; the boost layer
 * is paused at rest and runs on hover, so the speed-up composes smoothly
 * (no angle jump). Fully disabled under prefers-reduced-motion.
 */
const ORBIT_CSS = `
@keyframes ysnap-orbit-spin { to { transform: rotate(1turn); } }
.mode-orbit { animation: ysnap-orbit-spin 40s linear infinite; }
.mode-orbit-boost { animation: ysnap-orbit-spin 18s linear infinite; animation-play-state: paused; }
.mode-finale:hover .mode-orbit-boost { animation-play-state: running; }
@media (prefers-reduced-motion: reduce) {
  .mode-orbit, .mode-orbit-boost { animation: none; }
}
`;

export default function CameraModes() {
  return (
    <Section id="modes" tone="canvas">
      {/* faint ambient glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-24 h-[560px] w-[860px] -translate-x-1/2 blur-3xl"
        style={{
          background: "radial-gradient(closest-side, rgb(76 125 255 / 0.06), transparent)",
        }}
      />
      <div className="shell relative">
        <SectionHeading
          eyebrow="Every mode"
          title={
            <>
              Twelve ways of <span className="text-gradient">seeing.</span>
            </>
          }
          description="Point the camera at anything — YSNAP picks the right specialist and answers in a blink."
        />

        <ul className="grid list-none grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {MODES.map((mode, i) => {
            const hue = HUE_STYLES[mode.hue];
            return (
              <Reveal
                key={mode.name}
                as="li"
                delay={i * 0.05}
                className={cn(mode.wide && "lg:col-span-2")}
              >
                <TiltCard className="h-full rounded-card border border-hairline bg-surface shadow-soft transition-shadow duration-300 hover:shadow-lift">
                  <div className="relative flex h-full min-h-44 flex-col overflow-hidden rounded-[inherit] p-6">
                    {/* dot-matrix texture, revealed on hover */}
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                      style={{
                        backgroundImage:
                          "radial-gradient(circle at center, rgb(0 0 0 / 0.035) 1px, transparent 1px)",
                        backgroundSize: "4px 4px",
                      }}
                    />
                    {/* hue chip — the card's single color moment */}
                    <div
                      className={cn(
                        "relative grid h-11 w-11 place-items-center rounded-xl",
                        hue.chip,
                      )}
                    >
                      {mode.icon}
                    </div>
                    <h3 className="relative mt-4 text-base font-medium tracking-tight text-ink">
                      {mode.name}
                    </h3>
                    <p className="relative mt-1 max-w-xs text-sm leading-relaxed text-muted">
                      {mode.description}
                    </p>
                    <div className="relative mt-auto pt-4">
                      <span
                        className="glass inline-flex translate-y-1 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-ink-soft opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100"
                        style={{ borderColor: `${hue.hex}40` }}
                      >
                        <span
                          aria-hidden
                          className={cn("h-1.5 w-1.5 rounded-full", hue.dot)}
                        />
                        {mode.chip}
                      </span>
                    </div>
                  </div>
                </TiltCard>
              </Reveal>
            );
          })}

          {/* dark finale cell — completes the lg grid so the bento ends flush */}
          <li className="hidden lg:col-span-2 lg:flex">
            <Reveal delay={MODES.length * 0.05} className="w-full">
              <style>{ORBIT_CSS}</style>
              <div className="mode-finale relative flex h-full min-h-44 w-full items-center gap-7 overflow-hidden rounded-card bg-ink p-7 text-white shadow-soft">
                {/* faint multi-hue glow tucked in the corner */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full opacity-10 blur-2xl"
                  style={{
                    background:
                      "conic-gradient(from 90deg, #f59e0b, #34b871, #10b3a3, #ff6b5e, #f0559c, #4c7dff, #6e6ef7, #f59e0b)",
                  }}
                />
                {/* rotating ring of the twelve mode hues around an aperture */}
                <div aria-hidden className="relative h-28 w-28 shrink-0">
                  <div className="mode-orbit absolute inset-0">
                    <div className="mode-orbit-boost absolute inset-0">
                      {MODES.map((mode, i) => (
                        <span
                          key={mode.name}
                          className={cn(
                            "absolute left-1/2 top-1/2 h-1.5 w-1.5 rounded-full",
                            HUE_STYLES[mode.hue].orbit,
                          )}
                          style={{
                            transform: `translate(-50%, -50%) rotate(${i * 30}deg) translateY(-52px)`,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                  {/* 6-blade aperture */}
                  <svg
                    {...iconProps}
                    className="absolute left-1/2 top-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2"
                    aria-hidden
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="m14.31 8 5.74 9.94" />
                    <path d="M9.69 8h11.48" />
                    <path d="m7.38 12 5.74-9.94" />
                    <path d="M9.69 16 3.95 6.06" />
                    <path d="M14.31 16H2.83" />
                    <path d="m16.62 12-5.74 9.94" />
                  </svg>
                </div>
                <div className="relative">
                  <h3 className="text-base font-medium tracking-tight text-white">
                    One shutter.
                  </h3>
                  <p className="mt-1 text-sm leading-relaxed text-white/60">
                    Twelve specialists behind it.
                  </p>
                </div>
              </div>
            </Reveal>
          </li>
        </ul>
      </div>
    </Section>
  );
}
