"use client";

import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from "framer-motion";
import { cn } from "@/lib/cn";

/**
 * Hero device — a premium iPhone-class handset presented in three-quarter 3D,
 * running the live YSNAP translation thread on screen. Built in DOM rather than
 * WebGL so the UI stays pixel-crisp, the colors stay true, and it paints on
 * first frame (no shader warm-up, no washed-out env lighting).
 *
 * Depth comes from a real perspective transform, a preserve-3d extruded edge,
 * layered contact shadows and a specular sweep across the glass.
 */

/* ------------------------------------------------------------------ data */

type Msg = {
  side: "in" | "out";
  /** flag emoji shown in the sender puck */
  flag?: string;
  /** what they actually said */
  original: string;
  /** what YSNAP renders it as */
  translated: string;
  /** optional romanization line (transliteration feature) */
  translit?: string;
};

const THREAD: Msg[] = [
  { side: "in", flag: "🇫🇷", original: "Salut ! On se retrouve où ?", translated: "Hi! Where are we meeting?" },
  { side: "out", original: "The café by the museum", translated: "Le café près du musée" },
  { side: "in", flag: "🇯🇵", original: "こんにちは、了解です", translated: "Hello — got it", translit: "konnichiwa, ryōkai desu" },
  { side: "in", flag: "🇮🇳", original: "नमस्ते, मैं रास्ते में हूँ", translated: "Hello, I'm on my way", translit: "namaste, main raaste mein hoon" },
  { side: "out", original: "Perfect, see you in ten!", translated: "Parfait, à dans dix minutes !" },
];

/** seconds between each bubble's entrance */
const STEP = 0.62;

/* ------------------------------------------------------------------ chrome */

function StatusBar() {
  return (
    <div className="flex items-center justify-between px-1 text-[10px] font-semibold text-white/95">
      <span className="tabular-nums">9:41</span>
      <span className="flex items-center gap-[3px]" aria-hidden>
        {/* signal */}
        <svg viewBox="0 0 18 12" className="h-[9px] w-[14px]" fill="currentColor">
          <rect x="0" y="8" width="3" height="4" rx="1" />
          <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
          <rect x="10" y="3" width="3" height="9" rx="1" />
          <rect x="15" y="0.5" width="3" height="11.5" rx="1" opacity="0.45" />
        </svg>
        {/* wifi */}
        <svg viewBox="0 0 16 12" className="h-[9px] w-[12px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M1 4.2a10 10 0 0 1 14 0" />
          <path d="M3.6 6.9a6.3 6.3 0 0 1 8.8 0" />
          <circle cx="8" cy="10" r="0.9" fill="currentColor" stroke="none" />
        </svg>
        {/* battery */}
        <span className="relative ml-[1px] flex h-[9px] w-[17px] items-center rounded-[3px] border border-white/70 px-[1.5px]">
          <span className="h-[4.5px] w-[10px] rounded-[1px] bg-white" />
          <span className="absolute -right-[2.5px] h-[3px] w-[1.5px] rounded-r-sm bg-white/70" />
        </span>
      </span>
    </div>
  );
}

function GlobeGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.6 2.6 2.6 15 0 18M12 3c-2.6 2.6-2.6 15 0 18" />
    </svg>
  );
}

/* ------------------------------------------------------------------ bubbles */

function Bubble({ msg, delay, reduce }: { msg: Msg; delay: number; reduce: boolean }) {
  const enter = { opacity: 1, y: 0, scale: 1 };
  const from = reduce
    ? { opacity: 1, y: 0, scale: 1 }
    : { opacity: 0, y: 14, scale: 0.94 };

  if (msg.side === "out") {
    return (
      <motion.div
        initial={from}
        animate={enter}
        transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
        className="flex justify-end"
      >
        <div className="max-w-[78%] rounded-2xl rounded-br-md bg-[linear-gradient(135deg,#5b88ff,#6e6ef7)] px-3 py-2 shadow-[0_6px_14px_rgb(76_125_255/0.28)]">
          <p className="text-[12px] font-medium leading-snug text-white">{msg.original}</p>
          <p className="mt-1 flex items-center gap-1 text-[10px] leading-tight text-white/75">
            <GlobeGlyph className="h-[9px] w-[9px]" />
            {msg.translated}
          </p>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={from}
      animate={enter}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
      className="flex items-end gap-1.5"
    >
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white text-[12px] shadow-[0_2px_6px_rgb(11_12_14/0.12)]">
        {msg.flag}
      </span>
      <div className="max-w-[78%] rounded-2xl rounded-bl-md border border-hairline bg-white px-3 py-2 shadow-[0_4px_12px_rgb(11_12_14/0.07)]">
        <p className="text-[10.5px] leading-snug text-faint">{msg.original}</p>
        {msg.translit ? (
          <p className="text-[9.5px] italic leading-snug text-accent/70">{msg.translit}</p>
        ) : null}
        <span className="my-1.5 block h-px bg-ink/[0.07]" />
        <p className="text-[12px] font-medium leading-snug text-ink">{msg.translated}</p>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ device */

export default function HeroDevice({ className }: { className?: string }) {
  const reduce = useReducedMotion() ?? false;

  /* The three-quarter tilt only earns its keep where a pointer can drive it.
     On touch it would freeze mid-rotation — permanently skewed and visually
     off-centre — so phones get the device square-on instead. */
  const [pointerFine, setPointerFine] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(pointer: fine)");
    const sync = () => setPointerFine(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  const tilt = pointerFine && !reduce;

  /* mouse-tracked three-quarter tilt (fine pointers only) */
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);
  const rotY = useSpring(useTransform(px, [0, 1], [-22, -4]), { stiffness: 120, damping: 22 });
  const rotX = useSpring(useTransform(py, [0, 1], [10, -2]), { stiffness: 120, damping: 22 });

  /* Lighting and depth answer the same pointer: a specular highlight tracks the
     cursor across the glass, the ground shadow slides opposite the tilt, and the
     surrounding bubbles parallax against the device. Those three cues together
     are what sell a real 3D render rather than a rotated picture. */
  const glare = useTransform(
    [px, py],
    ([x, y]) =>
      `radial-gradient(320px circle at ${((x as number) * 100).toFixed(1)}% ${((y as number) * 100).toFixed(1)}%, rgb(255 255 255 / 0.45), rgb(255 255 255 / 0.12) 30%, transparent 62%)`,
  );
  const shadowX = useTransform(rotY, (v) => -v * 2.4);
  const parallaxX = useTransform(px, [0, 1], [18, -18]);
  const parallaxY = useTransform(py, [0, 1], [11, -11]);

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!tilt || e.pointerType !== "mouse") return;
    const r = e.currentTarget.getBoundingClientRect();
    px.set((e.clientX - r.left) / r.width);
    py.set((e.clientY - r.top) / r.height);
  };
  const onPointerLeave = () => {
    px.set(0.5);
    py.set(0.5);
  };

  return (
    <div
      className={cn("relative flex h-full w-full items-start justify-center", className)}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerCancel={onPointerLeave}
      style={{ perspective: 1400 }}
    >
      {/* warm ambient bloom behind the device */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[42%] h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, rgb(255 150 80 / 0.16), rgb(110 110 247 / 0.1), transparent 72%)",
        }}
      />

      {/* glossy iridescent bubbles — parallax against the device */}
      <Bubbles x={parallaxX} y={parallaxY} reduce={!tilt} />

      <motion.div
        className="relative mt-2"
        style={
          tilt
            ? { rotateY: rotY, rotateX: rotX, transformStyle: "preserve-3d" }
            : { transformStyle: "preserve-3d" }
        }
      >
        {/* extruded right edge — only visible in the turned pose; square-on it
            would peek out from behind the chassis as a stray sliver */}
        {tilt ? (
          <div
            aria-hidden
            className="absolute right-[3px] top-[10px] bottom-[10px] w-[16px] rounded-r-[22px]"
            style={{
              transform: "rotateY(-62deg) translateZ(-7px)",
              transformOrigin: "left center",
              background: "linear-gradient(90deg,#c2611f,#8e3f10 55%,#6d2f0a)",
            }}
          />
        ) : null}

        {/* titanium-orange chassis */}
        <div
          className="relative w-[264px] rounded-[46px] p-[3.5px] sm:w-[292px]"
          style={{
            aspectRatio: "9 / 19.5",
            background:
              "linear-gradient(148deg,#ffc79b 0%,#f59a5c 14%,#e8752e 34%,#c05e21 52%,#e07f3c 68%,#ffd0aa 86%,#d97a35 100%)",
            boxShadow:
              "0 2px 3px rgb(11 12 14 / 0.14), 0 26px 50px -18px rgb(184 85 28 / 0.5), 0 54px 90px -30px rgb(11 12 14 / 0.45), inset 0 1px 1px rgb(255 255 255 / 0.75), inset 0 -1px 2px rgb(109 47 10 / 0.5)",
          }}
        >
          {/* machined rail highlight */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[46px]"
            style={{
              background:
                "linear-gradient(112deg, rgb(255 255 255 / 0.5) 0%, rgb(255 255 255 / 0) 18%, rgb(255 255 255 / 0) 74%, rgb(255 255 255 / 0.3) 100%)",
            }}
          />

          {/* black bezel */}
          <div className="relative h-full w-full rounded-[43px] bg-[#08090b] p-[8px] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
            {/* screen */}
            <div className="relative h-full w-full overflow-hidden rounded-[36px] bg-[#f7f8fb]">
              {/* header */}
              <div className="relative bg-[linear-gradient(135deg,#4c7dff_0%,#6e6ef7_58%,#8b5cf6_100%)] px-3.5 pb-3 pt-2.5">
                <StatusBar />
                <div className="mt-4 flex items-center gap-2.5">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 text-white/85" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                  {/* stacked member pucks — a genuinely multilingual room */}
                  <span className="flex -space-x-2">
                    {["🇫🇷", "🇯🇵", "🇮🇳"].map((f) => (
                      <span
                        key={f}
                        className="grid h-7 w-7 place-items-center rounded-full border border-white/40 bg-white/25 text-[11px] backdrop-blur"
                      >
                        {f}
                      </span>
                    ))}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-semibold leading-tight text-white">
                      Trip Squad
                    </span>
                    <span className="flex items-center gap-1 text-[9.5px] leading-tight text-white/80">
                      <span className="h-1 w-1 rounded-full bg-green" />
                      Auto-translating · 4 languages
                    </span>
                  </span>
                  <GlobeGlyph className="h-4 w-4 text-white/85" />
                </div>
              </div>

              {/* thread */}
              <div className="flex flex-col gap-2 px-2.5 pb-3 pt-2.5">
                <span className="mx-auto mb-0.5 rounded-full bg-ink/[0.06] px-2 py-[3px] text-[8.5px] font-medium uppercase tracking-wider text-faint">
                  Today
                </span>
                {THREAD.map((m, i) => (
                  <Bubble key={i} msg={m} delay={i * STEP} reduce={reduce} />
                ))}

                {/* typing indicator */}
                <motion.div
                  initial={reduce ? { opacity: 1 } : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: THREAD.length * STEP + 0.2, duration: 0.4 }}
                  className="flex items-center gap-1.5"
                >
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white text-[12px] shadow-[0_2px_6px_rgb(11_12_14/0.12)]">
                    🇫🇷
                  </span>
                  <span className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-hairline bg-white px-3 py-2.5 shadow-[0_4px_12px_rgb(11_12_14/0.07)]">
                    {[0, 1, 2].map((d) => (
                      <span
                        key={d}
                        className="h-1.5 w-1.5 rounded-full bg-ink/25"
                        style={
                          reduce
                            ? undefined
                            : { animation: `soundwave 1s ease-in-out ${d * 0.16}s infinite` }
                        }
                      />
                    ))}
                  </span>
                </motion.div>
              </div>

              {/* feature chips */}
              <div className="absolute inset-x-0 bottom-[52px] flex justify-center gap-1.5 px-3">
                <span className="flex items-center gap-1 rounded-full border border-accent/20 bg-white/90 px-2.5 py-1 text-[9px] font-semibold text-accent-deep shadow-[0_4px_10px_rgb(11_12_14/0.08)] backdrop-blur">
                  <GlobeGlyph className="h-2.5 w-2.5" />
                  Auto-Translate
                </span>
                <span className="flex items-center gap-1 rounded-full border border-violet/20 bg-white/90 px-2.5 py-1 text-[9px] font-semibold text-violet shadow-[0_4px_10px_rgb(11_12_14/0.08)] backdrop-blur">
                  Tᴛ Transliteration
                </span>
              </div>

              {/* composer */}
              <div className="absolute inset-x-0 bottom-0 border-t border-hairline bg-white/95 px-3 pb-4 pt-2.5 backdrop-blur">
                <div className="flex items-center gap-2 rounded-full bg-sunken px-3 py-1.5">
                  <span className="text-[10.5px] text-faint">Message…</span>
                  <span className="ml-auto flex items-center gap-2 text-accent">
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
                      <rect x="9" y="3" width="6" height="11" rx="3" />
                      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                    </svg>
                  </span>
                </div>
                <span aria-hidden className="mx-auto mt-2.5 block h-[3.5px] w-[86px] rounded-full bg-ink/25" />
              </div>

              {/* dynamic island */}
              <div
                aria-hidden
                className="absolute left-1/2 top-2 z-30 h-[26px] w-[92px] -translate-x-1/2 rounded-full bg-black shadow-[0_0_0_1px_rgb(255_255_255/0.06)]"
              >
                <span className="absolute right-3 top-1/2 h-[7px] w-[7px] -translate-y-1/2 rounded-full bg-[radial-gradient(circle_at_35%_30%,#2b3a4a,#0b0f14_70%)]" />
              </div>

              {/* fixed sheen — the constant edge-light on the glass */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 z-40"
                style={{
                  background:
                    "linear-gradient(118deg, rgb(255 255 255 / 0.26) 0%, rgb(255 255 255 / 0.05) 24%, rgb(255 255 255 / 0) 46%)",
                }}
              />
              {/* cursor-tracked specular highlight */}
              <motion.div
                aria-hidden
                className="pointer-events-none absolute inset-0 z-40 mix-blend-screen"
                style={tilt ? { backgroundImage: glare } : undefined}
              />
            </div>
          </div>

          {/* side buttons */}
          <div aria-hidden className="absolute -left-[2.5px] top-[19%] h-8 w-[3px] rounded-l-full bg-[linear-gradient(90deg,#8e3f10,#e0873f)]" />
          <div aria-hidden className="absolute -left-[2.5px] top-[28%] h-14 w-[3px] rounded-l-full bg-[linear-gradient(90deg,#8e3f10,#e0873f)]" />
          <div aria-hidden className="absolute -right-[2.5px] top-[24%] h-20 w-[3px] rounded-r-full bg-[linear-gradient(270deg,#8e3f10,#e0873f)]" />
        </div>

        {/* contact shadow on the ground plane — slides against the tilt */}
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-8 left-1/2 h-10 w-[74%] -translate-x-1/2"
        >
          <motion.div
            className="h-full w-full rounded-[50%] bg-[rgb(11_12_14/0.28)] blur-2xl"
            style={tilt ? { x: shadowX } : undefined}
          />
        </div>
      </motion.div>
    </div>
  );
}

/* ------------------------------------------------------------------ bubbles */

/** Glossy iridescent spheres — the "premium 3D render" surround. */
function Bubbles({
  x,
  y,
  reduce,
}: {
  x: MotionValue<number>;
  y: MotionValue<number>;
  reduce: boolean;
}) {
  const SPEC: ReadonlyArray<{ cls: string; size: number; bg: string; delay: string; dur: string }> = [
    {
      cls: "left-[6%] top-[12%]",
      size: 58,
      bg: "radial-gradient(circle at 30% 26%, #ffffff 0%, #cfe0ff 22%, #7ba2ff 55%, #4c7dff 100%)",
      delay: "0s",
      dur: "9s",
    },
    {
      cls: "right-[8%] top-[20%]",
      size: 34,
      bg: "radial-gradient(circle at 32% 28%, #ffffff 0%, #ffd9ee 24%, #f79cd0 58%, #f0559c 100%)",
      delay: "-3s",
      dur: "11s",
    },
    {
      cls: "left-[12%] bottom-[16%]",
      size: 26,
      bg: "radial-gradient(circle at 34% 30%, #ffffff 0%, #d4f6f0 26%, #6fd8cc 60%, #10b3a3 100%)",
      delay: "-6s",
      dur: "10s",
    },
    {
      cls: "right-[12%] bottom-[22%]",
      size: 44,
      bg: "radial-gradient(circle at 30% 26%, #ffffff 0%, #ffe6c2 24%, #ffbf6b 58%, #f59e0b 100%)",
      delay: "-1.5s",
      dur: "12s",
    },
  ];

  return (
    <motion.div
      aria-hidden
      className="pointer-events-none absolute inset-0 hidden lg:block"
      style={reduce ? undefined : { x, y }}
    >
      {SPEC.map((b, i) => (
        <span
          key={i}
          className={cn("animate-floaty absolute rounded-full", b.cls)}
          style={{
            height: b.size,
            width: b.size,
            background: b.bg,
            animationDelay: b.delay,
            animationDuration: b.dur,
            boxShadow:
              "inset 0 -6px 12px rgb(255 255 255 / 0.45), inset 0 4px 10px rgb(11 12 14 / 0.06), 0 14px 30px rgb(11 12 14 / 0.14)",
            opacity: 0.9,
          }}
        />
      ))}
    </motion.div>
  );
}
