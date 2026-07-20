"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";
import { fadeRise, stagger, viewportOnce, spring } from "@/lib/motion";
import { Section, SectionHeading } from "@/components/ui/section";
import { Reveal } from "@/components/ui/reveal";
import { Magnetic } from "@/components/ui/magnetic";
import { MicIcon, PlayIcon, PauseIcon, GlobeIcon } from "@/components/ui/icons";

/* ------------------------------------------------------------------ data */

const BAR_COUNT = 48;

type VoiceDemo = { id: string; label: string; src: string; transcript: string };

const DEMOS: VoiceDemo[] = [
  {
    id: "en",
    label: "English demo",
    src: "/audio/voice-en.mp3",
    transcript: "One AI. Every language. Every vision. This is YSNAP.",
  },
  {
    id: "multi",
    label: "Multilingual demo",
    src: "/audio/voice-multi.mp3",
    transcript:
      "Bonjour. Hola. Namaste. Vanakkam. Konnichiwa. One voice, every language.",
  },
];

/** Gentle resting shape for the waveform: a soft bell with a fine ripple. */
const idleScale = (i: number): number => {
  const t = i / (BAR_COUNT - 1);
  const bell = Math.exp(-((t - 0.5) ** 2) / 0.09);
  const ripple = 0.5 + 0.5 * Math.sin(i * 1.9);
  return Number((0.1 + bell * 0.24 + ripple * 0.1).toFixed(3));
};

const CENTER_START = BAR_COUNT / 3;
const CENTER_END = (BAR_COUNT / 3) * 2;

/** Violet -> accent blend across the waveform's highlighted center third. */
const centerBarColor = (i: number): string => {
  const t = (i - CENTER_START) / (CENTER_END - 1 - CENTER_START);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  // violet #6e6ef7 -> accent #4c7dff
  return `rgb(${mix(110, 76)} ${mix(110, 125)} ${mix(247, 255)})`;
};

/* ------------------------------------------------------------------ icons */

function CloneIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3.5" y="3.5" width="13" height="13" rx="3.5" />
      <path d="M6.8 10c.95-1.7 1.9-1.7 2.85 0s1.9 1.7 2.85 0" />
      <path d="M20.5 8.5v8a4 4 0 0 1-4 4h-8" />
    </svg>
  );
}

function TextToSpeechIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3.5 6.5h8M7.5 6.5V18" />
      <path d="M15.5 9.5a4.2 4.2 0 0 1 0 5" />
      <path d="M18.5 7a8 8 0 0 1 0 10" />
    </svg>
  );
}

function SpeechToTextIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8.4 19.4A8.5 8.5 0 1 0 4.6 15.6L3 21l5.4-1.6Z" />
      <path d="M9 10h6M9 13.5h3.5" />
    </svg>
  );
}

type Feature = { title: string; blurb: string; icon: ReactNode; hue: string };

const FEATURES: Feature[] = [
  {
    title: "Voice Cloning",
    blurb: "Your tone and cadence, captured from a short sample.",
    icon: <CloneIcon />,
    hue: "bg-violet/10 text-violet",
  },
  {
    title: "Text to Speech",
    blurb: "Natural pacing and intonation, under 200 ms to respond.",
    icon: <TextToSpeechIcon />,
    hue: "bg-accent/10 text-accent",
  },
  {
    title: "Speech to Text",
    blurb: "Live transcription at 99.2 percent recognition accuracy.",
    icon: <SpeechToTextIcon />,
    hue: "bg-teal/10 text-teal",
  },
  {
    title: "30+ Accents",
    blurb: "Regional voices that sound local, never generic.",
    icon: <GlobeIcon />,
    hue: "bg-coral/10 text-coral",
  },
];

/* ------------------------------------------------------------------ section */

export default function VoiceAI() {
  const reduce = useReducedMotion();
  const [demoIndex, setDemoIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);
  const waveRef = useRef<HTMLDivElement | null>(null);
  /** Pointer x as 0..1 across the waveform container; -1 = inactive. */
  const hoverRef = useRef({ frac: -1 });
  const idleHoverRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const levelsRef = useRef<Float32Array>(new Float32Array(BAR_COUNT));
  const rafRef = useRef(0);
  const graphFailedRef = useRef(false);

  /** Ease every bar back to its resting shape. */
  const resetWaveform = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    barRefs.current.forEach((bar, i) => {
      if (!bar) return;
      bar.style.transition = "transform 600ms cubic-bezier(0.22, 1, 0.36, 1)";
      bar.style.transform = `scaleY(${idleScale(i)})`;
      /* drop the play-time energy tint so center bars return to their
         violet→accent resting hue and the rest to the ink class */
      const center = i >= CENTER_START && i < CENTER_END;
      bar.style.backgroundColor = center ? centerBarColor(i) : "";
    });
  }, []);

  /**
   * Lazily build the Web Audio graph on the first user-initiated play so we
   * never trip autoplay policies. If anything throws, we remember the failure
   * and fall back to randomized bars.
   */
  const ensureGraph = useCallback(() => {
    if (typeof window === "undefined") return;
    if (graphFailedRef.current || analyserRef.current) return;
    const audio = audioRef.current;
    if (!audio) return;
    try {
      const Ctor =
        window.AudioContext ??
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error("AudioContext unavailable");
      const ctx = new Ctor();
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      dataRef.current = new Uint8Array(analyser.frequencyBinCount);
    } catch {
      graphFailedRef.current = true;
    }
  }, []);

  /** Drive the bars from real frequency data (or the randomized fallback). */
  const startWaveform = useCallback(() => {
    if (reduce) return;
    cancelAnimationFrame(rafRef.current);
    const levels = levelsRef.current;
    for (let i = 0; i < BAR_COUNT; i++) levels[i] = idleScale(i);
    barRefs.current.forEach((bar) => {
      if (bar) bar.style.transition = "none";
    });
    const half = BAR_COUNT / 2;

    const step = () => {
      const analyser = analyserRef.current;
      const data = dataRef.current;
      if (analyser && data) analyser.getByteFrequencyData(data);
      const now = performance.now() / 1000;

      for (let i = 0; i < BAR_COUNT; i++) {
        let target: number;
        if (analyser && data) {
          // Low frequencies (most energy) map to the center, highs to the edges.
          const dist = Math.abs(i + 0.5 - half) / half;
          const usable = Math.floor(data.length * 0.72);
          const bin = Math.min(usable - 1, 2 + Math.floor(dist * (usable - 3)));
          const v = data[bin] / 255;
          target = 0.08 + Math.pow(v, 1.35) * 0.92;
        } else {
          target =
            0.18 + 0.34 * Math.abs(Math.sin(now * 2.1 + i * 0.42)) + Math.random() * 0.22;
        }
        // Cursor ripple: bars swell under the pointer like water.
        const f = hoverRef.current.frac;
        if (f >= 0) {
          const d = i + 0.5 - f * BAR_COUNT;
          target = Math.min(1, target + Math.exp(-(d * d) / 12) * 0.35);
        }
        levels[i] += (target - levels[i]) * (analyser ? 0.38 : 0.16);
        const bar = barRefs.current[i];
        if (bar) {
          bar.style.transform = `scaleY(${Math.max(0.06, levels[i]).toFixed(3)})`;
          /* energy tint: calm blue #4c7dff at rest → energetic orange #f59e0b
             as each bar peaks, so the console "heats up" as the voice plays */
          const e = Math.min(1, levels[i]);
          const cr = Math.round(76 + (245 - 76) * e);
          const cg = Math.round(125 + (158 - 125) * e);
          const cb = Math.round(255 + (11 - 255) * e);
          bar.style.backgroundColor = `rgb(${cr} ${cg} ${cb})`;
        }
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [reduce]);

  /**
   * Mouse-only ripple while idle: bars swell under the cursor from their
   * resting shape. Shares `rafRef` with the playing loop so the two can
   * never run together.
   */
  const startIdleHover = useCallback(() => {
    if (reduce || playing || idleHoverRef.current) return;
    idleHoverRef.current = true;
    cancelAnimationFrame(rafRef.current);
    barRefs.current.forEach((bar) => {
      if (bar) bar.style.transition = "none";
    });
    const step = () => {
      if (!idleHoverRef.current) return;
      const f = hoverRef.current.frac;
      for (let i = 0; i < BAR_COUNT; i++) {
        const bar = barRefs.current[i];
        if (!bar) continue;
        let scale = idleScale(i);
        if (f >= 0) {
          const d = i + 0.5 - f * BAR_COUNT;
          scale = Math.min(1, scale + Math.exp(-(d * d) / 12) * 0.3);
        }
        bar.style.transform = `scaleY(${scale.toFixed(3)})`;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [reduce, playing]);

  const stopIdleHover = useCallback(() => {
    if (!idleHoverRef.current) return;
    idleHoverRef.current = false;
    resetWaveform();
  }, [resetWaveform]);

  const handlePlay = useCallback(() => {
    idleHoverRef.current = false;
    setPlaying(true);
    startWaveform();
  }, [startWaveform]);

  const handleStop = useCallback(() => {
    setPlaying(false);
    resetWaveform();
  }, [resetWaveform]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    ensureGraph();
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    void audio.play().catch(() => undefined);
  }, [ensureGraph]);

  /** Switching demos stops playback; the src swap resets the element. */
  const selectDemo = (index: number) => {
    if (index === demoIndex) return;
    audioRef.current?.pause();
    setDemoIndex(index);
  };

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      cancelAnimationFrame(rafRef.current);
      audio?.pause();
      void audioCtxRef.current?.close().catch(() => undefined);
    };
  }, []);

  const activeDemo = DEMOS[demoIndex];

  return (
    <Section id="voice" tone="canvas">
      <div className="shell">
        <SectionHeading
          eyebrow="Voice AI"
          title={
            <>
              A voice that sounds like{" "}
              <span className="text-gradient">you.</span>
            </>
          }
          description="Clone your voice from a short sample, then speak and listen in 120+ languages. Natural text to speech, precise speech to text, and 30+ accents that sound local."
        />

        {/* ------------------------------------------------ voice console */}
        <Reveal className="relative mx-auto max-w-3xl">
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-x-20 -inset-y-12 -z-10 blur-3xl"
            style={{
              background: "radial-gradient(closest-side, rgb(110 110 247 / 0.09), transparent)",
            }}
          />
          <div className="relative rounded-hero border border-hairline bg-surface p-8 shadow-soft md:p-12">
            {/* header: mic motif + status, demo picker */}
            <div className="flex flex-wrap items-center justify-between gap-5">
              <div className="flex items-center gap-4">
                <div className="relative">
                  {playing && !reduce ? (
                    <>
                      <span
                        aria-hidden
                        className="animate-pulse-ring absolute inset-0 rounded-xl border border-violet/50"
                      />
                      <span
                        aria-hidden
                        className="animate-pulse-ring absolute inset-0 rounded-xl border border-violet/40"
                        style={{ animationDelay: "1.2s" }}
                      />
                    </>
                  ) : null}
                  <span className="relative flex size-11 items-center justify-center rounded-xl bg-violet/10 text-violet">
                    <MicIcon />
                  </span>
                </div>
                <div>
                  <p className="text-sm font-medium text-ink">Voice console</p>
                  <p aria-live="polite" className="text-xs text-faint">
                    {playing ? `Playing · ${activeDemo.label}` : "Choose a demo, then press play"}
                  </p>
                </div>
              </div>

              <div
                role="group"
                aria-label="Voice demo"
                className="inline-flex items-center rounded-full border border-hairline bg-sunken p-1"
              >
                {DEMOS.map((demo, i) => {
                  const active = i === demoIndex;
                  return (
                    <button
                      key={demo.id}
                      type="button"
                      onClick={() => selectDemo(i)}
                      aria-pressed={active}
                      className={cn(
                        "relative cursor-pointer rounded-full px-4 py-1.5 text-sm font-medium transition-colors duration-200",
                        active ? "text-ink" : "text-faint hover:text-muted",
                      )}
                    >
                      {active ? (
                        reduce ? (
                          <span
                            aria-hidden
                            className="absolute inset-0 rounded-full border border-violet/25 bg-surface shadow-soft"
                          />
                        ) : (
                          <motion.span
                            aria-hidden
                            layoutId="voice-demo-thumb"
                            transition={spring}
                            className="absolute inset-0 rounded-full border border-violet/25 bg-surface shadow-soft"
                          />
                        )
                      ) : null}
                      <span className="relative">{demo.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* waveform — driven by the real audio while playing */}
            <div
              ref={waveRef}
              aria-hidden
              onPointerMove={(e) => {
                if (reduce || e.pointerType !== "mouse") return;
                const r = waveRef.current!.getBoundingClientRect();
                hoverRef.current.frac = (e.clientX - r.left) / r.width;
              }}
              onPointerEnter={(e) => {
                if (e.pointerType !== "mouse") return;
                startIdleHover();
              }}
              onPointerLeave={() => {
                hoverRef.current.frac = -1;
                stopIdleHover();
              }}
              onPointerCancel={() => {
                hoverRef.current.frac = -1;
                stopIdleHover();
              }}
              onClick={(e) => {
                const audio = audioRef.current;
                if (!audio || audio.paused || !isFinite(audio.duration)) return;
                const r = waveRef.current!.getBoundingClientRect();
                audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
              }}
              className={cn(
                "my-10 flex h-20 items-center gap-[3px] md:my-12 md:h-24 md:gap-1.5",
                playing && "cursor-ew-resize",
              )}
            >
              {Array.from({ length: BAR_COUNT }, (_, i) => {
                const center = i >= CENTER_START && i < CENTER_END;
                return (
                  <div
                    key={i}
                    ref={(el) => {
                      barRefs.current[i] = el;
                    }}
                    className={cn(
                      "h-full min-w-0 flex-1 origin-center rounded-full will-change-transform",
                      !center && "bg-ink",
                    )}
                    style={{
                      transform: `scaleY(${idleScale(i)})`,
                      backgroundColor: center ? centerBarColor(i) : undefined,
                    }}
                  />
                );
              })}
            </div>

            {/* transport */}
            <div className="flex flex-col items-center gap-4">
              <Magnetic>
                <button
                  type="button"
                  onClick={togglePlay}
                  aria-pressed={playing}
                  aria-label={playing ? `Pause ${activeDemo.label}` : `Play ${activeDemo.label}`}
                  aria-describedby="voice-demo-transcript"
                  className="relative flex size-[72px] cursor-pointer items-center justify-center rounded-full bg-ink text-white shadow-lift transition-[transform,box-shadow] duration-200 hover:-translate-y-1 active:translate-y-0 active:scale-[0.98]"
                >
                  {playing && !reduce ? (
                    <>
                      <span
                        aria-hidden
                        className="animate-pulse-ring absolute inset-0 rounded-full border-2 border-violet/40"
                      />
                      <span
                        aria-hidden
                        className="animate-pulse-ring absolute inset-0 rounded-full border border-violet/30"
                        style={{ animationDelay: "0.8s" }}
                      />
                    </>
                  ) : null}
                  {playing ? (
                    <PauseIcon className="relative size-6" />
                  ) : (
                    <PlayIcon className="relative ml-1 size-6" />
                  )}
                </button>
              </Magnetic>
              <p className="text-xs font-medium tracking-[0.14em] text-faint uppercase">
                {playing ? "Now playing" : "Hear it live"}
              </p>
              <p
                id="voice-demo-transcript"
                className="max-w-md text-center text-sm text-muted italic"
              >
                &ldquo;{activeDemo.transcript}&rdquo;
              </p>
            </div>

            <audio
              ref={audioRef}
              src={activeDemo.src}
              preload="none"
              onPlay={handlePlay}
              onPause={handleStop}
              onEnded={handleStop}
            />
          </div>
        </Reveal>

        {/* ------------------------------------------------ feature tiles */}
        <motion.ul
          variants={stagger(0.1, 0.08)}
          initial="hidden"
          whileInView="visible"
          viewport={viewportOnce}
          className="mx-auto mt-12 grid max-w-5xl grid-cols-2 gap-4 md:mt-14 md:grid-cols-4"
        >
          {FEATURES.map((feature) => (
            <motion.li
              key={feature.title}
              variants={fadeRise}
              className="rounded-card border border-hairline bg-surface p-5 shadow-soft transition-[transform,box-shadow] duration-300 hover:-translate-y-1 hover:shadow-lift md:p-6"
            >
              <span
                className={cn(
                  "flex size-10 items-center justify-center rounded-xl",
                  feature.hue,
                )}
              >
                {feature.icon}
              </span>
              <h3 className="mt-4 text-base font-medium text-ink">{feature.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{feature.blurb}</p>
            </motion.li>
          ))}
        </motion.ul>
      </div>
    </Section>
  );
}
