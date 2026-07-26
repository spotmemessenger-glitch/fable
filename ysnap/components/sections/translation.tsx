"use client";

import { useRef, type ReactNode } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import { fadeRise, scaleIn, stagger, viewportOnce } from "@/lib/motion";
import { Section, SectionHeading } from "@/components/ui/section";
import { Reveal } from "@/components/ui/reveal";
import { ButtonLink } from "@/components/ui/button";
import { Counter } from "@/components/ui/counter";
import TranslateDevice3D from "@/components/ui/translate-device-3d";

/* ------------------------------------------------------------------ data */

type Feature = {
  lead: string;
  tail: string;
  icon: ReactNode;
};

const FEATURES: Feature[] = [
  {
    lead: "Text and conversation.",
    tail: "Type or talk — 120+ languages, instantly.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <path d="M8 10h8M8 14h5" />
        <path d="M21 12a8 8 0 0 1-8 8H5.6L3 21.4V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" />
      </svg>
    ),
  },
  {
    lead: "Camera translation.",
    tail: "Point at menus, signs and documents.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <path d="M3 9a2 2 0 0 1 2-2h1.5l1.4-2.1A2 2 0 0 1 9.6 4h4.8a2 2 0 0 1 1.7.9L17.5 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Z" />
        <circle cx={12} cy={13} r={3.5} />
      </svg>
    ),
  },
  {
    lead: "Live voice.",
    tail: "Real-time interpreting for conversation.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
      </svg>
    ),
  },
];

/* ------------------------------------------------------------- component */

export default function Translation() {
  const reduce = useReducedMotion();

  /* layered depth parallax — layers scrub at different rates as the section
     passes through the viewport. Transforms are declared unconditionally
     (hooks rules) but only bound when motion is allowed. */
  const sectionParallaxRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: sectionParallaxRef,
    offset: ["start end", "end start"],
  });
  /** furthest layer — ambient glow, slowest */
  const glowY = useTransform(scrollYProgress, [0, 1], [30, -30]);
  /** middle layer — the 3D phone */
  const phoneY = useTransform(scrollYProgress, [0, 1], [36, -36]);

  return (
    <Section id="translation" tone="canvas">
      {/* ambient glow — furthest parallax layer */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute top-24 right-[-10%] h-[540px] w-[540px] rounded-full"
        style={
          reduce
            ? { background: "radial-gradient(closest-side, rgb(76 125 255 / 0.06), transparent)" }
            : { background: "radial-gradient(closest-side, rgb(76 125 255 / 0.06), transparent)", y: glowY }
        }
      />
      <div className="shell">
        {/* grid-cols-1 is load-bearing: without an explicit base template,
            the single implicit column below lg sizes to its widest child's
            intrinsic content width (the 3D phone) rather than the available
            space, and body's overflow-x:clip silently truncates the excess —
            this is what clipped the heading on phones. */}
        {/* gap-16 is a side-by-side value; stacked on a phone it becomes 64px
            of dead space between the copy and the device, so it only applies
            once the two actually sit in columns. */}
        <div ref={sectionParallaxRef} className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2 lg:gap-16">
          {/* ------------------------------------------------ copy column */}
          <div>
            <SectionHeading
              align="left"
              eyebrow="Translation"
              title={
                <>
                  Speak <span className="text-gradient">every language</span>{" "}
                  on Earth.
                </>
              }
              description="Text, voice and camera in one engine — type it, say it or point at it, and YSNAP translates the moment it happens."
              className="mb-10 md:mb-12"
            />

            <motion.ul
              variants={stagger(0.1, 0.08)}
              initial="hidden"
              whileInView="visible"
              viewport={viewportOnce}
              className="flex flex-col gap-6"
            >
              {FEATURES.map((f) => (
                <motion.li key={f.lead} variants={fadeRise} className="flex items-start gap-4">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                    {f.icon}
                  </span>
                  <p className="pt-1.5 text-[17px] leading-relaxed">
                    <span className="font-medium text-ink">{f.lead}</span>{" "}
                    <span className="text-muted">{f.tail}</span>
                  </p>
                </motion.li>
              ))}
            </motion.ul>

            <Reveal delay={0.25} className="mt-9">
              <ButtonLink href="#demo" variant="ghost" size="md" className="group -ml-4">
                Try the live demo
                <span aria-hidden className="transition-transform duration-300 group-hover:translate-x-1">
                  →
                </span>
              </ButtonLink>
            </Reveal>
          </div>

          {/* ----------------------------------------------- phone column */}
          <motion.div
            variants={stagger(0.15, 0.09)}
            initial="hidden"
            whileInView="visible"
            viewport={viewportOnce}
            className="relative w-full py-4"
          >
            {/* glow behind device */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-[-15%] rounded-full"
              style={{ background: "radial-gradient(closest-side, rgb(110 110 247 / 0.07), transparent)" }}
            />

            {/* middle parallax layer — wrapper is separate from the scaleIn
                element so the entrance y never fights the scroll scrub */}
            <motion.div className="relative z-10" style={reduce ? undefined : { y: phoneY }}>
              <motion.div variants={scaleIn}>
                <TranslateDevice3D />
              </motion.div>
            </motion.div>

          </motion.div>
        </div>

        {/* ------------------------------------------------------ stat row */}
        <Reveal className="mt-12 md:mt-28">
          <div className="flex flex-col divide-y divide-hairline sm:flex-row sm:divide-x sm:divide-y-0">
            <div className="flex flex-1 flex-col items-center gap-2.5 py-8 sm:py-4">
              <Counter to={120} suffix="+" className="font-display text-5xl font-medium tracking-tight text-ink md:text-6xl" />
              <span className="text-[11px] tracking-widest text-faint uppercase">Languages</span>
            </div>
            <div className="flex flex-1 flex-col items-center gap-2.5 py-8 sm:py-4">
              <Counter to={2} suffix="B+" className="font-display text-5xl font-medium tracking-tight text-ink md:text-6xl" />
              <span className="text-[11px] tracking-widest text-faint uppercase">Translations served</span>
            </div>
            <div className="flex flex-1 flex-col items-center gap-2.5 py-8 sm:py-4">
              <Counter to={200} prefix="<" suffix=" ms" className="font-display text-5xl font-medium tracking-tight text-ink md:text-6xl" />
              <span className="text-[11px] tracking-widest text-faint uppercase">Average response</span>
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
