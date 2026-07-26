"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";
import { Section, SectionHeading } from "@/components/ui/section";
import s from "@/components/ui/camera-3d.module.css";

/**
 * AICamera — the camera demo as a real 3D stage.
 *
 * The phone is an extruded stack of translateZ slices, and so is every subject
 * inside its viewfinder: a milled coin, a veined leaf, a two-tone capsule, a
 * sprinkled donut, a layered π, a stack of paper. Picking a mode re-themes the
 * whole section from one accent, drops the new subject in, sweeps a scan beam,
 * fires the shutter flash, and types the result out.
 *
 * Port notes vs. the standalone page: responsive (rail becomes a horizontal
 * scroller and the phone scales under lg), the rAF tilt pauses offscreen and on
 * hidden tabs, and prefers-reduced-motion gets a still, fully-populated frame.
 * All "random" decoration is precomputed so SSR and the client agree.
 */

type ModeKey = "Coin" | "Plant" | "Medical" | "Food" | "Math" | "Essay";

type Mode = {
  key: ModeKey;
  build: "coin" | "leaf" | "pill" | "donut" | "math" | "essay";
  acc: string;
  bg: string;
  br: string;
  icon: string;
  scan: string;
  title: string;
  sub: string;
  chips: string[];
  sum: string;
  stats: [string, string][];
  cap: string;
};

const MODES: Mode[] = [
  {
    key: "Coin", build: "coin", acc: "#f5a623", bg: "#fdf4e3", br: "#f6e2b8", icon: "🪙",
    scan: "Scanning coin", title: "Coin identified", sub: "Morgan Dollar · 1891-S · silver 90%",
    chips: ["Value now", "History", "Rarity", "Sell guide", "Compare"],
    sum: "Struck in San Francisco, 1891. Strong strike, light wear — collectors currently pay $190–240 for this grade.",
    stats: [["$214", "EST. VALUE"], ["96%", "MATCH"], ["0.14s", "ANSWER"]],
    cap: "Identifies any coin, dates it, grades it, and prices it against live collector markets.",
  },
  {
    key: "Plant", build: "leaf", acc: "#22b573", bg: "#e9f9f1", br: "#c6ecd8", icon: "🌿",
    scan: "Scanning leaf", title: "Plant identified", sub: "Ficus elastica · rubber plant",
    chips: ["Care plan", "Watering", "Light needs", "Diagnose", "Repot guide"],
    sum: "Healthy foliage with minor dehydration. Water every 7–9 days, bright indirect light, wipe leaves monthly.",
    stats: [["96%", "SPECIES"], ["84%", "HEALTH"], ["0.18s", "ANSWER"]],
    cap: "Names the plant, checks its health, and writes a care routine that fits your home.",
  },
  {
    key: "Medical", build: "pill", acc: "#ff4f6e", bg: "#ffeef2", br: "#ffd4dd", icon: "💊",
    scan: "Scanning pill", title: "Pill verified", sub: "Amoxicillin · 500 mg · imprint A45",
    chips: ["Dosage", "Interactions", "Side effects", "Schedule", "Alternatives"],
    sum: "Verified against the imprint database. Standard adult dose 500 mg every 8 h — avoid combining with methotrexate.",
    stats: [["97%", "MATCH"], ["12", "INTERACTIONS"], ["0.15s", "ANSWER"]],
    cap: "Verifies pills from their imprint, flags interactions, and builds reminder schedules.",
  },
  {
    key: "Food", build: "donut", acc: "#ff7a2e", bg: "#fff1e7", br: "#ffd9bd", icon: "🍩",
    scan: "Scanning food", title: "Food scanned", sub: "Glazed donut · 1 piece · 312 kcal",
    chips: ["Calories", "Macros", "Recipe", "Healthier swap", "Log meal"],
    sum: "Approx. 312 kcal — 44 g carbs, 14 g fat, 4 g protein. A baked version saves ~120 kcal; logged to today.",
    stats: [["312", "KCAL"], ["44g", "CARBS"], ["0.12s", "ANSWER"]],
    cap: "Counts calories and macros from a photo, then suggests smarter swaps and logs your meal.",
  },
  {
    key: "Math", build: "math", acc: "#7b5cff", bg: "#f0edff", br: "#ddd5ff", icon: "π",
    scan: "Scanning equation", title: "Problem solved", sub: "∫ x·sin(x) dx — integration by parts",
    chips: ["Show steps", "Graph it", "Practice set", "Explain", "Copy LaTeX"],
    sum: "= sin(x) − x·cos(x) + C. Solved in 3 steps using integration by parts with u = x, dv = sin(x) dx.",
    stats: [["3", "STEPS"], ["98%", "CONFIDENCE"], ["0.11s", "ANSWER"]],
    cap: "Reads handwriting or print, solves step by step, and graphs the result instantly.",
  },
  {
    key: "Essay", build: "essay", acc: "#6d7bff", bg: "#eef0ff", br: "#dfe3ff", icon: "📄",
    scan: "Scanning text", title: "Essay scanned", sub: "412 words · English",
    chips: ["Rewrite", "Summarize", "Translate", "Read aloud", "Explain"],
    sum: "Argues that later school start times improve results, citing sleep research and attendance data.",
    stats: [["412", "WORDS"], ["B2", "LEVEL"], ["0.16s", "ANSWER"]],
    cap: "Lifts text off the page, then rewrites, summarises, translates or reads it aloud.",
  },
];

/* ------------------------------------------------------- 3D subject parts */

function Stack({
  w, h, n, gap, slice, children,
}: {
  w: number; h: number; n: number; gap: number;
  slice: (i: number, n: number) => CSSProperties;
  children?: ReactNode;
}) {
  return (
    <div className={s.objWrap} style={{ width: w, height: h }}>
      {Array.from({ length: n }, (_, i) => (
        <div
          key={i}
          className={s.oslice}
          style={{ ...slice(i, n), transform: `translateZ(${(-n / 2 + i) * gap}px)` }}
        />
      ))}
      {children}
    </div>
  );
}

const LEAF_POLY =
  "polygon(50% 0%,78% 14%,94% 40%,88% 70%,64% 92%,50% 100%,36% 92%,12% 70%,6% 40%,22% 14%)";

/* Sprinkles are placed on a golden-angle spiral rather than Math.random() —
   a random layout would differ between the server render and the client and
   trip a hydration mismatch. */
const SPRINKLES = Array.from({ length: 14 }, (_, k) => {
  const a = k * 2.399963;
  const r = 30 + ((k * 7) % 12);
  return { a, r, rot: (k * 47) % 180, c: ["#fff", "#ffe066", "#7cf0c8", "#8fb8ff", "#ffd1e0"][k % 5] };
});

function Coin({ sc = 1 }: { sc?: number }) {
  return (
    <div className={s.spinY}>
      <Stack
        w={100 * sc} h={100 * sc} n={12} gap={1.6 * sc}
        slice={(i, n) => ({
          borderRadius: "50%",
          background:
            i === 0 || i === n - 1
              ? "radial-gradient(circle at 34% 30%,#ffe9b0,#f5a623 55%,#b97a12)"
              : "linear-gradient(160deg,#e8b64f,#c98d1e)",
          boxShadow: "inset 0 2px 5px rgb(255 255 255 / .5), inset 0 -3px 6px rgb(120 70 10 / .3)",
        })}
      >
        <div
          style={{
            position: "absolute", inset: 9 * sc, borderRadius: "50%",
            transform: `translateZ(${10 * sc}px)`,
            border: `${3 * sc}px dashed rgb(140 90 15 / .55)`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontWeight: 900, fontSize: 42 * sc, color: "#8a5c10",
          }}
        >
          $
        </div>
      </Stack>
    </div>
  );
}

function Leaf({ sc = 1 }: { sc?: number }) {
  return (
    <div className={s.sway}>
      <Stack
        w={92 * sc} h={118 * sc} n={8} gap={1.4 * sc}
        slice={(i, n) => ({
          clipPath: LEAF_POLY,
          background:
            i === 0 || i === n - 1
              ? "linear-gradient(160deg,#5fd792,#22b573 55%,#128253)"
              : "linear-gradient(160deg,#3ec981,#1ba367)",
        })}
      >
        <div
          style={{
            position: "absolute", inset: 0, clipPath: LEAF_POLY,
            transform: `translateZ(${7 * sc}px)`, opacity: 0.75,
            background: `linear-gradient(#0f7a4d ${2 * sc}px, transparent ${2 * sc}px) 50% 0/${2 * sc}px 100% no-repeat, repeating-linear-gradient(38deg, transparent 0 ${11 * sc}px, rgb(15 122 77 / .5) ${11 * sc}px ${12.5 * sc}px)`,
          }}
        />
      </Stack>
    </div>
  );
}

function Pill({ sc = 1 }: { sc?: number }) {
  return (
    <div className={s.spinY}>
      <div style={{ transform: "rotateZ(-16deg)", transformStyle: "preserve-3d" }}>
        <Stack
          w={126 * sc} h={50 * sc} n={12} gap={1.5 * sc}
          slice={(i, n) => {
            const e = i === 0 || i === n - 1;
            return {
              borderRadius: 25 * sc,
              background: `linear-gradient(90deg, ${e ? "#d13853" : "#ff4f6e"} 0 50%, ${e ? "#dfe3ec" : "#ffffff"} 50% 100%)`,
              boxShadow: `inset 0 ${e ? 0 : 3}px 6px rgb(255 255 255 / .5), inset 0 -3px 6px rgb(120 20 40 / .18)`,
            };
          }}
        >
          <div
            style={{
              position: "absolute", left: "50%", top: 0, bottom: 0,
              width: 2 * sc, background: "rgb(120 20 40 / .25)",
              transform: `translateZ(${9.6 * sc}px)`,
            }}
          />
        </Stack>
      </div>
    </div>
  );
}

function Donut({ sc = 1 }: { sc?: number }) {
  return (
    <div className={s.spinY}>
      <Stack
        w={108 * sc} h={108 * sc} n={10} gap={1.7 * sc}
        slice={(i, n) => ({
          background: `radial-gradient(circle, transparent 0 ${21 * sc}px, #e8b04f ${21 * sc}px ${52 * sc}px, transparent ${52 * sc}px)`,
          filter: i === 0 || i === n - 1 ? "brightness(.9)" : undefined,
        })}
      >
        <div
          style={{
            position: "absolute", inset: 0, transform: `translateZ(${8.5 * sc}px)`,
            background: `radial-gradient(circle, transparent 0 ${22 * sc}px, #ff6f9c ${22 * sc}px ${48 * sc}px, transparent ${48 * sc}px)`,
          }}
        />
        {SPRINKLES.map((p, k) => (
          <div
            key={k}
            style={{
              position: "absolute",
              left: 54 * sc + Math.cos(p.a) * p.r * sc,
              top: 54 * sc + Math.sin(p.a) * p.r * sc,
              width: 7 * sc, height: 2.5 * sc, borderRadius: 2,
              background: p.c,
              transform: `translateZ(${9 * sc}px) rotate(${p.rot}deg)`,
            }}
          />
        ))}
      </Stack>
    </div>
  );
}

function MathPi({ sc = 1 }: { sc?: number }) {
  return (
    <div className={s.spinY}>
      <div className={s.objWrap} style={{ width: 110 * sc, height: 110 * sc }}>
        {Array.from({ length: 11 }, (_, i) => (
          <div
            key={i}
            style={{
              position: "absolute", inset: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 88 * sc, fontWeight: 900,
              transform: `translateZ(${(-5 + i) * 1.6 * sc}px)`,
              color: i === 10 ? "#7b5cff" : i === 0 ? "#3d2c8f" : "#5a43c9",
            }}
          >
            π
          </div>
        ))}
      </div>
    </div>
  );
}

function Essay({ sc = 1 }: { sc?: number }) {
  return (
    <div className={s.sway}>
      <Stack
        w={98 * sc} h={128 * sc} n={6} gap={1.5 * sc}
        slice={(i, n) => ({
          borderRadius: 7 * sc,
          background: i === 0 || i === n - 1 ? "#eef0f6" : "#ffffff",
          boxShadow: i === n - 1 ? `0 ${10 * sc}px ${22 * sc}px rgb(35 55 110 / .16)` : undefined,
        })}
      >
        <div
          style={{
            position: "absolute", inset: 11 * sc, transform: `translateZ(${5 * sc}px)`,
            background: `linear-gradient(#3c465c ${3 * sc}px, transparent ${3 * sc}px) 0 0/62% 100% no-repeat, repeating-linear-gradient(#c3cadb 0 ${2.4 * sc}px, transparent ${2.4 * sc}px ${10 * sc}px) 0 ${13 * sc}px/100% calc(100% - ${13 * sc}px) no-repeat`,
          }}
        />
      </Stack>
    </div>
  );
}

const BUILDERS: Record<Mode["build"], (p: { sc?: number }) => ReactNode> = {
  coin: Coin, leaf: Leaf, pill: Pill, donut: Donut, math: MathPi, essay: Essay,
};

/* ------------------------------------------------------------------ section */

export default function AICamera() {
  const reduce = useReducedMotion() ?? false;
  const [idx, setIdx] = useState(5); // opens on Essay, as the reference does
  const [scanning, setScanning] = useState(false);
  const [flash, setFlash] = useState(false);
  const [typed, setTyped] = useState("");
  const [captured, setCaptured] = useState(true);
  const [paused, setPaused] = useState(false);
  /* Explicit stop, distinct from `paused` (hover). Hover-pause alone leaves
     touch and keyboard users with no way to halt the rotation, which is what
     WCAG 2.2.2 asks for. */
  const [autoOff, setAutoOff] = useState(false);
  /* On screen AND tab visible, as state so the advance effect re-arms. */
  const [live, setLive] = useState(false);

  const camBtnRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const phRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const beamRef = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const inViewRef = useRef(false);

  const mode = MODES[idx];
  const Subject = BUILDERS[mode.build];

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  /* ---- scan sequence: beam sweep → shutter flash → typed result ---- */
  const runScan = () => {
    if (reduce) {
      setTyped(mode.sum);
      setCaptured(true);
      return;
    }
    clearTimers();
    setScanning(true);
    setCaptured(false);
    setTyped("");
    const beam = beamRef.current;
    if (beam) {
      beam.style.transition = "none";
      beam.style.top = "2%";
      beam.style.opacity = "1";
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          beam.style.transition = "top 1s ease-in-out, opacity .35s .85s";
          beam.style.top = "84%";
          beam.style.opacity = "0";
        }),
      );
    }
    later(() => {
      setFlash(true);
      later(() => setFlash(false), 520);
    }, 1050);
    later(() => {
      setScanning(false);
      setCaptured(true);
    }, 1400);
  };

  /* re-run the scan whenever the mode changes (and on first reveal) */
  useEffect(() => {
    /* Drop the capture up front. `mode.sum` changes the instant idx does,
       while `captured` was still true from the previous mode — so the
       typewriter began spelling out the new summary, got ~30 characters in,
       and was wiped when runScan cleared it 420ms later. Blanking here means
       it types once, after the scan, instead of stuttering every pass. */
    if (!reduce) setCaptured(false);
    if (!inViewRef.current) return;
    const t = window.setTimeout(runScan, 420);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  /* typewriter for the summary — starts once the capture lands */
  useEffect(() => {
    if (!captured) return;
    if (reduce) {
      setTyped(mode.sum);
      return;
    }
    let i = 0;
    setTyped("");
    const iv = window.setInterval(() => {
      i += 1;
      setTyped(mode.sum.slice(0, i));
      if (i >= mode.sum.length) window.clearInterval(iv);
    }, 14);
    return () => window.clearInterval(iv);
  }, [captured, mode.sum, reduce]);

  /* auto-advance — only while on screen, tab visible, not hovered, not stopped.
     `live` has to be state, not the inViewRef the tilt loop uses: the guard
     used to sit inside the timeout, so a tick that fired while the section was
     offscreen simply did nothing — and since `idx` is this timer's only writer,
     nothing re-armed it and the tour stayed dead for the life of the page.
     Scrolling back mutated the ref without re-rendering, so it never recovered.
     As state it belongs in the deps and the effect re-arms on the way back in. */
  useEffect(() => {
    if (reduce || paused || autoOff || !live) return;
    const t = window.setTimeout(() => setIdx((i) => (i + 1) % MODES.length), 8200);
    return () => window.clearTimeout(t);
  }, [idx, reduce, paused, autoOff, live]);

  /* tilt + float, paused offscreen and on hidden tabs */
  useEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    const ph = phRef.current;
    if (!root || !stage || !ph) return;

    if (reduce) {
      inViewRef.current = true;
      setTyped(MODES[5].sum);
      return;
    }

    let mx = 0, my = 0, t = 0, pt = 0, raf = 0;
    let pageVisible = !document.hidden;

    const frame = (now: number) => {
      if (pt === 0) pt = now;
      const dt = Math.min(0.05, (now - pt) / 1000);
      pt = now;
      t += dt;
      stage.style.transform = `rotateX(${-my * 2}deg) rotateY(${mx * 2.6}deg)`;
      ph.style.transform = `translateY(${Math.sin(t * 1.05) * 6}px) rotateY(${-9 + Math.sin(t * 0.5) * 6 + mx * 5}deg) rotateX(${4 - my * 4}deg)`;
      const card = cardRef.current;
      if (card) card.style.transform = `rotateY(${mx * -4}deg) rotateX(${my * 2.6}deg)`;
      raf = requestAnimationFrame(frame);
    };
    const running = () => inViewRef.current && pageVisible;
    const sync = () => {
      if (running()) {
        if (raf === 0) { pt = 0; raf = requestAnimationFrame(frame); }
      } else if (raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    const io = new IntersectionObserver(
      ([e]) => {
        if (!e) return;
        const first = !inViewRef.current && e.isIntersecting;
        inViewRef.current = e.isIntersecting;
        setLive(e.isIntersecting && !document.hidden);
        sync();
        if (first) later(runScan, 300); // greet on arrival
      },
      { rootMargin: "80px" },
    );
    io.observe(root);
    const onVis = () => {
      pageVisible = !document.hidden;
      setLive(inViewRef.current && !document.hidden);
      sync();
    };
    document.addEventListener("visibilitychange", onVis);
    const onMove = (e: PointerEvent) => {
      mx = (e.clientX / window.innerWidth - 0.5) * 2;
      my = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    sync();
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointermove", onMove);
      clearTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduce]);

  const themeVars = {
    "--acc": mode.acc,
    "--accBg": mode.bg,
    "--accBr": mode.br,
    "--accSh": `${mode.acc}40`,
    "--accS": `${mode.acc}44`,
  } as CSSProperties;

  const pick = (i: number) => {
    /* Choosing a mode hands control over — the tour stops rather than moving
       on from the thing they just asked to see. */
    setAutoOff(true);
    if (i === idx) return;
    clearTimers();
    setIdx(i);
  };

  return (
    <Section id="camera" tone="surface">
      <div
        ref={rootRef}
        className="shell"
        style={themeVars}
        /* Mouse-only: on touch, pointerenter arrives without a matching leave,
           which would latch the tour off after one stray tap. */
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") setPaused(true);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setPaused(false);
        }}
        /* Focus-within pause, so modes stop changing under a keyboard user
           reading the rail. The Auto control is exempt — it sits inside this
           same region, and counting its own focus would stop Play working. */
        onFocus={(e) => {
          if (!camBtnRef.current?.contains(e.target as Node)) setPaused(true);
        }}
        onBlur={() => setPaused(false)}
      >
        <SectionHeading
          eyebrow="AI Camera"
          title={
            <>
              Point it at <span className="text-gradient">anything.</span>
            </>
          }
          description="The camera that understands the world in front of it. It walks through the modes on its own — pick one to take over."
        />

        {/* Auto-rotation control. Hover-pause covers mice only; this is the
            stop that touch and keyboard users can actually reach. Hidden
            under reduced motion, where nothing rotates to begin with. */}
        {!reduce ? (
          <div className="-mt-2 mb-8 flex justify-center">
            <button
              ref={camBtnRef}
              type="button"
              onClick={() => {
                setAutoOff((v) => !v);
                setPaused(false); // a click parks focus/pointer here; don't re-pause
              }}
              /* Name leads with the visible word for speech input (WCAG 2.5.3). */
              aria-label={autoOff ? "Paused: play the mode tour" : "Auto: pause the mode tour"}
              /* before: widens the tap target to ~45px without inflating the
                 pill — see the matching control in live-demo.tsx. */
              className="relative inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-hairline bg-surface px-2.5 py-1 transition-all duration-200 before:absolute before:-inset-x-1 before:-inset-y-2.5 before:content-[''] hover:border-[#dcdcdc] hover:shadow-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {autoOff ? (
                <svg viewBox="0 0 12 12" fill="currentColor" className="h-2.5 w-2.5 text-ink" aria-hidden>
                  <path d="M3 1.8v8.4a.6.6 0 0 0 .92.5l6.1-4.2a.6.6 0 0 0 0-1L3.92 1.3A.6.6 0 0 0 3 1.8Z" />
                </svg>
              ) : (
                <svg viewBox="0 0 12 12" fill="currentColor" className="h-2.5 w-2.5 text-ink" aria-hidden>
                  <rect x="2" y="1.5" width="3" height="9" rx="1" />
                  <rect x="7" y="1.5" width="3" height="9" rx="1" />
                </svg>
              )}
              <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-soft">
                {autoOff ? "Paused" : "Auto"}
              </span>
            </button>
          </div>
        ) : null}

        {/* mode-tinted wash — the whole section takes the active accent */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 transition-[background] duration-1000"
          style={{
            background: `radial-gradient(700px 520px at 22% 30%, ${mode.acc}1f, transparent 60%), radial-gradient(700px 520px at 80% 70%, ${mode.acc}12, transparent 60%)`,
          }}
        />

        <div
          ref={stageRef}
          className={cn(s.stage, "grid gap-8 lg:grid-cols-[190px_320px_minmax(0,1fr)] lg:items-center lg:gap-10")}
        >
          {/* -------------------------------------------- mode rail (lg+) */}
          <div className="hidden lg:order-1 lg:block">
            <ul className="flex flex-col gap-1.5">
              {MODES.map((m, i) => {
                const Mini = BUILDERS[m.build];
                return (
                  <li key={m.key}>
                    <button
                      type="button"
                      onClick={() => pick(i)}
                      aria-pressed={i === idx}
                      className={cn(s.mi, i === idx && s.on, "cursor-pointer")}
                    >
                      <span className={s.mini} aria-hidden>
                        <Mini sc={0.3} />
                      </span>
                      <span className={s.nm}>{m.key}</span>
                      <span className={s.dot} aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* ------------------------------------- mode scroller (below lg).
              min-w-0 is load-bearing: a grid item defaults to min-width:auto,
              so this row's w-max list would otherwise stretch the whole column
              past the viewport and push the phone off-screen on phones. */}
          <div className="order-2 min-w-0 lg:hidden">
            <div className="-mx-6 overflow-x-auto px-6 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <ul className="flex w-max items-center gap-2">
                {MODES.map((m, i) => (
                  <li key={m.key}>
                    <button
                      type="button"
                      onClick={() => pick(i)}
                      aria-pressed={i === idx}
                      className={cn(
                        "flex h-11 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors duration-300",
                        i === idx ? "text-ink" : "border-hairline text-faint",
                      )}
                      style={
                        i === idx
                          ? { backgroundColor: m.bg, borderColor: m.br, color: m.acc }
                          : undefined
                      }
                    >
                      <span
                        aria-hidden
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: m.acc, opacity: i === idx ? 1 : 0.35 }}
                      />
                      {m.key}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* --------------------------------------------------- the phone */}
          <div className="order-1 min-w-0 lg:order-2">
            <div className={cn(s.phZone, "h-[500px] sm:h-[560px] lg:h-[640px]")}>
              <div
                className="origin-top scale-[0.78] sm:scale-[0.88] lg:scale-100"
                style={{ willChange: "transform" }}
              >
                <div ref={phRef} className={s.ph}>
                  {Array.from({ length: 12 }, (_, i) => (
                    <div
                      key={i}
                      className={cn(s.pl, s.slice, (i === 0 || i === 11) && s.edge)}
                      style={{ transform: `translateZ(${-14 + i * (28 / 11)}px)` }}
                    />
                  ))}

                  <div className={cn(s.pl, s.pfront)}>
                    <div className={s.bez}>
                      <div className={s.scr}>
                        <div className={s.camLbl}>AI CAMERA</div>

                        <div className={cn(s.vfBox, scanning && s.hot)}>
                          <div className={cn(s.vb, s.vb1)} />
                          <div className={cn(s.vb, s.vb2)} />
                          <div className={cn(s.vb, s.vb3)} />
                          <div className={cn(s.vb, s.vb4)} />
                          <div className={s.objShadow} aria-hidden />
                          <div className={s.objStage}>
                            {/* key remounts the subject so its entrance replays */}
                            <div key={mode.key} className={s.obj} aria-hidden>
                              <Subject sc={1} />
                            </div>
                          </div>
                          <div ref={beamRef} className={s.beam} aria-hidden />
                        </div>

                        <div className={s.scanChip}>
                          <i />
                          <span>{scanning ? `${mode.scan}…` : `${mode.key} captured ✓`}</span>
                        </div>

                        <button
                          type="button"
                          /* Takes over too: the advance clock runs from the
                             last mode change, so a re-scan requested late in
                             a slot used to be cut off mid-sweep by the tour
                             moving on. */
                          onClick={() => {
                            setAutoOff(true);
                            runScan();
                          }}
                          aria-label={`Re-scan the ${mode.key} sample`}
                          className={s.shutter}
                        />
                        <div className={cn(s.flash, flash && s.flashGo)} aria-hidden />
                      </div>
                      <div className={s.island} aria-hidden />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* -------------------------------------------------- result card */}
          <div className={cn(s.rZone, "order-3 flex min-w-0 flex-col gap-3.5")}>
            <div ref={cardRef} className={cn(s.card, "p-5 sm:p-6")}>
              <div className="flex items-center gap-3">
                <span className={s.cIcon} aria-hidden>
                  {mode.icon}
                </span>
                <div className="min-w-0">
                  <h3 className="text-[17px] font-bold leading-tight text-ink sm:text-[17.5px]">
                    {mode.title}
                  </h3>
                  <p className="mt-0.5 text-xs font-semibold text-faint">{mode.sub}</p>
                </div>
              </div>

              <div className={cn(s.chips, "mt-4 flex flex-wrap gap-2")}>
                {mode.chips.map((c, i) => (
                  <span
                    key={`${mode.key}-${c}`}
                    className={cn(s.ch, i === 0 && s.pri)}
                    style={{ animationDelay: `${i * 70}ms` }}
                  >
                    {c}
                  </span>
                ))}
              </div>

              <div className={cn(s.sumBox, "mt-4 rounded-2xl border border-hairline bg-[#f8fafd] px-4 py-3.5")}>
                <p className="text-[9.5px] font-extrabold tracking-[2px] text-faint">SUMMARY</p>
                <p className="mt-1.5 min-h-[42px] text-[13.5px] font-semibold leading-relaxed text-ink-soft">
                  {typed}
                  {!reduce && typed.length < mode.sum.length ? (
                    <span className={s.cur} aria-hidden />
                  ) : null}
                </p>
              </div>

              <div className={cn(s.statRow, "mt-3.5 flex gap-2")}>
                {mode.stats.map(([v, l]) => (
                  <div
                    key={l}
                    className="flex-1 rounded-xl border border-hairline bg-white px-1 py-1.5 text-center"
                  >
                    <b className={cn(s.stVal, "block text-[14.5px] font-extrabold tabular-nums")}>{v}</b>
                    <span className="text-[8.5px] font-extrabold tracking-wider text-faint">{l}</span>
                  </div>
                ))}
              </div>
            </div>

            <p className="text-[13px] font-semibold leading-relaxed text-muted">{mode.cap}</p>
          </div>
        </div>

        <p className="mt-10 text-center text-[13px] text-faint">
          Six of the 16 AI camera modes, shown as they appear in the app.
        </p>
      </div>
    </Section>
  );
}
