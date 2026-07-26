"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";
import { EASE } from "@/lib/motion";
import { Section, SectionHeading } from "@/components/ui/section";
import { Reveal } from "@/components/ui/reveal";
import { PhoneFrame } from "@/components/ui/phone";
import { DemoScene, SCREEN_BG, type SceneKey } from "@/components/ui/demo-scenes";

/**
 * LiveDemo — the AR camera playground. Choose a sample category (or drop in
 * your own photo), press SCAN & REPORT, and the viewfinder sweeps the subject
 * while a structured Analysis Report resolves on the right.
 *
 * Deliberately monochrome: white surfaces, grey hairlines, black active pill —
 * the report itself is the color. Deterministic fake-async, keyboard
 * accessible, reduced-motion safe.
 */

type Phase = "idle" | "scanning" | "processing" | "done";
type SampleKey =
  | "medical"
  | "coins"
  | "rock"
  | "plants"
  | "essay"
  | "maths"
  | "calories"
  | "barcode"
  | "receipt"
  | "stamps"
  | "upload";

type ReportRow = { label: string; value: string; pct?: number };

type DemoResult = {
  badge: string;
  heading: string;
  confidence: number;
  ms: number;
  rows: ReportRow[];
  note: string;
  /** AR overlay card shown inside the viewfinder once the scan lands */
  overlay: { title: string; sub: string };
};

/* Per-sample accent — "r g b" triplets. Tints the gauge, report bars, badge
   dot and the in-phone camera chrome so every category reads as its own
   little world instead of uniform ink. */
const ACCENTS: Record<SampleKey, string> = {
  medical: "224 82 82", //   rose red
  coins: "203 138 42", //    gold
  rock: "139 92 216", //     violet
  plants: "52 158 90", //    leaf green
  essay: "100 116 180", //   slate blue
  maths: "76 125 255", //    royal blue
  calories: "234 124 46", // warm orange
  barcode: "36 148 138", //  teal
  receipt: "96 118 158", //  steel blue
  stamps: "178 96 58", //    brick
  upload: "124 92 240", //   violet accent
};

const SAMPLES: { key: Exclude<SampleKey, "upload">; label: string }[] = [
  { key: "calories", label: "Calories" },
  { key: "maths", label: "Maths" },
  { key: "essay", label: "Essay" },
  { key: "medical", label: "Medical" },
  { key: "coins", label: "Coins" },
  { key: "rock", label: "Rock" },
  { key: "plants", label: "Plants" },
  { key: "barcode", label: "Barcode" },
  { key: "receipt", label: "Receipt" },
  { key: "stamps", label: "Stamps" },
];

/* -------------------------------------------------------------- autoplay */

/** The demo drives itself through every sample. "upload" is deliberately not
    in the rotation — it needs a real file and runs a real model. */
const AUTO_KEYS = SAMPLES.map((s) => s.key);
type AutoKey = (typeof AUTO_KEYS)[number];

/** How long a finished report rests before the next sample. Scan → report is
    ~1.2 s, so a slot is ~4 s: long enough to read the heading and watch the
    bars fill, short enough that the section never feels stalled. */
const DWELL_MS = 2800;
/** A beat before the first auto-scan so arriving mid-scroll isn't jarring. */
const START_DELAY_MS = 600;

const RESULTS: Record<SampleKey, DemoResult> = {
  medical: {
    badge: "Visual analysis · Skin",
    heading: "Mild contact dermatitis",
    confidence: 87,
    ms: 150,
    rows: [
      { label: "Pattern", value: "Localized erythema", pct: 62 },
      { label: "Region", value: "Forearm · 2.1 cm", pct: 34 },
      { label: "Guidance", value: "Non-urgent · monitor 48 h", pct: 22 },
    ],
    note: "Not a diagnosis. Always consult a healthcare professional.",
    overlay: { title: "Dermatitis · mild", sub: "87% · forearm" },
  },
  coins: {
    badge: "Numismatics · India",
    heading: "1947 One Rupee · King George VI",
    confidence: 96,
    ms: 140,
    rows: [
      { label: "Mint match", value: "Bombay", pct: 88 },
      { label: "Rarity", value: "Independence year", pct: 74 },
      { label: "Est. value", value: "$18–24", pct: 58 },
    ],
    note: "Struck in the year of Indian independence — the last rupee of an empire.",
    overlay: { title: "1947 One Rupee", sub: "Rare · $18–24" },
  },
  rock: {
    badge: "Geology · Mineral",
    heading: "Amethyst — quartz variety",
    confidence: 94,
    ms: 155,
    rows: [
      { label: "Hardness", value: "7 Mohs", pct: 70 },
      { label: "Clarity", value: "Volcanic geode", pct: 55 },
      { label: "Origin match", value: "Brazil · Uruguay", pct: 80 },
    ],
    note: "Color comes from iron impurities irradiated within the crystal lattice.",
    overlay: { title: "Amethyst", sub: "Quartz · 7 Mohs" },
  },
  plants: {
    badge: "Botany · Houseplant",
    heading: "Monstera deliciosa",
    confidence: 97,
    ms: 135,
    rows: [
      { label: "Hydration", value: "Water every 7–10 days", pct: 68 },
      { label: "Light", value: "Bright, indirect", pct: 82 },
      { label: "Health", value: "Thriving", pct: 92 },
    ],
    note: "Wipe the leaves monthly so the plant can breathe.",
    overlay: { title: "Monstera deliciosa", sub: "Thriving · 92%" },
  },
  essay: {
    badge: "OCR · Document",
    heading: "Essay scanned — 412 words",
    confidence: 99,
    ms: 125,
    rows: [
      { label: "Language", value: "English", pct: 99 },
      { label: "Reading level", value: "Grade 11", pct: 72 },
      { label: "Clarity", value: "Well structured", pct: 87 },
    ],
    note: "Rewrite, summarize, translate or read aloud from the report.",
    overlay: { title: "412 words read", sub: "OCR · English" },
  },
  maths: {
    badge: "Solver · Algebra",
    heading: "x² − 5x + 6 = 0 → x = 2 or 3",
    confidence: 100,
    ms: 120,
    rows: [
      { label: "Step 1", value: "(x − 2)(x − 3) = 0" },
      { label: "Step 2", value: "x − 2 = 0 or x − 3 = 0" },
      { label: "Step 3", value: "x = 2 or x = 3" },
    ],
    note: "The curve crosses zero at x = 2 and x = 3.",
    overlay: { title: "Solved · 3 steps", sub: "x = 2 or x = 3" },
  },
  calories: {
    badge: "Nutrition · Meal",
    heading: "Veggie poke bowl — 486 kcal",
    confidence: 93,
    ms: 145,
    rows: [
      { label: "Protein", value: "18 g", pct: 15 },
      { label: "Carbs", value: "62 g", pct: 51 },
      { label: "Fat", value: "17 g", pct: 34 },
    ],
    note: "Estimated from portion size — log it to your day with one tap.",
    overlay: { title: "486 kcal", sub: "Veggie bowl · 93%" },
  },
  barcode: {
    badge: "Barcode · EAN-13",
    heading: "Almond butter · 350 g",
    confidence: 99,
    ms: 110,
    rows: [
      { label: "Brand match", value: "Nutty & Co.", pct: 96 },
      { label: "Best price", value: "$6.49 · 2 stores nearby", pct: 38 },
      { label: "Rating", value: "4.6 ★ · 1.2k reviews", pct: 92 },
    ],
    note: "Prices compared across nearby stores in real time.",
    overlay: { title: "$6.49 · best price", sub: "EAN scanned · 99%" },
  },
  receipt: {
    badge: "Receipt · Expense",
    heading: "Grocery run — $42.80",
    confidence: 98,
    ms: 130,
    rows: [
      { label: "Items", value: "14 read", pct: 47 },
      { label: "Groceries", value: "68% of total", pct: 68 },
      { label: "Logged", value: "Added to July expenses", pct: 100 },
    ],
    note: "Split it, export it or claim it — the numbers are already digital.",
    overlay: { title: "$42.80 logged", sub: "14 items · groceries" },
  },
  stamps: {
    badge: "Philately · Stamp",
    heading: "1854 Penny Red · Great Britain",
    confidence: 91,
    ms: 160,
    rows: [
      { label: "Series match", value: "Queen Victoria", pct: 91 },
      { label: "Condition", value: "Fine used", pct: 64 },
      { label: "Est. value", value: "$45–70", pct: 52 },
    ],
    note: "Plate 77 would make it priceless — this one reads as plate 92.",
    overlay: { title: "Penny Red · 1854", sub: "$45–70" },
  },
  upload: {
    badge: "Your image · Auto-detect",
    heading: "2 objects · text detected",
    confidence: 94,
    ms: 170,
    rows: [
      { label: "Objects", value: "Produce · signage", pct: 80 },
      { label: "Text", value: "“Fresh oranges — 3 for $2”", pct: 66 },
      { label: "Translated", value: "Naranjas frescas — 3 por $2", pct: 90 },
    ],
    note: "Auto-detected the subject and language from your photo.",
    overlay: { title: "2 objects found", sub: "Text · Spanish" },
  },
};

const STATUS_LINES = ["Reading pixels…", "Detecting subject…", "Composing report…"];

/* ------------------------------------------------------------------ scenes */

/** Dimensional viewfinder subjects — see demo-scenes.tsx. Uploads show the photo. */
function Scene({ sample, uploadUrl }: { sample: SampleKey; uploadUrl: string | null }) {
  if (sample === "upload" && uploadUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={uploadUrl}
        alt="Your uploaded image, shown in the camera viewfinder"
        className="absolute inset-0 h-full w-full object-cover"
      />
    );
  }
  if (sample === "upload") return null;
  return <DemoScene sample={sample as SceneKey} />;
}

/* --------------------------------------------------- real on-device AI */

/**
 * Uploads run a REAL image classifier in the visitor's browser —
 * transformers.js + a quantized MobileNetV2, lazy-loaded from CDN only when
 * first used (~4 MB once, then cached). Nothing leaves the device. If the
 * model can't load (offline, blocked CDN), the demo falls back to the
 * simulated upload report so the flow never dead-ends.
 */
type Classifier = (img: string, opts: { top_k: number }) => Promise<{ label: string; score: number }[]>;
let classifierPromise: Promise<Classifier> | null = null;

function loadClassifier(): Promise<Classifier> {
  if (!classifierPromise) {
    classifierPromise = (async () => {
      // runtime import from CDN — kept out of the build graph on purpose
      const dynamicImport = new Function("u", "return import(u)") as (u: string) => Promise<{
        pipeline: (task: string, model: string, opts?: object) => Promise<Classifier>;
      }>;
      const { pipeline } = await dynamicImport(
        "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.0",
      );
      /* NOTE: Xenova/mobilenet_v2_1.0_224 is gated (401) — this repo is public */
      return pipeline(
        "image-classification",
        "onnx-community/mobilenetv4_conv_small.e2400_r224_in1k",
      );
    })().catch((err) => {
      classifierPromise = null; // allow a retry on the next upload
      throw err;
    });
  }
  return classifierPromise;
}

/** "tabby, tabby cat" → "Tabby" */
function cleanLabel(raw: string): string {
  const first = raw.split(",")[0].trim();
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/* ------------------------------------------------------------------ report parts */

/** Counts up on mount; remounted per sample via `key`. */
function AnimatedNumber({
  to,
  suffix = "",
  reduce,
  className,
}: {
  to: number;
  suffix?: string;
  reduce: boolean;
  className?: string;
}) {
  const [v, setV] = useState(reduce ? to : 0);
  useEffect(() => {
    if (reduce) {
      setV(to);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / 900, 1);
      setV(Math.round(to * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, reduce]);
  return (
    <span className={className}>
      {v}
      {suffix}
    </span>
  );
}

/** Ring gauge sweeping to the confidence value, tinted per sample. */
function Gauge({ value, reduce, accent }: { value: number; reduce: boolean; accent: string }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-16 w-16 shrink-0">
      <svg viewBox="0 0 64 64" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="32" cy="32" r={r} fill="none" stroke={`rgb(${accent} / 0.14)`} strokeWidth="4" />
        <motion.circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke={`rgb(${accent})`}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: reduce ? c * (1 - value / 100) : c }}
          animate={{ strokeDashoffset: c * (1 - value / 100) }}
          transition={{ duration: 1, ease: EASE }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <AnimatedNumber to={value} suffix="%" reduce={reduce} className="text-[13px] font-semibold text-ink" />
      </div>
    </div>
  );
}

/** The empty report template — structure visible before any scan runs. */
function ReportTemplate() {
  const line = "rounded-full bg-ink/[0.05]";
  return (
    <div className="rounded-panel border border-hairline bg-surface p-6 shadow-soft" aria-hidden>
      <div className="flex items-center justify-between border-b border-dashed border-hairline pb-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
            Analysis report
          </p>
          <div className={cn(line, "mt-2.5 h-3.5 w-44")} />
        </div>
        <div className="grid h-16 w-16 place-items-center rounded-full border-4 border-ink/[0.06]">
          <span className="text-[13px] font-semibold text-ink/25">--%</span>
        </div>
      </div>
      <div className="mt-4 space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center justify-between gap-6">
            <div className={cn(line, "h-2.5 w-20")} />
            <div className={cn(line, "h-2.5 min-w-0 flex-1 max-w-40")} />
          </div>
        ))}
      </div>
      <div className="mt-5 flex items-center justify-between border-t border-dashed border-hairline pt-4">
        <span className="text-[10px] uppercase tracking-[0.16em] text-ink/25">Inference — ms</span>
        <span className="text-[10px] uppercase tracking-[0.16em] text-ink/25">Awaiting scan</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ section */

export default function LiveDemo() {
  const reduce = useReducedMotion() ?? false;
  /* Start resolved on Medical so the report is populated on first paint — never
     the blank "Awaiting scan" template. Each tab press re-scans and charges the
     report for that sample. */
  const [phase, setPhase] = useState<Phase>("done");
  const [sample, setSample] = useState<SampleKey>("calories");
  const [statusIndex, setStatusIndex] = useState(0);
  const [uploadUrl, setUploadUrl] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<DemoResult | null>(null);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /* Autoplay: on by default, off the moment the visitor takes control. Gated
     on the section being on screen, the tab being focused, and nobody
     hovering or tabbing through — a demo shouldn't run to an empty room. */
  const [autoplay, setAutoplay] = useState(true);
  const [inView, setInView] = useState(false);
  const [docVisible, setDocVisible] = useState(true);
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  /* Only user-initiated scans are announced. Autoplay firing into an
     aria-live region would read a fresh report at a screen reader every four
     seconds, forever. */
  const [userRun, setUserRun] = useState(false);
  const dragDepth = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const autoBtnRef = useRef<HTMLButtonElement>(null);
  const timers = useRef<number[]>([]);
  /* stale-async guard: only the latest scan may publish results */
  const runId = useRef(0);
  /* ref mirror so the async AI flow always sees the freshest upload */
  const uploadUrlRef = useRef<string | null>(null);
  /* Always-current sample for the scan button — immune to the stale-closure
     race when a category is selected and scanned in quick succession. */
  const sampleRef = useRef<SampleKey>("calories");
  sampleRef.current = sample;

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  useEffect(() => clearTimers, []);

  const schedule = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  /** Any deliberate interaction hands control to the visitor: the rotation
      stops so it can't pull the report they're reading out from under them.
      The Auto control puts it back. */
  const takeOver = () => setAutoplay(false);

  /** Selecting a category runs the scan immediately — the analytics should
      appear on click, with the shutter button kept for replays. */
  const select = (key: SampleKey) => {
    takeOver();
    run(key);
  };

  /** Deterministic fake-async flow — snappy: the report lands in ~1.2 s.
      (The earlier 2.8 s pacing read as "the report isn't loading" — a product
      claiming sub-200 ms answers shouldn't make people wait three seconds.)
      `byUser` false means autoplay drove it: no screen-reader announcement. */
  const run = (key: SampleKey, byUser = true) => {
    clearTimers();
    runId.current++;
    setSample(key);
    setUserRun(byUser);
    setStatusIndex(0);
    setAiStatus(null);
    if (key === "upload") {
      runRealAi();
      return;
    }
    if (reduce) {
      setPhase("done");
      return;
    }
    setPhase("scanning");
    schedule(() => setPhase("processing"), 650);
    schedule(() => setStatusIndex(1), 850);
    schedule(() => setStatusIndex(2), 1050);
    schedule(() => setPhase("done"), 1200);
  };

  /** Uploads: classify for real, in-browser. Falls back to the simulated
      report if the on-device model can't load. */
  const runRealAi = () => {
    const id = ++runId.current;
    const url = uploadUrlRef.current;
    if (!url) return;
    setPhase("scanning");
    setAiStatus("Loading on-device model — first run only…");
    (async () => {
      try {
        const classifier = await loadClassifier();
        if (runId.current !== id) return;
        setPhase("processing");
        setAiStatus("Analyzing your photo on this device…");
        const t0 = performance.now();
        const preds = await classifier(url, { top_k: 3 });
        const ms = Math.max(1, Math.round(performance.now() - t0));
        if (runId.current !== id || !preds?.length) throw new Error("no predictions");
        const top = preds[0];
        const conf = Math.round(top.score * 100);
        setAiResult({
          badge: "Your image · On-device AI",
          heading: cleanLabel(top.label),
          confidence: conf,
          ms,
          rows: preds.map((p, i) => ({
            label: i === 0 ? "Best match" : `Alternative ${i}`,
            value: `${cleanLabel(p.label)} · ${(p.score * 100).toFixed(1)}%`,
            pct: Math.max(2, Math.round(p.score * 100)), // real scores drive the bars
          })),
          note: "Classified by a real neural network running in your browser — your photo never left this device.",
          overlay: { title: cleanLabel(top.label), sub: `${conf}% · on-device` },
        });
        setPhase("done");
      } catch {
        if (runId.current !== id) return;
        /* model unavailable (offline / blocked CDN) — simulated fallback */
        setAiResult(null);
        setAiStatus(null);
        setPhase("processing");
        schedule(() => setPhase("done"), 900);
      }
    })();
  };

  /* Ref mirror so the autoplay effect always calls the freshest `run` without
     taking it as a dependency (which would re-arm the timer every render). */
  const runRef = useRef(run);
  runRef.current = run;

  /* Only count as "on screen" once a real slice of the panel is showing. */
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    /* rootMargin rather than a ratio: IO ratios are a fraction of the TARGET,
       and this panel is ~1200px tall stacked, so 0.25 needs ~300px on screen —
       unreachable on a landscape phone. Insetting the root instead asks "does
       the panel overlap the middle of the viewport", which holds at any
       panel height. */
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), {
      rootMargin: "-10% 0px -10% 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const onVis = () => setDocVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  /* useReducedMotion resolves after the first render, so this can't be a
     useState initial value — it would latch `true` before the preference is
     known and leave the rotation running for the people who opted out.
     Keyed on `reduce` only, so a deliberate press of Play still wins. */
  useEffect(() => {
    if (reduce) setAutoplay(false);
  }, [reduce]);

  const held = hovering || focused;
  const running = autoplay && inView && docVisible && !held;

  /* The rotation itself. Idle → kick off the first scan; done → rest, then
     advance. Every arm is a single timeout owned by this effect, so pausing
     (or unmounting) cancels it through the normal cleanup path rather than
     through the shared `timers` list that `run` clears. */
  useEffect(() => {
    if (!running) return;
    if (phase === "idle") {
      const t = window.setTimeout(() => runRef.current(sampleRef.current, false), START_DELAY_MS);
      return () => window.clearTimeout(t);
    }
    if (phase === "done") {
      const t = window.setTimeout(() => {
        const i = AUTO_KEYS.indexOf(sampleRef.current as AutoKey);
        /* -1 when the visitor left it on "upload" — wrapping to 0 restarts
           the tour at the top rather than dead-ending. */
        runRef.current(AUTO_KEYS[(i + 1) % AUTO_KEYS.length], false);
      }, DWELL_MS);
      return () => window.clearTimeout(t);
    }
  }, [running, phase, sample]);

  const readFile = (file: File) => {
    takeOver(); // their own photo outranks the tour
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        uploadUrlRef.current = reader.result;
        setUploadUrl(reader.result);
      }
      run("upload");
    };
    reader.readAsDataURL(file);
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    readFile(file);
    e.target.value = "";
  };

  const result = sample === "upload" && aiResult ? aiResult : RESULTS[sample];
  const accent = ACCENTS[sample];
  const sampleLabel =
    sample === "upload" ? "Your photo" : SAMPLES.find((s) => s.key === sample)?.label ?? "";
  const scanning = phase === "scanning";
  const busy = scanning || phase === "processing";

  return (
    <Section id="demo" tone="canvas">
      <div className="shell">
        <SectionHeading
          eyebrow="Try it"
          title={
            <>
              Focus the camera on <span className="text-gradient">anything.</span>
            </>
          }
          description="The AR camera works through every sample on its own — colors, graphs and a full report, live. Pick any chip to take over."
        />

        <Reveal className="mx-auto max-w-4xl">
          <div
            ref={panelRef}
            className="noise relative overflow-hidden rounded-hero border border-hairline bg-canvas p-6 shadow-soft md:p-10"
            /* Mouse-only hover pause. Touch fires a synthetic pointerenter
               with no matching leave until you tap something else, so on a
               phone one stray tap on the panel would latch the rotation off
               for good while the control still claimed "Auto". */
            onPointerEnter={(e) => {
              if (e.pointerType === "mouse") setHovering(true);
            }}
            onPointerLeave={(e) => {
              if (e.pointerType === "mouse") setHovering(false);
            }}
            /* onFocus/onBlur bubble in React, so these give focus-within
               semantics: tabbing into the chips holds the rotation. The Auto
               control is exempt — it lives inside this panel, so letting its
               own focus count as a hold left Play unable to start anything:
               the label flipped to "Auto" and nothing moved. */
            onFocus={(e) => {
              if (!autoBtnRef.current?.contains(e.target as Node)) setFocused(true);
            }}
            onBlur={() => setFocused(false)}
            onDragEnter={(e) => {
              e.preventDefault();
              if (e.dataTransfer.types.includes("Files")) {
                dragDepth.current += 1;
                setDragging(true);
              }
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={() => {
              dragDepth.current = Math.max(0, dragDepth.current - 1);
              if (dragDepth.current === 0) setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              dragDepth.current = 0;
              setDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file && file.type.startsWith("image/")) readFile(file);
            }}
          >
            {dragging ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2, ease: EASE }}
                className="pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-panel border-2 border-dashed border-ink/30 bg-ink/[0.03] backdrop-blur-[2px]"
              >
                <p className="rounded-full bg-surface px-4 py-2 text-sm font-medium text-ink shadow-soft">
                  Drop your photo to analyze
                </p>
              </motion.div>
            ) : null}

            <div className="relative grid items-start gap-10 md:grid-cols-[300px_1fr] md:gap-12">
              {/* ------------------------------------------ AR device simulator */}
              <div className="flex justify-center">
                <PhoneFrame width={272}>
                  <div
                    className={cn(
                      "relative h-full w-full overflow-hidden transition-colors duration-500",
                      SCREEN_BG[sample],
                    )}
                  >
                    {/* scene */}
                    <div className="absolute inset-0 flex items-center justify-center p-6 pb-20">
                      <Scene sample={sample} uploadUrl={uploadUrl} />
                    </div>

                    {/* camera-app chrome: active mode name up top… */}
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={`label-${sample}`}
                        initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.3, ease: EASE }}
                        className="pointer-events-none absolute inset-x-0 top-9 z-10 text-center"
                      >
                        <span
                          className="rounded-full px-3 py-1 text-[9px] font-bold uppercase tracking-[0.24em]"
                          style={{
                            color: `rgb(${accent})`,
                            backgroundColor: `rgb(${accent} / 0.1)`,
                          }}
                        >
                          {sampleLabel} · AR lens
                        </span>
                      </motion.div>
                    </AnimatePresence>

                    {/* …and the live status line under it while working */}
                    <AnimatePresence>
                      {busy ? (
                        <motion.p
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          className="pointer-events-none absolute inset-x-0 top-[68px] z-10 text-center text-[9px] font-medium uppercase tracking-[0.2em] text-ink/45"
                        >
                          {scanning ? "Focusing…" : "Analyzing…"}
                        </motion.p>
                      ) : null}
                    </AnimatePresence>

                    {/* shutter flash — one white blink the instant a scan starts */}
                    {scanning && !reduce ? (
                      <motion.div
                        aria-hidden
                        className="pointer-events-none absolute inset-0 z-30 bg-white"
                        initial={{ opacity: 0.8 }}
                        animate={{ opacity: 0 }}
                        transition={{ duration: 0.4, ease: "easeOut" }}
                      />
                    ) : null}

                    {/* autofocus reticle — snaps in on every subject change, pulses while scanning */}
                    <motion.div
                      key={`reticle-${sample}-${phase === "scanning"}`}
                      aria-hidden
                      className="pointer-events-none absolute left-1/2 top-[42%] z-10 h-16 w-16 -translate-x-1/2 -translate-y-1/2"
                      initial={reduce ? { opacity: 0.5 } : { opacity: 0, scale: 1.5 }}
                      animate={
                        scanning && !reduce
                          ? { opacity: [0.9, 0.4, 0.9], scale: [1, 0.94, 1] }
                          : { opacity: 0.55, scale: 1 }
                      }
                      transition={
                        scanning && !reduce
                          ? { duration: 0.7, repeat: Infinity, ease: "easeInOut" }
                          : { duration: 0.35, ease: EASE }
                      }
                    >
                      {(
                        [
                          "left-0 top-0 border-l-2 border-t-2",
                          "right-0 top-0 border-r-2 border-t-2",
                          "bottom-0 left-0 border-b-2 border-l-2",
                          "bottom-0 right-0 border-b-2 border-r-2",
                        ] as const
                      ).map((pos) => (
                        <span
                          key={pos}
                          className={cn("absolute h-3.5 w-3.5", pos)}
                          style={{ borderColor: `rgb(${accent})` }}
                        />
                      ))}
                      <span
                        className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full"
                        style={{ backgroundColor: `rgb(${accent})` }}
                      />
                    </motion.div>

                    {/* AR tracking corners */}
                    <motion.div
                      aria-hidden
                      className="pointer-events-none absolute inset-x-7 top-7 bottom-24 z-10"
                      animate={
                        scanning && !reduce
                          ? { opacity: [0.45, 1, 0.45], scale: [1, 1.015, 1] }
                          : { opacity: 1, scale: 1 }
                      }
                      transition={
                        scanning && !reduce
                          ? { duration: 1.1, repeat: Infinity, ease: "easeInOut" }
                          : { duration: 0.3 }
                      }
                    >
                      {(
                        [
                          "left-0 top-0 rounded-tl-lg border-l-2 border-t-2",
                          "right-0 top-0 rounded-tr-lg border-r-2 border-t-2",
                          "bottom-0 left-0 rounded-bl-lg border-b-2 border-l-2",
                          "bottom-0 right-0 rounded-br-lg border-b-2 border-r-2",
                        ] as const
                      ).map((pos) => (
                        <div
                          key={pos}
                          className={cn(
                            "absolute h-6 w-6 transition-colors duration-300",
                            pos,
                            busy ? "border-ink" : "border-ink/25",
                          )}
                        />
                      ))}
                    </motion.div>

                    {/* scan beam */}
                    {scanning && !reduce ? (
                      <motion.div
                        aria-hidden
                        className="pointer-events-none absolute inset-x-0 z-10 h-28"
                        initial={{ top: "-20%" }}
                        animate={{ top: "105%" }}
                        transition={{ duration: 0.65, ease: "easeInOut" }}
                        style={{
                          background:
                            "linear-gradient(to bottom, transparent, rgb(11 12 14 / 0.08), transparent)",
                        }}
                      >
                        <div className="absolute inset-x-4 top-1/2 h-px bg-ink/50" />
                      </motion.div>
                    ) : null}

                    {/* AR overlay card — resolves in the viewfinder after a scan */}
                    <AnimatePresence>
                      {phase === "done" ? (
                        <motion.div
                          key={`overlay-${sample}`}
                          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.95 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.45, ease: EASE }}
                          className="glass absolute left-1/2 top-[54%] z-20 -translate-x-1/2 rounded-2xl px-4 py-2.5 text-center"
                        >
                          <p className="whitespace-nowrap text-[12px] font-semibold text-ink">
                            {result.overlay.title}
                          </p>
                          <p className="whitespace-nowrap text-[10px] text-faint">{result.overlay.sub}</p>
                        </motion.div>
                      ) : null}
                    </AnimatePresence>

                    {/* camera-app mode strip */}
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 bottom-[86px] z-10 flex justify-center gap-4 text-[9px] font-bold uppercase tracking-[0.18em]"
                    >
                      <span className="text-ink/30">Translate</span>
                      <span style={{ color: `rgb(${accent})` }}>Scan</span>
                      <span className="text-ink/30">AR</span>
                    </div>

                    {/* real camera shutter — ring + core, tap to (re)scan */}
                    <div className="absolute inset-x-0 bottom-4 z-10 flex flex-col items-center gap-1">
                      <motion.button
                        type="button"
                        aria-label={busy ? "Scanning" : "Scan and report"}
                        onClick={() => {
                          takeOver();
                          run(sampleRef.current);
                        }}
                        disabled={busy}
                        whileTap={reduce ? undefined : { scale: 0.88 }}
                        transition={{ type: "spring", stiffness: 400, damping: 22 }}
                        className="grid h-14 w-14 cursor-pointer place-items-center rounded-full border-4 border-white shadow-lift backdrop-blur-sm disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent"
                        style={{ backgroundColor: "rgb(255 255 255 / 0.35)" }}
                      >
                        <motion.span
                          className="h-10 w-10 rounded-full"
                          animate={
                            busy && !reduce
                              ? { scale: [1, 0.82, 1], backgroundColor: `rgb(${accent})` }
                              : { scale: 1, backgroundColor: "#ffffff" }
                          }
                          transition={
                            busy && !reduce
                              ? { duration: 0.9, repeat: Infinity, ease: "easeInOut" }
                              : { duration: 0.25 }
                          }
                        />
                      </motion.button>
                    </div>
                  </div>
                </PhoneFrame>
              </div>

              {/* --------------------------------------------- controls + report */}
              <div className="flex min-w-0 flex-col">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-faint">
                    Choose a sample to scan
                  </p>
                  {/* AR-active badge */}
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-2.5 py-1" aria-label="AR camera active">
                    <span className="relative flex h-1.5 w-1.5" aria-hidden>
                      <span className={cn("absolute inset-0 rounded-full bg-ink", !reduce && "animate-pulse-ring")} />
                      <span className="relative h-1.5 w-1.5 rounded-full bg-ink" />
                    </span>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 text-ink" aria-hidden>
                      <path d="M3.5 8.7a1.2 1.2 0 0 1 1.2-1.2h2.6l1.5-2h6.4l1.5 2h2.6a1.2 1.2 0 0 1 1.2 1.2v8.6a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2V8.7Z" />
                      <circle cx="12" cy="12.8" r="3.2" />
                    </svg>
                    <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-soft">AR</span>
                  </span>

                  {/* Auto-rotation control. Auto-updating content has to be
                      stoppable (WCAG 2.2.2), and it doubles as the tell that
                      the demo is running itself. */}
                  <button
                    ref={autoBtnRef}
                    type="button"
                    onClick={() => {
                      setAutoplay((v) => !v);
                      /* Clear both holds. A real click parks focus here and
                         leaves the pointer resting on the control; either one
                         would otherwise keep the rotation pinned at "paused"
                         immediately after the visitor asked it to play. */
                      setHovering(false);
                      setFocused(false);
                    }}
                    /* Accessible name leads with the visible word so speech
                       input ("click Auto") matches — WCAG 2.5.3 Label in Name. */
                    aria-label={
                      autoplay ? "Auto: pause the demo" : "Paused: play the demo"
                    }
                    /* before: pseudo-element widens the tap target to ~45px
                       without inflating the pill — the badge next to it sets
                       the visual scale, but a 25px-tall control is too small
                       to hit on a phone. */
                    className="relative ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-hairline bg-surface px-2.5 py-1 transition-all duration-200 before:absolute before:-inset-x-1 before:-inset-y-2.5 before:content-[''] hover:border-[#dcdcdc] hover:shadow-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {autoplay ? (
                      <svg viewBox="0 0 12 12" fill="currentColor" className="h-2.5 w-2.5 text-ink" aria-hidden>
                        <rect x="2" y="1.5" width="3" height="9" rx="1" />
                        <rect x="7" y="1.5" width="3" height="9" rx="1" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 12 12" fill="currentColor" className="h-2.5 w-2.5 text-ink" aria-hidden>
                        <path d="M3 1.8v8.4a.6.6 0 0 0 .92.5l6.1-4.2a.6.6 0 0 0 0-1L3.92 1.3A.6.6 0 0 0 3 1.8Z" />
                      </svg>
                    )}
                    <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-soft">
                      {autoplay ? "Auto" : "Paused"}
                    </span>
                  </button>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {SAMPLES.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      aria-pressed={sample === s.key}
                      onClick={() => select(s.key)}
                      className={cn(
                        "cursor-pointer rounded-full border px-4 py-2 text-sm font-medium transition-all duration-200",
                        sample === s.key
                          ? "text-white shadow-soft"
                          : "border-hairline bg-surface text-ink-soft hover:-translate-y-0.5 hover:border-[#dcdcdc] hover:shadow-soft",
                      )}
                      style={
                        sample === s.key
                          ? {
                              backgroundColor: `rgb(${ACCENTS[s.key]})`,
                              borderColor: `rgb(${ACCENTS[s.key]})`,
                            }
                          : undefined
                      }
                    >
                      {s.label}
                    </button>
                  ))}
                </div>

                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="flex cursor-pointer items-center gap-1.5 rounded-full border border-hairline bg-surface px-4 py-2 text-sm font-medium text-ink-soft transition-all duration-200 hover:-translate-y-0.5 hover:border-[#dcdcdc] hover:shadow-soft"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
                      <path d="M12 15.5V4.75m0 0L8.25 8.5M12 4.75l3.75 3.75" />
                      <path d="M4.75 15.5v2.75A1.5 1.5 0 0 0 6.25 19.75h11.5a1.5 1.5 0 0 0 1.5-1.5V15.5" />
                    </svg>
                    Upload image
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    onChange={onFile}
                    className="sr-only"
                    aria-label="Upload an image to analyze"
                    tabIndex={-1}
                  />
                </div>

                {/* Gated on userRun: autoplay must not narrate a new report
                    into a screen reader every four seconds. */}
                <div aria-live="polite" className="sr-only">
                  {phase === "done" && userRun
                    ? `Report ready: ${result.badge}. ${result.heading}. ${result.confidence} percent confidence.`
                    : null}
                </div>

                {/* ------------------------------------------------ report box */}
                <div className="mt-6 border-t border-hairline pt-6">
                  {/* Reserve the finished report's height. The busy state is
                      much shorter, so with a 280px floor the box collapsed
                      ~110px and sprang back on every pass — a layout shift
                      every 4s for as long as the section is on screen.
                      Measured maxima: 388px from md up, 470px stacked below
                      it (narrower column, more wrapping). */}
                  <div className="min-h-[470px] md:min-h-[390px]">
                    {phase === "idle" ? <ReportTemplate /> : null}

                    {busy ? (
                      <div className="flex min-h-[280px] flex-col items-center justify-center gap-4">
                        <div className="flex items-center gap-1.5" aria-hidden>
                          {[0, 1, 2].map((i) => (
                            <motion.span
                              key={i}
                              className="h-2 w-2 rounded-full bg-ink"
                              animate={reduce ? undefined : { y: [0, -6, 0], opacity: [0.4, 1, 0.4] }}
                              transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.14, ease: "easeInOut" }}
                            />
                          ))}
                        </div>
                        <p className="text-sm text-muted">
                          {aiStatus ?? (scanning ? "Scanning the frame…" : STATUS_LINES[statusIndex])}
                        </p>
                      </div>
                    ) : null}

                    {phase === "done" ? (
                      <motion.div
                        key={`done-${sample}`}
                        initial={reduce ? false : "hidden"}
                        animate="visible"
                        variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.08 } } }}
                        className="rounded-panel border border-hairline bg-surface p-6 shadow-soft"
                      >
                        <motion.div
                          variants={riseVariant}
                          className="flex items-start justify-between gap-4 border-b border-dashed border-hairline pb-4"
                        >
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
                              <span
                                aria-hidden
                                className="h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{ backgroundColor: `rgb(${accent})` }}
                              />
                              Analysis report · {result.badge}
                            </p>
                            <h3 className="mt-1.5 text-xl font-medium leading-snug text-ink">
                              {result.heading}
                            </h3>
                          </div>
                          <Gauge
                            key={`g-${sample}`}
                            value={result.confidence}
                            reduce={reduce}
                            accent={accent}
                          />
                        </motion.div>

                        <ul className="mt-4 divide-y divide-hairline">
                          {result.rows.map((row, ri) => (
                            <motion.li key={row.label} variants={riseVariant} className="py-2.5">
                              <div className="flex items-baseline justify-between gap-4">
                                <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                                  {row.label}
                                </span>
                                <span className="min-w-0 text-right text-sm font-medium text-ink">
                                  {row.value}
                                </span>
                              </div>
                              {row.pct != null ? (
                                <div
                                  className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full"
                                  style={{ backgroundColor: `rgb(${accent} / 0.1)` }}
                                >
                                  <motion.div
                                    className="h-full rounded-full"
                                    style={{ backgroundColor: `rgb(${accent})` }}
                                    initial={reduce ? { width: `${row.pct}%` } : { width: 0 }}
                                    animate={{ width: `${row.pct}%` }}
                                    transition={{
                                      duration: 0.8,
                                      ease: EASE,
                                      delay: reduce ? 0 : 0.15 + ri * 0.1,
                                    }}
                                  />
                                </div>
                              ) : null}
                            </motion.li>
                          ))}
                        </ul>

                        <motion.div
                          variants={riseVariant}
                          className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-dashed border-hairline pt-4"
                        >
                          <span className="text-[10px] uppercase tracking-[0.16em] text-faint">
                            Inference{" "}
                            <AnimatedNumber
                              key={`ms-${sample}`}
                              to={result.ms}
                              suffix=" ms"
                              reduce={reduce}
                              className="font-semibold tabular-nums text-ink"
                            />
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              takeOver();
                              run(sample);
                            }}
                            className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-soft underline-offset-4 hover:underline"
                          >
                            Run again
                          </button>
                        </motion.div>

                        <motion.p variants={riseVariant} className="mt-3 text-xs leading-relaxed text-muted">
                          {result.note}
                        </motion.p>
                      </motion.div>
                    ) : null}
                  </div>

                  <p className="mt-4 text-xs text-faint">
                    Sample scans are simulated for the web — uploaded photos are analyzed by a
                    real on-device model in your browser. In the app, answers average under 200 ms.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

const riseVariant = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
};
