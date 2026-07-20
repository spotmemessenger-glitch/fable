"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Section, SectionHeading } from "@/components/ui/section";
import { Reveal } from "@/components/ui/reveal";
import { GlobeIcon } from "@/components/ui/icons";

/* ------------------------------------------------------------------ data */

type Sense = {
  name: string;
  blurb: string; // six-word descriptor
  icon: ReactNode;
  /** hue classes for the icon chip — one hue per sense */
  chip: string;
};

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const SENSES: Sense[] = [
  {
    name: "Vision AI",
    blurb: "Reads scenes, text and objects instantly",
    chip: "bg-teal/10 text-teal",
    icon: (
      <svg {...iconProps} className="h-[18px] w-[18px]" aria-hidden>
        <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z" />
        <circle cx="12" cy="12" r="2.75" />
      </svg>
    ),
  },
  {
    name: "Language AI",
    blurb: "Translates 120+ languages with native fluency",
    chip: "bg-accent/10 text-accent",
    icon: <GlobeIcon className="h-[18px] w-[18px]" />,
  },
  {
    name: "Voice AI",
    blurb: "Hears, understands and speaks like you",
    chip: "bg-violet/10 text-violet",
    icon: (
      <svg {...iconProps} className="h-[18px] w-[18px]" aria-hidden>
        <path d="M4 10v4" />
        <path d="M8 7v10" />
        <path d="M12 4v16" />
        <path d="M16 7v10" />
        <path d="M20 10v4" />
      </svg>
    ),
  },
  {
    name: "Cloud AI",
    blurb: "Deep reasoning served under 200 ms",
    chip: "bg-amber/10 text-amber",
    icon: (
      <svg {...iconProps} className="h-[18px] w-[18px]" aria-hidden>
        <path d="M6.5 18a4 4 0 0 1-.55-7.96 6 6 0 0 1 11.7 1.06A3.6 3.6 0 0 1 17.4 18H6.5Z" />
      </svg>
    ),
  },
  {
    name: "On-device AI",
    blurb: "Private, offline and always within reach",
    chip: "bg-green/10 text-green",
    icon: (
      <svg {...iconProps} className="h-[18px] w-[18px]" aria-hidden>
        <rect x="7" y="7" width="10" height="10" rx="2" />
        <path d="M9 3v2.5M15 3v2.5M9 18.5V21M15 18.5V21M3 9h2.5M3 15h2.5M18.5 9H21M18.5 15H21" />
        <rect x="10.5" y="10.5" width="3" height="3" rx="0.75" />
      </svg>
    ),
  },
];

/* --------------------------------------------------- network simulation */

const COLS = [9, 9, 10, 9, 9]; // 46 nodes across 5 loose columns
const POINTER_RADIUS = 150; // px — attraction falloff
const POINTER_PULL = 16; // px — max attraction offset (capped)
/* Polished-gold family mirroring the site-wide MeshBackground gold palette,
   so the section lattice reads as the same metal as the page backdrop. */
const GOLD_DOTS: ReadonlyArray<readonly [number, number, number]> = [
  [212, 175, 90], //  polished gold
  [234, 202, 128], // highlight
  [190, 148, 60], //  deep gold
  [245, 222, 165], // near-specular
  [172, 130, 48], //  antique
];
/** white-gold charge tones the lightning pulses cycle through (rgb triplets) */
const GOLD_PULSES = [
  "255, 214, 120",
  "245, 222, 165",
  "235, 184, 62",
  "255, 236, 190",
] as const;

type SimNode = {
  bx: number; // base position, normalized 0..1
  by: number;
  ax: number; // drift amplitude, px
  ay: number;
  fx: number; // drift frequency
  fy: number;
  px: number; // drift phase
  py: number;
  ox: number; // pointer offset (lerped)
  oy: number;
  r: number;
};

type SimEdge = { a: number; b: number };

type Pulse = { edge: number; t: number; speed: number; dir: 1 | -1; color: string };

/** Deterministic PRNG so the network renders identically every mount. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildNetwork() {
  const rnd = mulberry32(20260719);
  const nodes: SimNode[] = [];
  const starts: number[] = [];
  let acc = 0;

  COLS.forEach((count, col) => {
    starts.push(acc);
    acc += count;
    const cx = 0.1 + col * 0.2;
    for (let i = 0; i < count; i++) {
      const cy = 0.14 + (0.72 * i) / (count - 1);
      nodes.push({
        bx: cx + (rnd() - 0.5) * 0.09,
        by: cy + (rnd() - 0.5) * 0.07,
        ax: 4 + rnd() * 6,
        ay: 5 + rnd() * 7,
        fx: 0.18 + rnd() * 0.3,
        fy: 0.15 + rnd() * 0.28,
        px: rnd() * Math.PI * 2,
        py: rnd() * Math.PI * 2,
        ox: 0,
        oy: 0,
        r: 1.7 + rnd() * 1.5,
      });
    }
  });

  const edges: SimEdge[] = [];
  COLS.forEach((count, col) => {
    if (col === COLS.length - 1) return;
    for (let i = 0; i < count; i++) {
      const a = starts[col] + i;
      const links = rnd() < 0.35 ? 3 : 2;
      const used = new Set<number>();
      for (let k = 0; k < links; k++) {
        const b = starts[col + 1] + Math.floor(rnd() * COLS[col + 1]);
        if (used.has(b)) continue;
        used.add(b);
        edges.push({ a, b });
      }
    }
  });

  return { nodes, edges };
}

/* ------------------------------------------------------- canvas element */

function NeuralCanvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { nodes, edges } = buildNetwork();
    const posX = new Float64Array(nodes.length);
    const posY = new Float64Array(nodes.length);
    const pulses: Pulse[] = [];

    let w = 0;
    let h = 0;
    let raf = 0;
    let running = false;
    let visible = false;
    let last = 0;
    let spawnClock = 0;
    let nextSpawn = 0.7;
    let spawnCount = 0;
    const pointer = { x: 0, y: 0, active: false };

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const computePositions = (t: number, k: number) => {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const nx = n.bx * w + Math.sin(t * n.fx * Math.PI * 2 + n.px) * n.ax;
        const ny = n.by * h + Math.cos(t * n.fy * Math.PI * 2 + n.py) * n.ay;
        let tx = 0;
        let ty = 0;
        if (pointer.active) {
          const dx = pointer.x - nx;
          const dy = pointer.y - ny;
          const d = Math.hypot(dx, dy);
          if (d > 0.001 && d < POINTER_RADIUS) {
            const f = (1 - d / POINTER_RADIUS) * POINTER_PULL;
            tx = (dx / d) * f;
            ty = (dy / d) * f;
          }
        }
        n.ox += (tx - n.ox) * k;
        n.oy += (ty - n.oy) * k;
        posX[i] = nx + n.ox;
        posY[i] = ny + n.oy;
      }
    };

    const drawNetwork = (t = 0) => {
      ctx.clearRect(0, 0, w, h);

      /* wires — each edge rides its own phase between deep antique gold and
         near-specular highlight, so the lattice reads as polished metal
         turning under a moving light rather than flat yellow strokes */
      ctx.lineWidth = 1;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const sh = 0.5 + 0.5 * Math.sin(t * 1.5 + i * 0.9);
        const cr = Math.round(150 + (255 - 150) * sh);
        const cg = Math.round(118 + (228 - 118) * sh);
        const cb = Math.round(40 + (156 - 40) * sh);
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(0.13 + sh * 0.14).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(posX[e.a], posY[e.a]);
        ctx.lineTo(posX[e.b], posY[e.b]);
        ctx.stroke();
      }

      /* dots — tiny metallic radials (near-white specular core falling to deep
         gold at the rim), each twinkling on its own phase */
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const hue = GOLD_DOTS[i % GOLD_DOTS.length];
        const tw = 0.5 + 0.5 * Math.sin(t * (0.6 + n.fx * 2) + n.px * 2.1);
        const rad = n.r * 1.8;
        const g = ctx.createRadialGradient(
          posX[i] - rad * 0.3,
          posY[i] - rad * 0.3,
          0,
          posX[i],
          posY[i],
          rad,
        );
        g.addColorStop(0, `rgba(255,250,235,${(0.5 + tw * 0.35).toFixed(3)})`);
        g.addColorStop(0.45, `rgba(${hue[0]},${hue[1]},${hue[2]},${(0.55 + tw * 0.3).toFixed(3)})`);
        g.addColorStop(1, `rgba(150,112,38,${(0.16 + tw * 0.14).toFixed(3)})`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(posX[i], posY[i], rad, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const pulseDot = (x: number, y: number, radius: number, alpha: number, color: string) => {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius * 3.4);
      glow.addColorStop(0, `rgba(${color}, ${alpha * 0.45})`);
      glow.addColorStop(1, `rgba(${color}, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, radius * 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(${color}, ${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      /* white-hot center so a packet at speed reads as a lightning arc,
         not a coloured bead */
      ctx.fillStyle = `rgba(255,252,240,${(alpha * 0.85).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, radius * 0.45, 0, Math.PI * 2);
      ctx.fill();
    };

    const drawPulses = () => {
      for (const p of pulses) {
        const e = edges[p.edge];
        const from = p.dir === 1 ? e.a : e.b;
        const to = p.dir === 1 ? e.b : e.a;
        // long trailing streak behind the head — at packet speed this is what
        // makes a transmission read as a lightning arc along the wire
        for (let k = 6; k >= 0; k--) {
          const tt = p.t - k * 0.07;
          if (tt < 0 || tt > 1) continue;
          const x = posX[from] + (posX[to] - posX[from]) * tt;
          const y = posY[from] + (posY[to] - posY[from]) * tt;
          if (k === 0) {
            pulseDot(x, y, 3, 0.95, p.color);
          } else {
            pulseDot(x, y, Math.max(0.6, 2.4 - k * 0.26), 0.38 * (1 - k / 8), p.color);
          }
        }
      }
    };

    const staticFrame = () => {
      resize();
      computePositions(0, 1);
      drawNetwork();
      // a few resting golden motes so the reduced frame keeps its story
      [4, 26, 51].forEach((edge, i) => {
        const e = edges[edge % edges.length];
        pulseDot(
          (posX[e.a] + posX[e.b]) / 2,
          (posY[e.a] + posY[e.b]) / 2,
          2.2,
          0.65,
          GOLD_PULSES[i % GOLD_PULSES.length],
        );
      });
    };

    /* ------------------------------ reduced motion: one settled frame */
    if (reduce) {
      staticFrame();
      const ro = new ResizeObserver(staticFrame);
      ro.observe(wrap);
      return () => ro.disconnect();
    }

    /* --------------------------------------------- live rAF pipeline */
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const t = now / 1000;

      spawnClock += dt;
      if (spawnClock >= nextSpawn && pulses.length < 16 && edges.length > 0) {
        spawnClock = 0;
        nextSpawn = 0.14 + Math.random() * 0.12; // ~200ms cadence — heavy traffic
        /* packets this fast live only ~0.3–0.5s, so launch a small burst each
           tick to keep several arcs in flight at once */
        const burst = Math.min(3, 16 - pulses.length);
        for (let b = 0; b < burst; b++) {
          pulses.push({
            edge: Math.floor(Math.random() * edges.length),
            t: 0,
            speed: 2.6 + Math.random() * 1.8, // crosses a wire in ~250–400ms
            dir: Math.random() < 0.78 ? 1 : -1,
            color: GOLD_PULSES[spawnCount++ % GOLD_PULSES.length],
          });
        }
      }
      for (let i = pulses.length - 1; i >= 0; i--) {
        pulses[i].t += pulses[i].speed * dt;
        if (pulses[i].t > 1.3) pulses.splice(i, 1);
      }

      computePositions(t, 1 - Math.pow(0.002, dt));
      drawNetwork(t);
      drawPulses();
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (running) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (!running) return;
      running = false;
      cancelAnimationFrame(raf);
    };

    resize();
    const ro = new ResizeObserver(() => {
      resize();
      if (!running) {
        const t = performance.now() / 1000;
        computePositions(t, 1);
        drawNetwork(t);
      }
    });
    ro.observe(wrap);

    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (visible) start();
        else stop();
      },
      { rootMargin: "80px" },
    );
    io.observe(wrap);

    const onMove = (ev: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ev.clientX - rect.left;
      pointer.y = ev.clientY - rect.top;
      pointer.active = true;
    };
    const onLeave = () => {
      pointer.active = false;
    };
    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerleave", onLeave);

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerleave", onLeave);
    };
  }, [reduce]);

  return (
    <div
      ref={wrapRef}
      className="noise relative h-[420px] overflow-hidden rounded-hero border border-hairline bg-surface shadow-soft"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -top-28 left-[18%] h-80 w-80 rounded-full"
        style={{
          background:
            "radial-gradient(closest-side, rgb(226 190 104 / 0.08), transparent)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-32 right-[12%] h-80 w-80 rounded-full"
        style={{
          background:
            "radial-gradient(closest-side, rgb(235 184 62 / 0.08), transparent)",
        }}
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        role="img"
        aria-label="Animated neural network showing YSNAP's five AI models — vision, language, voice, cloud and on-device — exchanging signals"
      />
    </div>
  );
}

/* --------------------------------------------------------------- section */

export default function Intelligence() {
  return (
    <Section id="intelligence" tone="canvas">
      <div className="shell">
        <SectionHeading
          eyebrow="Intelligence"
          title={
            <>
              One mind. <span className="text-gradient">Five senses.</span>
            </>
          }
          description="Vision, language, voice, cloud and on-device models don't take turns — they reason together. Every answer draws on all five at once."
        />

        <Reveal>
          <NeuralCanvas />
        </Reveal>

        <ul className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:mt-8 md:grid-cols-5 md:gap-4">
          {SENSES.map((sense, i) => (
            <Reveal
              as="li"
              key={sense.name}
              delay={0.08 * i}
              className={cn(
                "group rounded-card border border-hairline bg-surface p-4 shadow-soft transition-all duration-300 hover:-translate-y-1 hover:shadow-lift",
                i === 4 && "col-span-2 sm:col-span-1",
              )}
            >
              <span className={cn("flex h-9 w-9 items-center justify-center rounded-xl", sense.chip)}>
                {sense.icon}
              </span>
              <h3 className="mt-3 text-sm font-medium tracking-normal text-ink">
                {sense.name}
              </h3>
              <p className="mt-1 text-[13px] leading-snug text-faint">
                {sense.blurb}
              </p>
            </Reveal>
          ))}
        </ul>
      </div>
    </Section>
  );
}
