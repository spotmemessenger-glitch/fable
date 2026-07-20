"use client";

import { useState, type FormEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { site } from "@/lib/site";
import { EASE, scaleIn, viewportOnce } from "@/lib/motion";
import { Section } from "@/components/ui/section";
import { Reveal } from "@/components/ui/reveal";
import { Button } from "@/components/ui/button";
import { StoreBadge } from "@/components/ui/store-badge";
import { PhoneFrame } from "@/components/ui/phone";
import { Magnetic } from "@/components/ui/magnetic";
import { CheckIcon, MicIcon } from "@/components/ui/icons";

/**
 * Decorative 21x21 QR-style mosaic — deterministic, with the three finder
 * squares and a timing row so it scans visually as a QR code. Not a real code.
 */
const QR_ROWS: string[] = [
  "111111101011001111111",
  "100000100110101000001",
  "101110101101001011101",
  "101110100011101011101",
  "101110101000101011101",
  "100000100111001000001",
  "111111101010101111111",
  "000000001100100000000",
  "110101101100110100101",
  "010011010111010011010",
  "101100101000101110011",
  "011010011010010001101",
  "110001100111011010110",
  "001110010110100110101",
  "111111100101101101011",
  "100000101100110010110",
  "101110100011010111001",
  "101110101010011000110",
  "101110100110100101101",
  "100000101001110110010",
  "111111100101001011100",
];

function QRMosaic({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 21 21" className={className} shapeRendering="crispEdges" aria-hidden>
      {QR_ROWS.map((row, y) =>
        Array.from(row).map((cell, x) =>
          cell === "1" ? (
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width={1}
              height={1}
              fill="currentColor"
            />
          ) : null,
        ),
      )}
    </svg>
  );
}

/** Mini translation-chat screen shown inside the front phone. */
function ChatScreen() {
  return (
    <div className="flex h-full flex-col bg-canvas px-3 pb-3 pt-13 text-left">
      <div className="mb-3 flex items-center justify-between px-1">
        <p className="text-[11px] font-semibold text-ink">Translate</p>
        <span className="rounded-full bg-accent/[0.08] px-2 py-0.5 text-[9px] font-semibold text-accent-deep">
          EN &#8646; ES
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <div className="max-w-[85%] self-start rounded-2xl rounded-bl-md border border-hairline bg-surface px-3 py-2 shadow-soft">
          <p className="text-[11px] leading-snug text-ink">
            &iquest;D&oacute;nde est&aacute; la estaci&oacute;n de tren?
          </p>
        </div>
        <div className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-accent px-3 py-2 text-white">
          <p className="text-[11px] leading-snug">Where is the train station?</p>
          <p className="mt-1 text-[8px] uppercase tracking-widest text-white/60">
            Instant &middot; 0.2s
          </p>
        </div>
        <div className="max-w-[85%] self-start rounded-2xl rounded-bl-md border border-hairline bg-surface px-3 py-2 shadow-soft">
          <p className="text-[11px] leading-snug text-ink">A dos cuadras, a la derecha.</p>
        </div>
        <div className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-accent px-3 py-2 text-white">
          <p className="text-[11px] leading-snug">Two blocks away, on the right.</p>
        </div>
      </div>
      <div className="mt-auto flex h-9 items-center justify-between rounded-full border border-hairline bg-surface px-3">
        <span className="text-[10px] text-faint">Speak or type</span>
        <span className="grid h-6 w-6 place-items-center rounded-full bg-accent/[0.08] text-accent">
          <MicIcon className="h-3 w-3" />
        </span>
      </div>
    </div>
  );
}

/** Mini camera-viewfinder screen shown inside the back phone. */
function CameraScreen() {
  return (
    <div className="flex h-full flex-col bg-[#101114] pt-12 text-white">
      <div className="relative mx-2.5 mt-1 flex-1 overflow-hidden rounded-2xl bg-[linear-gradient(160deg,#23262c,#15171b)]">
        <div aria-hidden className="absolute left-3 top-3 h-5 w-5 rounded-tl-lg border-l-2 border-t-2 border-teal/80" />
        <div aria-hidden className="absolute right-3 top-3 h-5 w-5 rounded-tr-lg border-r-2 border-t-2 border-teal/80" />
        <div aria-hidden className="absolute bottom-3 left-3 h-5 w-5 rounded-bl-lg border-b-2 border-l-2 border-teal/80" />
        <div aria-hidden className="absolute bottom-3 right-3 h-5 w-5 rounded-br-lg border-b-2 border-r-2 border-teal/80" />
        <div className="absolute left-1/2 top-1/2 w-[82%] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-white/20 bg-white/10 px-3 py-2 backdrop-blur">
          <p className="text-[8px] uppercase tracking-widest text-white/50">
            Detected &middot; Japanese
          </p>
          <p className="mt-1 text-[11px] font-medium leading-snug">
            Miso ramen &middot; &yen;980
          </p>
        </div>
      </div>
      <div className="flex items-center justify-center gap-4 py-2.5 text-[8px] uppercase tracking-widest text-white/40">
        <span>Photo</span>
        <span className="text-white">Translate</span>
        <span>Scan</span>
      </div>
      <div aria-hidden className="mx-auto mb-4 h-9 w-9 rounded-full border-2 border-white/80" />
    </div>
  );
}

export default function DownloadCTA() {
  const [sent, setSent] = useState(false);
  const reduce = useReducedMotion();

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSent(true);
  };

  return (
    <Section id="download" tone="canvas">
      <div className="shell">
        <motion.div
          variants={scaleIn}
          initial="hidden"
          whileInView="visible"
          viewport={viewportOnce}
          className="noise relative overflow-hidden rounded-hero bg-ink px-8 py-20 text-white shadow-pop md:px-20 md:py-28"
        >
          {/* ambient glows */}
          <div
            aria-hidden
            className="pointer-events-none absolute -right-32 -top-44 h-[34rem] w-[34rem] rounded-full"
            style={{
              background:
                "radial-gradient(closest-side, rgb(76 125 255 / 0.14), transparent)",
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-44 -left-32 h-[30rem] w-[30rem] rounded-full"
            style={{
              background:
                "radial-gradient(closest-side, rgb(110 110 247 / 0.12), transparent)",
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-36 -right-28 h-[26rem] w-[26rem] rounded-full"
            style={{
              background:
                "radial-gradient(closest-side, rgb(16 179 163 / 0.10), transparent)",
            }}
          />

          {/* spectrum signature — 1px multi-hue hairline along the top edge */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px opacity-60"
            style={{
              background:
                "linear-gradient(90deg, #4c7dff, #6e6ef7, #10b3a3, #ff6b5e)",
            }}
          />

          <div className="relative grid items-center gap-14 lg:grid-cols-[1.2fr_1fr] lg:gap-12">
            {/* Left: copy, badges, email capture */}
            <div>
              <Reveal>
                <h2 className="text-4xl font-medium md:text-6xl">
                  Your world,{" "}
                  <span className="text-gradient">understood</span>
                  .
                </h2>
              </Reveal>
              <Reveal delay={0.08}>
                <p className="mt-6 max-w-md text-lg text-white/60">
                  One free app that translates, speaks, and sees in 120+ languages,
                  wherever you go.
                </p>
              </Reveal>
              <Reveal delay={0.16} className="mt-10 flex flex-wrap items-center gap-4">
                <Magnetic>
                  <StoreBadge store="apple" variant="light" href={site.appStoreUrl} />
                </Magnetic>
                <Magnetic>
                  <StoreBadge store="google" variant="light" href={site.googlePlayUrl} />
                </Magnetic>
              </Reveal>

              <Reveal delay={0.24} className="mt-10">
                {/* the form stays mounted across submit so keyboard focus never drops to <body>; the success message receives focus explicitly */}
                <form onSubmit={onSubmit} className="w-full max-w-md">
                  <AnimatePresence mode="wait" initial={false}>
                    {sent ? (
                      <motion.p
                        key="success"
                        ref={(node: HTMLParagraphElement | null) => {
                          node?.focus();
                        }}
                        tabIndex={-1}
                        role="status"
                        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.4, ease: EASE }}
                        className="inline-flex h-12 items-center gap-2.5 rounded-full border border-white/15 bg-white/10 px-5 text-[15px] text-white/90"
                      >
                        <CheckIcon className="h-4 w-4 shrink-0 text-accent" />
                        Check your inbox. Your download link is on the way.
                      </motion.p>
                    ) : (
                      <motion.div
                        key="fields"
                        exit={reduce ? { opacity: 0 } : { opacity: 0, y: -10 }}
                        transition={{ duration: 0.3, ease: EASE }}
                        className="flex flex-col gap-3 sm:flex-row"
                      >
                        <label htmlFor="download-email" className="sr-only">
                          Email address
                        </label>
                        <input
                          id="download-email"
                          name="email"
                          type="email"
                          required
                          autoComplete="email"
                          placeholder="you@example.com"
                          className="h-12 min-w-0 flex-1 rounded-full border border-white/15 bg-white/10 px-5 text-[15px] text-white placeholder:text-white/40 transition-colors duration-200 focus:border-white/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        />
                        <Button
                          type="submit"
                          variant="cta"
                          className="h-12 shrink-0 bg-white text-ink hover:bg-white"
                        >
                          Get the link
                        </Button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </form>
              </Reveal>
            </div>

            {/* Right: floating phones + QR chip */}
            <Reveal delay={0.2} className="relative mx-auto w-full max-w-sm">
              <div className="relative flex justify-center pb-12 pt-6">
                <div
                  className="absolute -right-1 top-8 rotate-6 animate-floaty"
                  style={{ animationDelay: "-3.5s" }}
                >
                  <PhoneFrame width={200} className="shadow-lift">
                    <CameraScreen />
                  </PhoneFrame>
                </div>
                <div className="relative z-10 -translate-x-8 animate-floaty">
                  <PhoneFrame width={230} pose="tilted">
                    <ChatScreen />
                  </PhoneFrame>
                </div>
                <figure className="absolute -bottom-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-2xl bg-white p-3 pr-5 text-ink shadow-pop">
                  <QRMosaic className="h-14 w-14 shrink-0 text-ink" />
                  <figcaption>
                    <p className="text-[13px] font-semibold leading-tight">
                      Scan to download
                    </p>
                    <p className="mt-1 text-[11px] leading-tight text-faint">
                      iOS + Android
                    </p>
                  </figcaption>
                </figure>
              </div>
            </Reveal>
          </div>
        </motion.div>
      </div>
    </Section>
  );
}
