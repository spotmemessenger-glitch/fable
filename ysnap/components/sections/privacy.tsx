"use client";

import type { ReactNode } from "react";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import { Section, SectionHeading } from "@/components/ui/section";
import { EASE, fadeRise, stagger, scaleIn, viewportOnce } from "@/lib/motion";

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

const SHIELD_PATH =
  "M60 10c14.5 7.6 29.4 12.4 45 14.4V60c0 30.4-17 53.6-45 65.6C32 113.6 15 90.4 15 60V24.4C30.6 22.4 45.5 17.6 60 10Z";

/* ------------------------------------------------------------------ shield */

function ShieldVisual() {
  const reduce = useReducedMotion();

  const shieldDraw: Variants = reduce
    ? {
        hidden: { opacity: 0 },
        visible: { opacity: 1, transition: { duration: 0.4, ease: EASE } },
      }
    : {
        hidden: { pathLength: 0, opacity: 0 },
        visible: {
          pathLength: 1,
          opacity: 1,
          transition: {
            pathLength: { duration: 1.5, ease: EASE },
            opacity: { duration: 0.35, ease: EASE },
          },
        },
      };

  const shieldFill: Variants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { delay: reduce ? 0 : 1.2, duration: 0.8, ease: EASE },
    },
  };

  const lockGroup: Variants = reduce
    ? {
        hidden: { opacity: 0 },
        visible: { opacity: 1, transition: { duration: 0.4, ease: EASE } },
      }
    : {
        hidden: { opacity: 0, scale: 0.7, rotate: -8 },
        visible: {
          opacity: 1,
          scale: 1,
          rotate: 0,
          transition: { delay: 1.35, type: "spring", stiffness: 260, damping: 20 },
        },
      };

  /** The shackle drops the last couple of pixels — the "click" of the lock closing. */
  const shackle: Variants = reduce
    ? { hidden: {}, visible: {} }
    : {
        hidden: { y: -2.5 },
        visible: {
          y: 0,
          transition: { delay: 1.75, type: "spring", stiffness: 640, damping: 16 },
        },
      };

  return (
    <motion.svg
      viewBox="0 0 120 136"
      className="relative mx-auto h-auto w-52 text-ink md:w-60"
      fill="none"
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.4 }}
      aria-hidden
    >
      <motion.path d={SHIELD_PATH} variants={shieldFill} fill="rgb(76 125 255 / 0.05)" />
      <motion.path
        d={SHIELD_PATH}
        variants={shieldDraw}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <motion.g
        variants={lockGroup}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
      >
        <motion.path
          variants={shackle}
          d="M53.5 66v-6.5a6.5 6.5 0 0 1 13 0V66"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        />
        <rect
          x="47.5"
          y="66"
          width="25"
          height="19"
          rx="5"
          stroke="currentColor"
          strokeWidth={2}
        />
        <circle cx="60" cy="75.5" r="2.2" fill="currentColor" />
      </motion.g>
    </motion.svg>
  );
}

/* ------------------------------------------------------------------ section */

export default function Privacy() {
  return (
    <Section id="privacy" tone="canvas">
      <div className="shell">
        <div className="grid items-center gap-14 lg:grid-cols-2 lg:gap-20">
          {/* Left — copy */}
          <div>
            <SectionHeading
              align="left"
              eyebrow="Privacy"
              title="Private by design."
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
                <ShieldVisual />
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
