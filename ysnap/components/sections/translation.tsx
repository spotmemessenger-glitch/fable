"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion, useScroll, useTransform } from "framer-motion";
import { cn } from "@/lib/cn";
import { EASE, fadeRise, scaleIn, stagger, viewportOnce } from "@/lib/motion";
import { Section, SectionHeading } from "@/components/ui/section";
import { Reveal } from "@/components/ui/reveal";
import { ButtonLink } from "@/components/ui/button";
import { PhoneFrame } from "@/components/ui/phone";
import { Counter } from "@/components/ui/counter";
import { MicIcon } from "@/components/ui/icons";

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

type Bubble = {
  native: string;
  english: string;
  lang: string;
  dir?: "rtl";
  /** absolute placement around the phone */
  position: string;
  floatDuration: number;
  floatDelay: number;
  /** spectrum hue class for the tiny identity dot */
  dot: string;
};

const BUBBLES: Bubble[] = [
  { native: "Hola", english: "Hello", lang: "es", position: "-left-4 top-8 sm:-left-16 sm:top-12", floatDuration: 6.2, floatDelay: 0, dot: "bg-teal" },
  { native: "你好", english: "Hi", lang: "zh", position: "-right-2 top-20 sm:-right-14 sm:top-8", floatDuration: 7.1, floatDelay: 0.4, dot: "bg-coral" },
  { native: "Bonjour", english: "Hello", lang: "fr", position: "-right-5 top-[40%] sm:-right-24", floatDuration: 5.6, floatDelay: 0.9, dot: "bg-amber" },
  { native: "مرحبا", english: "Hello", lang: "ar", dir: "rtl", position: "-left-6 top-[56%] sm:-left-24", floatDuration: 6.8, floatDelay: 0.2, dot: "bg-green" },
  { native: "नमस्ते", english: "Hello", lang: "hi", position: "-right-3 bottom-24 sm:-right-16 sm:bottom-28", floatDuration: 7.6, floatDelay: 0.6, dot: "bg-rose" },
  { native: "Olá", english: "Hi", lang: "pt", position: "-left-3 bottom-10 sm:-left-12 sm:bottom-14", floatDuration: 6.4, floatDelay: 1.1, dot: "bg-violet" },
];

/* ------------------------------------------------------------- component */

export default function Translation() {
  const reduce = useReducedMotion();
  /** index of the bubble currently morphed to English; -1 = none yet */
  const [morphed, setMorphed] = useState(-1);
  const phoneRef = useRef<HTMLDivElement>(null);
  const inView = useInView(phoneRef, { amount: 0.2 });

  /* layered depth parallax — three layers scrub at different rates as the
     section passes through the viewport. Transforms are declared
     unconditionally (hooks rules) but only bound when motion is allowed. */
  const sectionParallaxRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: sectionParallaxRef,
    offset: ["start end", "end start"],
  });
  /** furthest layer — ambient glow, slowest */
  const glowY = useTransform(scrollYProgress, [0, 1], [30, -30]);
  /** middle layer — the phone */
  const phoneY = useTransform(scrollYProgress, [0, 1], [36, -36]);
  /** nearest layer — bubbles move faster than the phone */
  const bubbleYEven = useTransform(scrollYProgress, [0, 1], [64, -64]);
  const bubbleYOdd = useTransform(scrollYProgress, [0, 1], [84, -84]);

  useEffect(() => {
    if (reduce || !inView) return;
    const id = window.setInterval(() => {
      setMorphed((m) => (m + 1) % BUBBLES.length);
    }, 2500);
    return () => window.clearInterval(id);
  }, [reduce, inView]);

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
        <div ref={sectionParallaxRef} className="grid items-center gap-16 lg:grid-cols-2">
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
            ref={phoneRef}
            variants={stagger(0.15, 0.09)}
            initial="hidden"
            whileInView="visible"
            viewport={viewportOnce}
            className="relative mx-auto w-fit py-8"
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
                <PhoneFrame width={310} pose="tilted">
                  <div className="flex h-full flex-col bg-white pt-14">
                    {/* language pair pill */}
                    <div className="flex justify-center">
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/20 bg-accent/[0.06] px-3.5 py-1 text-[11px] font-semibold tracking-wide text-ink-soft">
                        ES <span aria-hidden className="text-accent">→</span> EN
                      </span>
                    </div>
  
                    {/* conversation */}
                    <div className="mt-6 flex flex-col gap-3 px-4">
                      <div className="flex max-w-[85%] flex-col gap-1 self-start">
                        <span className="flex items-center gap-1.5 pl-1 text-[10px] text-faint">
                          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-accent/60" />
                          Spanish · detected
                        </span>
                        <p
                          lang="es"
                          className="rounded-2xl rounded-bl-md bg-sunken px-3.5 py-2.5 text-[13px] leading-snug text-ink"
                        >
                          ¿Dónde está la estación?
                        </p>
                      </div>
  
                      <div className="flex max-w-[85%] flex-col gap-1 self-end">
                        <p className="rounded-2xl rounded-br-md bg-ink px-3.5 py-2.5 text-[13px] leading-snug text-white">
                          Where is the station?
                        </p>
                        <span className="pr-1 text-right text-[10px] text-faint">English · under 200 ms</span>
                      </div>
  
                      {/* listening pill */}
                      <div className="mt-3 flex justify-center">
                        <span className="inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/[0.08] px-3.5 py-1.5">
                          <MicIcon className="h-3.5 w-3.5 text-accent" />
                          <span className="text-[11px] font-medium text-accent-deep">Listening</span>
                          <span className="flex items-center gap-[3px]">
                            {[0, 1, 2].map((i) => (
                              <motion.span
                                key={i}
                                className="h-1 w-1 rounded-full bg-accent"
                                animate={reduce ? undefined : { y: [0, -3, 0], opacity: [0.5, 1, 0.5] }}
                                transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut", delay: i * 0.15 }}
                              />
                            ))}
                          </span>
                        </span>
                      </div>
                    </div>
  
                    {/* input bar */}
                    <div className="mt-auto px-3 pb-4">
                      <div className="flex h-11 items-center justify-between rounded-full border border-hairline bg-sunken pr-1.5 pl-4">
                        <span className="text-xs text-faint">Type or speak</span>
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-white">
                          <MicIcon className="h-4 w-4" />
                        </span>
                      </div>
                    </div>
                  </div>
                </PhoneFrame>
              </motion.div>
            </motion.div>

            {/* floating language bubbles — nearest parallax layer */}
            {BUBBLES.map((b, i) => {
              const isEnglish = morphed === i;
              return (
                <motion.div
                  key={b.native}
                  className={cn("absolute z-20", b.position)}
                  style={reduce ? undefined : { y: i % 2 === 0 ? bubbleYEven : bubbleYOdd }}
                >
                  <motion.div variants={fadeRise}>
                    <motion.div
                      animate={reduce ? undefined : { y: [0, -9, 0] }}
                      transition={{ duration: b.floatDuration, repeat: Infinity, ease: "easeInOut", delay: b.floatDelay }}
                      className="glass flex items-center gap-2 rounded-full px-4 py-2"
                    >
                      <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", b.dot)} />
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.span
                          key={isEnglish ? "english" : "native"}
                          lang={isEnglish ? "en" : b.lang}
                          dir={isEnglish ? undefined : b.dir}
                          initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
                          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                          exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
                          transition={{ duration: 0.35, ease: EASE }}
                          className="block text-sm font-medium whitespace-nowrap text-ink-soft"
                        >
                          {isEnglish ? b.english : b.native}
                        </motion.span>
                      </AnimatePresence>
                    </motion.div>
                  </motion.div>
                </motion.div>
              );
            })}
          </motion.div>
        </div>

        {/* ------------------------------------------------------ stat row */}
        <Reveal className="mt-20 md:mt-28">
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
