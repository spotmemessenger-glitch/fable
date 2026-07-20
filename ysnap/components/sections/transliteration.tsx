"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";
import { EASE, fadeRise, stagger, viewportOnce } from "@/lib/motion";
import { Section, SectionHeading } from "@/components/ui/section";
import { Reveal } from "@/components/ui/reveal";

/* ------------------------------------------------------------------ data */

type Entry = {
  /** Latin-script language name shown in captions and chips */
  name: string;
  /** the greeting in that script */
  word: string;
  /**
   * Pre-segmented animation units. Complex scripts are split by grapheme
   * cluster (conjuncts kept whole) so shaping never breaks; Arabic and Urdu
   * animate as one unit because their letters join across the whole word.
   */
  chars: string[];
  lang: string;
  dir?: "rtl";
};

const ENTRIES: Entry[] = [
  { name: "English", word: "Vanakkam", chars: ["V", "a", "n", "a", "k", "k", "a", "m"], lang: "en" },
  { name: "Tamil", word: "வணக்கம்", chars: ["வ", "ண", "க்", "க", "ம்"], lang: "ta" },
  { name: "Hindi", word: "नमस्ते", chars: ["न", "म", "स्ते"], lang: "hi" },
  { name: "Malayalam", word: "നമസ്കാരം", chars: ["ന", "മ", "സ്കാ", "രം"], lang: "ml" },
  { name: "Kannada", word: "ನಮಸ್ಕಾರ", chars: ["ನ", "ಮ", "ಸ್ಕಾ", "ರ"], lang: "kn" },
  { name: "Telugu", word: "నమస్కారం", chars: ["న", "మ", "స్కా", "రం"], lang: "te" },
  { name: "Arabic", word: "مرحبا", chars: ["مرحبا"], lang: "ar", dir: "rtl" },
  { name: "Urdu", word: "السلام", chars: ["السلام"], lang: "ur", dir: "rtl" },
];

const CYCLE_MS = 2200;

/* ------------------------------------------------------------- component */

export default function Transliteration() {
  const reduce = useReducedMotion();
  const [active, setActive] = useState(0);
  const entry = ENTRIES[active];
  const panelRef = useRef<HTMLDivElement>(null);
  const inView = useInView(panelRef, { amount: 0.3 });
  /** while Date.now() < holdUntil, the auto-cycle is paused (user picked a script) */
  const holdUntil = useRef(0);

  useEffect(() => {
    if (reduce || !inView) return;
    const id = window.setInterval(() => {
      if (Date.now() < holdUntil.current) return;
      setActive((a) => (a + 1) % ENTRIES.length);
    }, CYCLE_MS);
    return () => window.clearInterval(id);
  }, [reduce, inView]);

  return (
    <Section id="transliteration" tone="surface">
      <div className="shell">
        <div className="grid items-center gap-16 lg:grid-cols-2">
          {/* ------------------------------------------------ copy column */}
          <div className="lg:order-last">
            <SectionHeading
              align="left"
              eyebrow="Transliteration"
              title={
                <>
                  Read <span className="text-gradient">any script</span>, in yours.
                </>
              }
              description="YSNAP converts between writing systems while keeping the sound intact — the same greeting, spelled the way you already read."
              className="mb-10 md:mb-12"
            />

            <motion.ul
              variants={stagger(0.1, 0.06)}
              initial="hidden"
              whileInView="visible"
              viewport={viewportOnce}
              className="grid grid-cols-2 gap-3 sm:grid-cols-4"
            >
              {ENTRIES.map((e, i) => (
                <motion.li key={e.name} variants={fadeRise}>
                  <button
                    type="button"
                    aria-pressed={active === i}
                    onPointerEnter={(ev) => {
                      if (ev.pointerType === "mouse") {
                        setActive(i);
                        holdUntil.current = Date.now() + 4000;
                      }
                    }}
                    onClick={() => {
                      setActive(i);
                      holdUntil.current = Date.now() + 4000;
                    }}
                    onFocus={() => {
                      setActive(i);
                      holdUntil.current = Date.now() + 4000;
                    }}
                    className={cn(
                      "w-full cursor-pointer rounded-card border border-hairline bg-canvas px-4 py-3 text-left shadow-soft transition-all duration-300 hover:-translate-y-1 hover:shadow-lift focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent",
                      active === i && "border-violet/30",
                    )}
                  >
                    <span className="block truncate text-lg leading-snug text-ink" lang={e.lang} dir={e.dir}>
                      {e.word}
                    </span>
                    <span className="mt-1 flex items-center gap-1.5 text-[10px] tracking-widest text-faint uppercase">
                      <span
                        aria-hidden
                        className={cn(
                          "h-1 w-1 shrink-0 rounded-full transition-colors duration-300",
                          active === i ? "bg-violet" : "bg-violet/60",
                        )}
                      />
                      {e.name}
                    </span>
                  </button>
                </motion.li>
              ))}
            </motion.ul>
          </div>

          {/* ---------------------------------------------- visual column */}
          <Reveal className="relative">
            <div ref={panelRef} className="glass noise relative overflow-hidden rounded-hero p-10 md:p-12">
              {/* ambient glows */}
              <div
                aria-hidden
                className="pointer-events-none absolute -top-28 -right-28 h-80 w-80 rounded-full"
                style={{ background: "radial-gradient(closest-side, rgb(76 125 255 / 0.08), transparent)" }}
              />
              <div
                aria-hidden
                className="pointer-events-none absolute -bottom-32 -left-24 h-72 w-72 rounded-full"
                style={{ background: "radial-gradient(closest-side, rgb(110 110 247 / 0.06), transparent)" }}
              />

              <p className="relative text-center text-[11px] tracking-widest text-faint uppercase">
                One greeting · eight scripts
              </p>

              {/* morphing word — decorative; the chip grid exposes every script statically */}
              <span className="sr-only">Greeting shown in eight scripts</span>
              <div className="relative mt-6 flex h-32 items-center justify-center md:h-44" aria-hidden>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={active}
                    lang={entry.lang}
                    dir={entry.dir}
                    className="font-display text-[2.6rem] font-medium tracking-tight whitespace-nowrap text-ink sm:text-6xl md:text-7xl"
                  >
                    {entry.chars.map((ch, i) => (
                      <motion.span
                        key={`${active}-${i}`}
                        className="inline-block"
                        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14, filter: "blur(4px)" }}
                        animate={{
                          opacity: 1,
                          y: 0,
                          filter: "blur(0px)",
                          transition: { duration: 0.55, ease: EASE, delay: reduce ? 0 : i * 0.05 },
                        }}
                        exit={
                          reduce
                            ? { opacity: 0, transition: { duration: 0.2 } }
                            : {
                                opacity: 0,
                                y: -14,
                                filter: "blur(4px)",
                                transition: { duration: 0.3, ease: EASE, delay: i * 0.03 },
                              }
                        }
                      >
                        {ch}
                      </motion.span>
                    ))}
                  </motion.span>
                </AnimatePresence>
              </div>

              {/* caption row */}
              <div className="relative mt-8 flex items-center justify-between border-t border-hairline pt-6">
                <span className="relative h-5 overflow-hidden">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={active}
                      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
                      transition={{ duration: 0.3, ease: EASE }}
                      className="block text-sm font-medium text-muted"
                    >
                      {entry.name}
                    </motion.span>
                  </AnimatePresence>
                </span>
                <span className="flex items-center gap-1.5" role="group" aria-label="Scripts">
                  {ENTRIES.map((e, i) => (
                    <button
                      key={e.name}
                      type="button"
                      aria-label={`Show ${e.name}`}
                      className="grid cursor-pointer place-items-center p-1.5"
                      onClick={() => {
                        setActive(i);
                        holdUntil.current = Date.now() + 4000;
                      }}
                    >
                      <span
                        className={cn(
                          "h-1.5 rounded-full transition-all duration-300",
                          i === active ? "w-5 bg-violet" : "w-1.5 bg-violet/15",
                        )}
                      />
                    </button>
                  ))}
                </span>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </Section>
  );
}
