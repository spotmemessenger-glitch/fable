"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";
import { EASE } from "@/lib/motion";
import { Section, SectionHeading } from "@/components/ui/section";
import { Reveal } from "@/components/ui/reveal";
import { PhoneFrame } from "@/components/ui/phone";

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
type SampleKey = "medical" | "coins" | "rock" | "plants" | "essay" | "maths" | "upload";

type ReportRow = { label: string; value: string };

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

const SAMPLES: { key: Exclude<SampleKey, "upload">; label: string }[] = [
  { key: "medical", label: "Medical" },
  { key: "coins", label: "Coins" },
  { key: "rock", label: "Rock" },
  { key: "plants", label: "Plants" },
  { key: "essay", label: "Essay" },
  { key: "maths", label: "Maths" },
];

const RESULTS: Record<SampleKey, DemoResult> = {
  medical: {
    badge: "Visual analysis · Skin",
    heading: "Mild contact dermatitis",
    confidence: 87,
    ms: 150,
    rows: [
      { label: "Pattern", value: "Localized erythema" },
      { label: "Region", value: "Forearm · 2.1 cm" },
      { label: "Guidance", value: "Non-urgent · monitor 48 h" },
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
      { label: "Mint", value: "Bombay" },
      { label: "Composition", value: "Nickel" },
      { label: "Est. value", value: "$18–24" },
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
      { label: "Hardness", value: "7 Mohs" },
      { label: "Formation", value: "Volcanic geode" },
      { label: "Likely origin", value: "Brazil · Uruguay" },
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
      { label: "Water", value: "Every 7–10 days" },
      { label: "Light", value: "Bright, indirect" },
      { label: "Health", value: "Thriving · 92%" },
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
      { label: "Language", value: "English" },
      { label: "Reading level", value: "Grade 11" },
      { label: "Summary", value: "Later school starts improve results" },
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
  upload: {
    badge: "Your image · Auto-detect",
    heading: "2 objects · text detected",
    confidence: 94,
    ms: 170,
    rows: [
      { label: "Objects", value: "Produce · signage" },
      { label: "Text", value: "“Fresh oranges — 3 for $2”" },
      { label: "Translated", value: "Naranjas frescas — 3 por $2" },
    ],
    note: "Auto-detected the subject and language from your photo.",
    overlay: { title: "2 objects found", sub: "Text · Spanish" },
  },
};

const STATUS_LINES = ["Reading pixels…", "Detecting subject…", "Composing report…"];

/* ------------------------------------------------------------------ scenes */

/** Monochrome viewfinder subjects — ink-line sketches on the pale screen. */
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
  const stroke = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  if (sample === "medical") {
    return (
      <svg viewBox="0 0 120 120" {...stroke} className="h-32 w-32 text-ink-soft/60" aria-hidden>
        <path d="M18 92c18-6 40-18 59-34 7-6 13-12 18-19" />
        <path d="M31 108c19-7 38-20 55-36 5-5 10-11 13-17" />
        <ellipse cx="61" cy="80" rx="11" ry="7" transform="rotate(-24 61 80)" strokeDasharray="3 4" className="text-ink" />
        <circle cx="58" cy="79" r="1" className="fill-ink/40" />
        <circle cx="64" cy="82" r="1" className="fill-ink/40" />
      </svg>
    );
  }
  if (sample === "coins") {
    return (
      <div className="flex flex-col items-center gap-2">
        <svg viewBox="0 0 120 120" {...stroke} className="h-32 w-32 text-ink" aria-hidden>
          <circle cx="60" cy="60" r="40" />
          <circle cx="60" cy="60" r="34" className="text-ink/30" />
          <text x="60" y="60" textAnchor="middle" fontSize="22" className="fill-ink" stroke="none" style={{ fontFamily: "Georgia, serif" }}>₹</text>
          <text x="60" y="76" textAnchor="middle" fontSize="8" letterSpacing="2" className="fill-ink/60" stroke="none">1947</text>
        </svg>
      </div>
    );
  }
  if (sample === "rock") {
    return (
      <svg viewBox="0 0 120 120" {...stroke} className="h-32 w-32 text-ink" aria-hidden>
        <path d="M32 78 46 42l20-12 24 16 4 30-22 18-30-6z" />
        <path d="M46 42l16 20-10 32M66 30l-4 32 24 14M62 62l26-8" className="text-ink/45" />
      </svg>
    );
  }
  if (sample === "plants") {
    return (
      <svg viewBox="0 0 120 120" {...stroke} className="h-32 w-32 text-ink" aria-hidden>
        <path d="M60 104V56" />
        <path d="M60 66C42 66 30 54 28 38c16 0 30 8 32 24" />
        <path d="M60 58c18 0 30-12 32-28-16 0-30 8-32 24" />
      </svg>
    );
  }
  if (sample === "essay") {
    return (
      <div className="w-32 rounded-lg border border-hairline bg-white p-3.5 shadow-soft">
        <div className="h-1.5 w-3/5 rounded-full bg-ink/60" />
        <div className="mt-2.5 space-y-1.5">
          <div className="h-1 w-full rounded-full bg-sunken" />
          <div className="h-1 w-11/12 rounded-full bg-sunken" />
          <div className="h-1 w-full rounded-full bg-sunken" />
          <div className="h-1 w-4/5 rounded-full bg-sunken" />
          <div className="h-1 w-full rounded-full bg-sunken" />
          <div className="h-1 w-2/3 rounded-full bg-sunken" />
        </div>
      </div>
    );
  }
  // maths
  return (
    <div className="text-center" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
      <p className="text-lg italic text-ink">x² − 5x + 6 = 0</p>
      <p className="mt-2 text-xs italic text-ink/45">(x − 2)(x − 3) = 0</p>
    </div>
  );
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

/** Ink ring gauge sweeping to the confidence value. */
function Gauge({ value, reduce }: { value: number; reduce: boolean }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-16 w-16 shrink-0">
      <svg viewBox="0 0 64 64" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgb(11 12 14 / 0.08)" strokeWidth="4" />
        <motion.circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke="#0b0c0e"
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
  const [phase, setPhase] = useState<Phase>("idle");
  const [sample, setSample] = useState<SampleKey>("medical");
  const [statusIndex, setStatusIndex] = useState(0);
  const [uploadUrl, setUploadUrl] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const timers = useRef<number[]>([]);
  /* Always-current sample for the scan button — immune to the stale-closure
     race when a category is selected and scanned in quick succession. */
  const sampleRef = useRef<SampleKey>("medical");
  sampleRef.current = sample;

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  useEffect(() => clearTimers, []);

  const schedule = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  /** Selecting a category arms the camera; it does not auto-run the scan. */
  const select = (key: SampleKey) => {
    clearTimers();
    setSample(key);
    setPhase("idle");
  };

  /** Deterministic fake-async flow: scanning 1.6 s → processing 1.2 s → done. */
  const run = (key: SampleKey) => {
    clearTimers();
    setSample(key);
    setStatusIndex(0);
    if (reduce) {
      setPhase("done");
      return;
    }
    setPhase("scanning");
    schedule(() => setPhase("processing"), 1600);
    schedule(() => setStatusIndex(1), 2000);
    schedule(() => setStatusIndex(2), 2400);
    schedule(() => setPhase("done"), 2800);
  };

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setUploadUrl(reader.result);
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

  const result = RESULTS[sample];
  const scanning = phase === "scanning";
  const busy = scanning || phase === "processing";

  return (
    <Section id="demo" tone="surface">
      <div className="shell">
        <SectionHeading
          eyebrow="Try it"
          title={
            <>
              See YSNAP <span className="text-gradient">think.</span>
            </>
          }
          description="Choose what to point the AR camera at, press scan, and read the report it writes back."
        />

        <Reveal className="mx-auto max-w-4xl">
          <div
            className="noise relative overflow-hidden rounded-hero border border-hairline bg-canvas p-6 shadow-soft md:p-10"
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
                  <div className="relative h-full w-full overflow-hidden bg-sunken">
                    {/* scene */}
                    <div className="absolute inset-0 flex items-center justify-center p-6 pb-20">
                      <Scene sample={sample} uploadUrl={uploadUrl} />
                    </div>

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
                        transition={{ duration: 1.5, ease: "easeInOut" }}
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

                    {/* primary action — SCAN & REPORT */}
                    <div className="absolute inset-x-0 bottom-5 z-10 flex justify-center">
                      <motion.button
                        type="button"
                        onClick={() => run(sampleRef.current)}
                        disabled={busy}
                        whileTap={reduce ? undefined : { scale: 0.95 }}
                        transition={{ type: "spring", stiffness: 400, damping: 22 }}
                        className="cursor-pointer rounded-full bg-ink px-6 py-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-white shadow-lift transition-opacity duration-200 hover:opacity-90 disabled:cursor-default disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent"
                      >
                        {busy ? "Scanning…" : "Scan & report"}
                      </motion.button>
                    </div>
                  </div>
                </PhoneFrame>
              </div>

              {/* --------------------------------------------- controls + report */}
              <div className="flex min-w-0 flex-col">
                <div className="flex items-center gap-2.5">
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
                          ? "border-ink bg-ink text-white shadow-soft"
                          : "border-hairline bg-surface text-ink-soft hover:-translate-y-0.5 hover:border-[#dcdcdc] hover:shadow-soft",
                      )}
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

                <div aria-live="polite" className="sr-only">
                  {phase === "done"
                    ? `Report ready: ${result.badge}. ${result.heading}. ${result.confidence} percent confidence.`
                    : null}
                </div>

                {/* ------------------------------------------------ report box */}
                <div className="mt-6 border-t border-hairline pt-6">
                  <div className="min-h-[280px]">
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
                          {scanning ? "Scanning the frame…" : STATUS_LINES[statusIndex]}
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
                            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
                              Analysis report · {result.badge}
                            </p>
                            <h3 className="mt-1.5 text-xl font-medium leading-snug text-ink">
                              {result.heading}
                            </h3>
                          </div>
                          <Gauge key={`g-${sample}`} value={result.confidence} reduce={reduce} />
                        </motion.div>

                        <ul className="mt-4 divide-y divide-hairline">
                          {result.rows.map((row) => (
                            <motion.li
                              key={row.label}
                              variants={riseVariant}
                              className="flex items-baseline justify-between gap-4 py-2.5"
                            >
                              <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                                {row.label}
                              </span>
                              <span className="min-w-0 text-right text-sm font-medium text-ink">
                                {row.value}
                              </span>
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
                            onClick={() => run(sample)}
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
                    Simulated for the web. In the app, answers average under 200 ms.
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
