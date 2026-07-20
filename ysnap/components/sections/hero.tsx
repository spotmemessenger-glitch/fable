"use client";

import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import type { MotionValue, Variants } from "framer-motion";
import { useRef } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { site } from "@/lib/site";
import { EASE, stagger } from "@/lib/motion";
import { ButtonLink } from "@/components/ui/button";
import { Magnetic } from "@/components/ui/magnetic";
import { GlobeIcon, PlayIcon } from "@/components/ui/icons";
import TextRipple from "@/components/ui/text-ripple";
import { HeroOrnaments } from "@/components/ui/hero-ornaments";
import HeroDevice from "@/components/ui/hero-device";

/* ------------------------------------------------------------------ icons */

function Icon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("h-4 w-4", className)}
      aria-hidden
    >
      {children}
    </svg>
  );
}

/* ------------------------------------------------------------------ data */

const HEADLINE_LINES: ReadonlyArray<{ text: string; gradient: boolean }> = [
  { text: "Translate.", gradient: false },
  { text: "Understand.", gradient: false },
  { text: "Discover.", gradient: false },
  { text: "Everything.", gradient: true },
];

type HeroChip = {
  id: string;
  title: string;
  sub: string;
  icon: ReactNode;
  className: string;
  /** one hue per chip — colors the small icon chip inside the glass chip */
  hue: string;
  delay: string;
};

const HERO_CHIPS: HeroChip[] = [
  {
    id: "translate",
    title: "Hola → Hello",
    sub: "Live translation",
    icon: <GlobeIcon className="h-4 w-4" />,
    className: "hidden md:flex md:left-[3%] md:top-[12%]",
    hue: "bg-accent/10 text-accent",
    delay: "0s",
  },
  {
    id: "voice",
    title: "Cloning voice…",
    sub: "Voice AI",
    icon: (
      <Icon>
        <path d="M4 10.5v3" />
        <path d="M8 8v8" />
        <path d="M12 5.5v13" />
        <path d="M16 8v8" />
        <path d="M20 10.5v3" />
      </Icon>
    ),
    className: "hidden md:flex md:right-[3%] md:top-[20%]",
    hue: "bg-violet/10 text-violet",
    delay: "1.4s",
  },
  {
    id: "camera",
    title: "Golden Retriever",
    sub: "98% match",
    icon: (
      <Icon>
        <path d="M3.5 8.7a1.2 1.2 0 0 1 1.2-1.2h2.6l1.5-2h6.4l1.5 2h2.6a1.2 1.2 0 0 1 1.2 1.2v8.6a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2V8.7Z" />
        <circle cx="12" cy="12.8" r="3.2" />
      </Icon>
    ),
    className: "hidden md:flex md:right-[3%] md:top-[62%]",
    hue: "bg-teal/10 text-teal",
    delay: "2.3s",
  },
  {
    id: "calorie",
    title: "Masala Dosa",
    sub: "168 kcal",
    icon: (
      <Icon>
        <path d="M12 3.5c2.9 2.8 5 5.5 5 8.6a5 5 0 0 1-10 0c0-1.3.35-2.5 1.05-3.7.65 1.05 1.5 1.7 2.45 1.9C10.1 8.1 10.8 5.7 12 3.5Z" />
      </Icon>
    ),
    className: "hidden md:flex md:left-[3%] md:top-[56%]",
    hue: "bg-amber/10 text-amber",
    delay: "3.2s",
  },
];

/* ------------------------------------------------------------------ chips */

/** One floating chip with a scrub-linked departure drift (each chip separates at its own rate). */
function HeroChipFloat({
  chip,
  index,
  progress,
  reduce,
}: {
  chip: HeroChip;
  index: number;
  progress: MotionValue<number>;
  reduce: boolean;
}) {
  /* declared unconditionally to satisfy hooks rules; only bound when motion is allowed */
  const driftY = useTransform(progress, [0, 1], [0, -(40 + index * 22)]);

  return (
    <motion.div
      className={cn("pointer-events-none absolute", chip.className)}
      style={reduce ? undefined : { y: driftY }}
    >
      <div
        className="glass animate-floaty pointer-events-none flex select-none items-center gap-3 rounded-2xl py-2.5 pl-2.5 pr-4"
        style={{ animationDelay: chip.delay }}
      >
        <span className={cn("flex h-9 w-9 items-center justify-center rounded-xl", chip.hue)}>
          {chip.icon}
        </span>
        <span className="flex flex-col items-start leading-tight">
          <span className="text-[13px] font-medium text-ink">{chip.title}</span>
          <span className="text-[11px] text-faint">{chip.sub}</span>
        </span>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ section */

export default function Hero() {
  const reduce = useReducedMotion();

  /* Scroll-exit choreography — 1:1 scrub-linked departure (no easing; Lenis
     provides the smoothing). Transforms are declared unconditionally to
     satisfy hooks rules and simply not bound when reduced motion is on. */
  const sectionRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end start"],
  });
  const copyY = useTransform(scrollYProgress, [0, 1], [0, -90]);
  /* opacity maps use the transformer form (equivalent to ranges [0.15, 0.65] -> [1, 0]
     and [0, 0.12] -> [1, 0]) — the tuple-range form failed to bind opacity here */
  const copyOpacity = useTransform(scrollYProgress, (v) =>
    Math.min(1, Math.max(0, 1 - (v - 0.15) / 0.5)),
  );
  const visualY = useTransform(scrollYProgress, [0, 1], [0, 70]);
  const visualScale = useTransform(scrollYProgress, [0, 1], [1, 0.95]);
  const cueOpacity = useTransform(scrollYProgress, (v) => Math.min(1, Math.max(0, 1 - v / 0.12)));

  /* The device is DOM, not WebGL — it paints on the first frame, so there is
     no lazy-mount/frameloop gating to manage here any more. */
  const visualRef = useRef<HTMLDivElement>(null);

  const lineRise: Variants = reduce
    ? {
        hidden: { opacity: 0 },
        visible: { opacity: 1, transition: { duration: 0.6, ease: EASE } },
      }
    : {
        hidden: { y: "115%", opacity: 0 },
        visible: { y: "0%", opacity: 1, transition: { duration: 0.95, ease: EASE } },
      };

  return (
    /* no local mesh / opaque bg here — the fixed site-wide MeshBackground
       (app/layout.tsx) shows through; body supplies the canvas color */
    <section
      ref={sectionRef}
      id="hero"
      className="noise relative min-h-svh overflow-hidden pb-0 pt-28 md:pt-44"
    >
      {/* ultra-faint dot grid, masked toward the center */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: "radial-gradient(circle, rgb(11 12 14 / 0.04) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
          maskImage: "radial-gradient(ellipse 70% 55% at 50% 36%, black, transparent)",
          WebkitMaskImage: "radial-gradient(ellipse 70% 55% at 50% 36%, black, transparent)",
        }}
      />

      {/* Infinite text ripple — world-script greetings that transliterate near the
          cursor. Desktop only: without a pointer the glyphs never morph, so on
          phones they read as scattered noise around the copy. */}
      <TextRipple className="z-[1] hidden md:block" />

      {/* floating glass 3D ornaments — speech bubble, camera lens, orbs */}
      <div className="pointer-events-none absolute inset-0 z-[7]">
        <HeroOrnaments progress={scrollYProgress} reduce={reduce ?? false} />
      </div>

      <div className="shell relative z-10 flex flex-col items-center text-center">
        {/* copy block — scrub-linked departure: rises and fades as the hero scrolls away */}
        <motion.div
          className="flex w-full flex-col items-center"
          style={reduce ? undefined : { y: copyY, opacity: copyOpacity }}
        >
        {/* eyebrow pill */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: EASE, delay: 0.1 }}
          className="glass inline-flex items-center gap-2.5 rounded-full px-4 py-2 text-[13px] font-medium tracking-wide text-ink-soft"
        >
          <span className="relative flex h-1.5 w-1.5" aria-hidden>
            <span className="animate-pulse-ring absolute inset-0 rounded-full bg-accent" />
            <span className="relative h-1.5 w-1.5 rounded-full bg-accent" />
          </span>
          Introducing YSNAP
        </motion.div>

        {/* headline — masked line rise, gradient reserved for the final word */}
        <motion.h1
          aria-label="Translate. Understand. Discover. Everything."
          className="mt-6 font-medium text-ink md:mt-7"
          style={{ fontSize: "clamp(2.3rem, 5.8vw, 4.9rem)", lineHeight: 1.04 }}
          variants={stagger(0.3, 0.12)}
          initial="hidden"
          animate="visible"
        >
          {HEADLINE_LINES.map((line) => (
            <span key={line.text} aria-hidden className="-mb-[0.1em] block overflow-hidden pb-[0.1em]">
              <motion.span
                variants={lineRise}
                className={cn("block will-change-transform", line.gradient && "text-gradient")}
              >
                {line.text}
              </motion.span>
            </span>
          ))}
        </motion.h1>

        {/* subheadline — starts partially painted (not opacity 0) so it can be
            the LCP element at first paint; the un-blur still reads as an entrance */}
        <motion.p
          initial={{ opacity: 0.45, y: 18, filter: "blur(5px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.8, ease: EASE, delay: 0.85 }}
          className="mx-auto mt-5 max-w-[34ch] text-[15px] leading-relaxed text-muted md:mt-6 md:max-w-2xl md:text-lg"
        >
          {site.description}
        </motion.p>

        {/* CTA row */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: EASE, delay: 1 }}
          /* Mobile: one full-width column so the CTAs read as a single decisive
             block instead of wrapping into ragged rows. Desktop: inline row. */
          className="mt-8 flex w-full flex-col items-stretch gap-2.5 sm:mt-10 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:justify-center sm:gap-3"
        >
          <Magnetic className="w-full sm:w-auto">
            <ButtonLink href="#download" variant="cta" size="lg" className="w-full sm:w-auto">
              Download for iPhone
            </ButtonLink>
          </Magnetic>
          <Magnetic className="w-full sm:w-auto">
            <ButtonLink href="#download" variant="secondary" size="lg" className="w-full sm:w-auto">
              Download for Android
            </ButtonLink>
          </Magnetic>
          <ButtonLink href="#demo" variant="ghost" size="lg" className="w-full sm:w-auto">
            <PlayIcon className="h-[18px] w-[18px]" />
            Watch Demo
          </ButtonLink>
        </motion.div>
        </motion.div>

        {/* scroll cue — fades out first as the departure begins */}
        <motion.div style={reduce ? undefined : { opacity: cueOpacity }}>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, ease: EASE, delay: 1.5 }}
          /* hidden on phones — the device follows immediately, so the cue is
             just one more floating element competing for attention */
          className="mt-10 hidden flex-col items-center gap-2.5 sm:flex"
        >
          <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-faint">Scroll</span>
          <span className="relative block h-10 w-px overflow-hidden rounded-full bg-ink/10" aria-hidden>
            {reduce ? null : (
              <motion.span
                className="absolute left-0 top-0 block h-4 w-px rounded-full bg-ink/45"
                animate={{ y: [-18, 42] }}
                transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
              />
            )}
          </span>
        </motion.div>
        </motion.div>
      </div>

      {/* hero visual — lazy 3D scene breaking the bottom fold, DOM chips floating above */}
      <motion.div
        ref={visualRef}
        aria-hidden
        initial={{ opacity: 0, y: 44 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.1, ease: EASE, delay: 1.05 }}
        className="relative z-[5] mx-auto mt-10 h-[580px] w-full max-w-5xl sm:mt-8 sm:h-[620px] md:mt-4 md:h-[680px]"
      >
        {/* inner wrapper carries the departure lag (y/scale) so it composes
            with — rather than collides with — the entrance y on the outer element */}
        <motion.div
          className="relative h-full w-full"
          style={reduce ? undefined : { y: visualY, scale: visualScale }}
        >
          <div className="absolute inset-0">
            <HeroDevice />
          </div>

          <div className="pointer-events-none absolute inset-0 z-20">
            {HERO_CHIPS.map((chip, index) => (
              <HeroChipFloat
                key={chip.id}
                chip={chip}
                index={index}
                progress={scrollYProgress}
                reduce={reduce ?? false}
              />
            ))}
          </div>
        </motion.div>
      </motion.div>
    </section>
  );
}
