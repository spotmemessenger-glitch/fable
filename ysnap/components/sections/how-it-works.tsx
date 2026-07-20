"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Section, SectionHeading } from "@/components/ui/section";
import { Reveal } from "@/components/ui/reveal";
import { EASE, viewportOnce } from "@/lib/motion";

/* ------------------------------------------------------------------ data */

type Step = {
  numeral: string;
  title: string;
  line: string;
  icon: ReactNode;
  /** hue classes — one hue per step (accent -> violet -> teal) */
  chip: string;
  ghost: string;
};

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const STEPS: Step[] = [
  {
    numeral: "01",
    title: "Capture",
    line: "Point, speak or type — any input.",
    chip: "bg-accent/10 text-accent",
    ghost: "text-accent/[0.07]",
    icon: (
      <svg {...iconProps} className="h-5 w-5" aria-hidden>
        <path d="M4 8V6a2 2 0 0 1 2-2h2" />
        <path d="M16 4h2a2 2 0 0 1 2 2v2" />
        <path d="M20 16v2a2 2 0 0 1-2 2h-2" />
        <path d="M8 20H6a2 2 0 0 1-2-2v-2" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
  },
  {
    numeral: "02",
    title: "Understand",
    line: "On-device + cloud models process instantly.",
    chip: "bg-violet/10 text-violet",
    ghost: "text-violet/[0.07]",
    icon: (
      <svg {...iconProps} className="h-5 w-5" aria-hidden>
        <path d="M12 4.5 13.8 9.2 18.5 11 13.8 12.8 12 17.5 10.2 12.8 5.5 11 10.2 9.2 12 4.5Z" />
        <path d="M18.5 16.5v3M17 18h3" />
        <path d="M5.5 4.5v3M4 6h3" />
      </svg>
    ),
  },
  {
    numeral: "03",
    title: "Act",
    line: "Translated, spoken, solved — in under a second.",
    chip: "bg-teal/10 text-teal",
    ghost: "text-teal/[0.07]",
    icon: (
      <svg {...iconProps} className="h-5 w-5" aria-hidden>
        <path d="M13 3 5.5 13.5h5L11 21l7.5-10.5h-5L13 3Z" />
      </svg>
    ),
  },
];

/* --------------------------------------------------------------- section */

export default function HowItWorks() {
  const reduce = useReducedMotion();

  return (
    <Section id="how" tone="surface">
      <div className="shell">
        <SectionHeading
          eyebrow="How it works"
          title={
            <>
              Three steps to{" "}
              <span className="text-gradient">understanding.</span>
            </>
          }
          description="No setup, no settings. Open the app and the whole pipeline runs itself."
        />

        <div className="relative">
          {/* thin connective line drawn on scroll, running behind the cards */}
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-16 hidden h-12 w-full md:block"
            viewBox="0 0 1136 48"
            fill="none"
            preserveAspectRatio="none"
          >
            <defs>
              <linearGradient id="how-line-gradient" gradientUnits="userSpaceOnUse" x1="0" y1="24" x2="1136" y2="24">
                <stop offset="0" stopColor="#4c7dff" />
                <stop offset="0.5" stopColor="#6e6ef7" />
                <stop offset="1" stopColor="#10b3a3" />
              </linearGradient>
            </defs>
            <motion.path
              d="M0 24 C 140 24 200 10 379 10 C 540 10 580 38 758 38 C 930 38 1000 24 1136 24"
              stroke="url(#how-line-gradient)"
              strokeOpacity="0.35"
              strokeWidth="1.5"
              strokeLinecap="round"
              initial={{ pathLength: reduce ? 1 : 0 }}
              whileInView={{ pathLength: 1 }}
              viewport={viewportOnce}
              transition={{ duration: 1.6, ease: EASE, delay: 0.25 }}
            />
          </svg>

          <ol className="grid gap-6 md:grid-cols-3">
            {STEPS.map((step, i) => (
              <Reveal
                as="li"
                key={step.numeral}
                delay={0.12 * i}
                className="group relative overflow-hidden rounded-card border border-hairline bg-surface p-8 shadow-soft transition-all duration-300 hover:-translate-y-1 hover:shadow-lift"
              >
                {/* dot-matrix texture, revealed on hover */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                  style={{
                    backgroundImage:
                      "radial-gradient(circle at center, rgba(0,0,0,0.02) 1px, transparent 1px)",
                    backgroundSize: "4px 4px",
                  }}
                />
                {/* oversized ghost numeral */}
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute -top-1 right-6 font-display text-7xl leading-none font-semibold select-none",
                    step.ghost,
                  )}
                >
                  {step.numeral}
                </span>

                <span className={cn("relative flex h-11 w-11 items-center justify-center rounded-xl", step.chip)}>
                  {step.icon}
                </span>
                <h3 className="relative mt-7 text-xl font-medium text-ink">
                  {step.title}
                </h3>
                <p className="relative mt-2 max-w-[26ch] text-base text-muted">
                  {step.line}
                </p>
              </Reveal>
            ))}
          </ol>
        </div>
      </div>
    </Section>
  );
}
