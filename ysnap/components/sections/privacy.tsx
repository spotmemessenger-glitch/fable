"use client";

import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { Section, SectionHeading } from "@/components/ui/section";
import { fadeRise, stagger, scaleIn, viewportOnce } from "@/lib/motion";
import PrivacyShield3D from "@/components/ui/privacy-shield-3d";

/* ------------------------------------------------------------------ data */

type PrivacyRow = {
  title: string;
  body: string;
  icon: ReactNode;
};

const ROWS: PrivacyRow[] = [
  {
    title: "On-device first",
    body: "Core models run on your phone.",
    icon: (
      <svg
        className="h-5 w-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <rect x="7" y="2.75" width="10" height="18.5" rx="2.5" />
        <path d="M10.5 18.25h3" />
      </svg>
    ),
  },
  {
    title: "End-to-end encrypted sync",
    body: "Your history moves between devices as ciphertext we cannot read.",
    icon: (
      <svg
        className="h-5 w-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M20 11a8 8 0 0 0-15.5-2" />
        <path d="M4.5 5v4h4" />
        <path d="M4 13a8 8 0 0 0 15.5 2" />
        <path d="M19.5 19v-4h-4" />
      </svg>
    ),
  },
  {
    title: "No ads, no data selling",
    body: "Your data is never sold or used for ads.",
    icon: (
      <svg
        className="h-5 w-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="8.5" />
        <path d="M6 6l12 12" />
      </svg>
    ),
  },
];

/* ------------------------------------------------------------------ section */

export default function Privacy() {
  return (
    <Section id="privacy" tone="canvas">
      <div className="shell">
        {/* grid-cols-1: without it, the implicit single column below lg
            sizes to its widest child's content width instead of the
            viewport, and overflow-x:clip silently truncates the rest. */}
        <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2 lg:gap-20">
          {/* Left — copy */}
          <div>
            <SectionHeading
              align="left"
              eyebrow="Privacy"
              title={
                <>
                  Private{" "}
                  {/* violet→red, matching the shield's threat-defence palette */}
                  <span className="bg-[linear-gradient(90deg,#7b5cff,#ff3b47)] bg-clip-text text-transparent">
                    by design.
                  </span>
                </>
              }
              description="Your conversations, photos and voice belong to you. On-device processing where possible, encryption everywhere else."
              className="mb-10 md:mb-12"
            />
            <motion.ul
              variants={stagger(0.1, 0.09)}
              initial="hidden"
              whileInView="visible"
              viewport={viewportOnce}
              className="flex flex-col gap-7"
            >
              {ROWS.map((row) => (
                <motion.li key={row.title} variants={fadeRise} className="flex items-start gap-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/[0.08] text-accent">
                    {row.icon}
                  </span>
                  <span className="flex flex-col gap-0.5 pt-0.5">
                    <h3 className="text-base font-medium tracking-normal">{row.title}</h3>
                    <p className="text-[15px] leading-relaxed text-muted">{row.body}</p>
                  </span>
                </motion.li>
              ))}
            </motion.ul>
          </div>

          {/* Right — calm shield visual */}
          <motion.div
            variants={scaleIn}
            initial="hidden"
            whileInView="visible"
            viewport={viewportOnce}
          >
            <figure>
              <div className="noise relative flex min-h-[420px] items-center justify-center overflow-hidden rounded-hero border border-hairline bg-surface shadow-soft md:min-h-[480px]">
                <div
                  aria-hidden
                  className="pointer-events-none absolute -top-24 -right-20 h-80 w-80"
                  style={{
                    background: "radial-gradient(closest-side, rgb(76 125 255 / 0.08), transparent)",
                  }}
                />
                <div
                  aria-hidden
                  className="pointer-events-none absolute -bottom-24 -left-16 h-72 w-72"
                  style={{
                    background:
                      "radial-gradient(closest-side, rgb(110 110 247 / 0.06), transparent)",
                  }}
                />
                <PrivacyShield3D />
              </div>
              <figcaption className="mt-6 flex justify-center">
                <span className="inline-flex items-center rounded-full border border-hairline bg-surface px-4 py-1.5 text-xs font-medium tracking-wide text-faint shadow-soft">
                  GDPR ready · SOC 2 in progress
                </span>
              </figcaption>
            </figure>
          </motion.div>
        </div>
      </div>
    </Section>
  );
}
