"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/* ------------------------------------------------------------------ palette */

/* Pastel (~70%-saturation) versions of the spectrum tokens:
   accent, violet, teal, coral, amber, green. */
const SPECTRUM: ReadonlyArray<readonly [number, number, number]> = [
  [124, 156, 255], // accent #4c7dff
  [146, 146, 250], // violet #6e6ef7
  [82, 196, 184], //  teal   #10b3a3
  [255, 138, 128], // coral  #ff6b5e
  [246, 178, 82], //  amber  #f59e0b
  [96, 201, 141], //  green  #34b871
];

/* Light-blue family for the site-wide backdrop — deliberately airy (sky/ice
   tones rather than saturated indigo) so the mesh sits quietly behind content
   instead of competing with it. */
const BLUE: ReadonlyArray<readonly [number, number, number]> = [
  [125, 200, 245], // sky
  [150, 214, 250], // light sky
  [110, 180, 238], // cornflower
  [180, 226, 252], // ice
  [96, 165, 226], // deeper sky
];

/* Polished-gold family: bright highlight tones through to deep antique gold,
   so nodes read as metal catching studio light rather than flat yellow dots. */
const GOLD: ReadonlyArray<readonly [number, number, number]> = [
  [212, 175, 90], //  polished gold
  [234, 202, 128], // highlight
  [190, 148, 60], //  deep gold
  [245, 222, 165], // near-specular
  [172, 130, 48], //  antique
];

const INK: readonly [number, number, number] = [11, 12, 14];
/* light-blue link base — lifted well off ink so wires read as pale sky */
const BLUE_LINK: readonly [number, number, number] = [116, 186, 236];
/* warm alloy line base for the gold palette */
const GOLD_LINK: readonly [number, number, number] = [186, 152, 76];

/* Data-transmission colours that travel the wires. Each is a distinctly
   different hue so traffic never reads as one colour blinking. */
const PULSE_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [56, 108, 255], //  sapphire
  [16, 179, 163], //  teal
  [214, 51, 158], //  magenta
  [235, 184, 62], //  golden yellow
  [124, 92, 240], //  violet
  [244, 63, 94], //   crimson
  [34, 197, 94], //   emerald
  [249, 115, 22], //  amber-orange
];

const PULSE_COUNT = 24; // concurrent packets in flight (gold: dense traffic)
/* The light-blue backdrop keeps the same "data travelling the wires" idea but
   at a fraction of the traffic and speed, so it reads as a calm current rather
   than a busy switchboard. */
const PULSE_COUNT_CALM = 7;
const PULSE_TAIL = 0.2; // fraction of the link drawn as a comet tail

/** Packet speed range (progress/sec) per palette. Calm is ~1/3 of gold. */
const pulseSpeed = (calm: boolean) =>
  calm ? 0.09 + Math.random() * 0.11 : 0.25 + Math.random() * 0.45;

/* drift-blob radial gradients per palette */
const BLOBS: Record<"spectrum" | "blue" | "gold", readonly [string, string, string]> = {
  spectrum: [
    "radial-gradient(closest-side, rgb(76 125 255 / 0.08), rgb(110 110 247 / 0.06), transparent 72%)",
    "radial-gradient(closest-side, rgb(16 179 163 / 0.07), rgb(52 184 113 / 0.05), transparent 72%)",
    "radial-gradient(closest-side, rgb(255 107 94 / 0.07), rgb(245 158 11 / 0.05), transparent 72%)",
  ],
  /* airy sky wash — keeps the page high-key, never a heavy indigo cast */
  blue: [
    "radial-gradient(closest-side, rgb(125 200 245 / 0.10), rgb(168 219 250 / 0.07), transparent 72%)",
    "radial-gradient(closest-side, rgb(110 180 238 / 0.08), rgb(140 206 246 / 0.06), transparent 72%)",
    "radial-gradient(closest-side, rgb(96 165 226 / 0.07), rgb(180 226 252 / 0.06), transparent 72%)",
  ],
  /* warm studio bounce — keeps the white background high-key, never yellow */
  gold: [
    "radial-gradient(closest-side, rgb(226 190 104 / 0.1), rgb(212 175 90 / 0.07), transparent 72%)",
    "radial-gradient(closest-side, rgb(235 184 62 / 0.08), rgb(190 148 60 / 0.06), transparent 72%)",
    "radial-gradient(closest-side, rgb(56 108 255 / 0.05), rgb(214 51 158 / 0.04), transparent 72%)",
  ],
};

const LINK_DIST = 140; // px — draw links between nodes closer than this
const MOUSE_DIST = 180; // px — cursor influence radius
const MAX_PULL = 24; // px — cap on mouse-attraction displacement
const SMALL_VIEWPORT = 768; // px — below this, thin the mesh for phone-class GPUs
const SMALL_DENSITY_SCALE = 0.55; // fraction of configured density used on small viewports

/* ------------------------------------------------------------------ types */

type MeshNode = {
  bx: number; // base position, fraction of width
  by: number; // base position, fraction of height
  ampX: number; // drift amplitude px
  ampY: number;
  spX: number; // drift speed rad/s
  spY: number;
  phX: number; // drift phase
  phY: number;
  ox: number; // lerped mouse-attraction offset px
  oy: number;
  x: number; // resolved position px
  y: number;
  heat: number; // 0..1 cursor proximity (lerped) — brightens links + dot
  color: number; // index into SPECTRUM
  r: number; // dot radius px (2–3px diameter)
};

export type MeshBackgroundProps = {
  className?: string;
  /** Approximate node count. Default 64. */
  density?: number;
  /** Node/link/blob color family. Default "spectrum". */
  palette?: "spectrum" | "blue" | "gold";
  /**
   * Render as a position:fixed full-viewport backdrop (still pointer-events-none).
   * Skips the IntersectionObserver pause — a fixed backdrop is always visible —
   * while keeping the document.hidden pause and the reduced-motion static frame.
   */
  fixed?: boolean;
};

/* ------------------------------------------------------------------ component */

/**
 * Interactive plexus mesh on white — drifting spectrum-tinted nodes joined by
 * hairline ink links that gently gather and light up around the cursor.
 * Sits behind content: three slow-drifting gradient blobs + a canvas.
 *
 * Perf/a11y: DPR-aware ResizeObserver sizing, rAF paused when offscreen
 * (IntersectionObserver) or when the tab is hidden, and a fully static single
 * frame under prefers-reduced-motion.
 */
export default function MeshBackground({
  className,
  density = 64,
  palette = "spectrum",
  fixed = false,
}: MeshBackgroundProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let raf = 0;
    let inView = true;
    let pageVisible = !document.hidden;
    const mouse = { x: -10000, y: -10000, active: false };

    const rm = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = rm.matches;

    /* palette-dependent colors: blue swaps the ink link base for a blue-gray
       and draws dots from the blue-indigo family */
    const dotColors = palette === "blue" ? BLUE : palette === "gold" ? GOLD : SPECTRUM;
    const linkBase =
      palette === "blue" ? BLUE_LINK : palette === "gold" ? GOLD_LINK : INK;
    /* gold sits lighter than ink on white, so its wires need a little more
       alpha to read at all — and more headroom when lit by the cursor */
    const baseAlphaFloor = palette === "gold" ? 0.15 : palette === "blue" ? 0.05 : 0.04;
    const hotAlphaMax = palette === "gold" ? 0.55 : palette === "blue" ? 0.26 : 0.25;
    const metallic = palette === "gold";
    /* blue keeps the travelling-packet idea, but calm: fewer, slower, and
       drawn in the palette's own light-blue tones rather than the full
       multi-hue set (which is what made the gold backdrop read as noisy). */
    const calm = palette === "blue";
    const pulsing = metallic || calm;

    const count = Math.max(8, Math.round(density));
    const nodes: MeshNode[] = Array.from({ length: count }, (_, i) => ({
      bx: Math.random(),
      by: Math.random(),
      ampX: 14 + Math.random() * 26,
      ampY: 14 + Math.random() * 26,
      /* drift rate rad/s — deliberately unhurried so the lattice breathes
         rather than shimmers */
      spX: 0.035 + Math.random() * 0.05,
      spY: 0.035 + Math.random() * 0.05,
      phX: Math.random() * Math.PI * 2,
      phY: Math.random() * Math.PI * 2,
      ox: 0,
      oy: 0,
      x: 0,
      y: 0,
      heat: 0,
      color: i % dotColors.length,
      r: 1 + Math.random() * 0.5,
    }));

    /* small-viewport adaptation — recomputed in resize(): phones draw ~55% of
       the configured density (link work scales ~quadratically with node count)
       and skip the cursor-attraction pass while idle — a touch or pointer
       interaction re-enables it (see the pointer handlers below). The full
       node pool is kept so growing the viewport reactivates nodes in place. */
    let activeCount = count;
    let attract = true;

    /* The far-right node doubles as the network's power source — drawn as a
       deep amber-red light core rather than a gold bead. */
    let coreIdx = 0;
    for (let i = 1; i < count; i++) {
      if (nodes[i].bx > nodes[coreIdx].bx) coreIdx = i;
    }

    /* Live link registry, rebuilt each frame during the link pass. Packets
       reference index pairs from here, so a transmission always rides a wire
       that actually exists at that moment. Preallocated to avoid per-frame GC. */
    const pairs = new Int32Array(count * count);
    let pairCount = 0;

    type Pulse = { i: number; j: number; t: number; sp: number; c: number };
    const pulseCount = metallic ? PULSE_COUNT : calm ? PULSE_COUNT_CALM : 0;
    /* calm traffic stays inside the light-blue family so it tints rather than
       flashes; gold keeps the full multi-hue packet set */
    const pulsePalette = calm ? BLUE : PULSE_COLORS;
    const pulses: Pulse[] = Array.from({ length: pulseCount }, () => ({
      i: 0,
      j: 0,
      t: 1, // start expired so they stagger in as links appear
      sp: pulseSpeed(calm),
      c: Math.floor(Math.random() * pulsePalette.length),
    }));

    /** Re-seat a packet on a random live wire. */
    const respawn = (p: Pulse) => {
      if (pairCount === 0) return;
      const k = Math.floor(Math.random() * pairCount);
      p.i = pairs[k * 2];
      p.j = pairs[k * 2 + 1];
      p.t = 0;
      p.sp = pulseSpeed(calm);
      p.c = Math.floor(Math.random() * pulsePalette.length);
    };

    /* time accumulator (seconds) so pausing never causes a jump */
    let elapsed = Math.random() * 100;
    let last = 0;

    const draw = (t: number, interactive: boolean, dt = 0) => {
      ctx.clearRect(0, 0, width, height);

      /* resolve node positions: slow sin/cos drift + lerped pull toward cursor */
      for (let i = 0; i < activeCount; i++) {
        const n = nodes[i];
        const tx = n.bx * width + Math.sin(t * n.spX + n.phX) * n.ampX;
        const ty = n.by * height + Math.cos(t * n.spY + n.phY) * n.ampY;
        let targetOx = 0;
        let targetOy = 0;
        let targetHeat = 0;
        if (interactive && attract && mouse.active) {
          const dx = mouse.x - tx;
          const dy = mouse.y - ty;
          const d = Math.hypot(dx, dy);
          if (d < MOUSE_DIST && d > 0.001) {
            const pull = 1 - d / MOUSE_DIST;
            targetOx = (dx / d) * pull * MAX_PULL;
            targetOy = (dy / d) * pull * MAX_PULL;
            targetHeat = pull;
          }
        }
        n.ox += (targetOx - n.ox) * 0.08;
        n.oy += (targetOy - n.oy) * 0.08;
        n.heat += (targetHeat - n.heat) * 0.1;
        n.x = tx + n.ox;
        n.y = ty + n.oy;
      }

      /* links — hairline ink at 4–7%, blending toward the hotter node's hue
         (up to 25% alpha) around the cursor */
      ctx.lineWidth = 1;
      pairCount = 0;
      for (let i = 0; i < activeCount; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < activeCount; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > LINK_DIST * LINK_DIST) continue;
          pairs[pairCount * 2] = i;
          pairs[pairCount * 2 + 1] = j;
          pairCount++;
          const d = Math.sqrt(d2);
          const near = 1 - d / LINK_DIST;
          const baseAlpha = baseAlphaFloor + near * 0.03;
          const hot = a.heat >= b.heat ? a : b;
          const heat = hot.heat;
          let cr = linkBase[0];
          let cg = linkBase[1];
          let cb = linkBase[2];
          let alpha = baseAlpha;
          if (metallic) {
            /* Travelling sheen: every wire rides its own phase between deep
               antique gold and near-specular highlight, so the lattice reads as
               polished metal turning under a moving light rather than flat
               yellow strokes. Computed inline — a per-link canvas gradient would
               mean hundreds of allocations per frame. */
            const sh = 0.5 + 0.5 * Math.sin(t * 1.5 + i * 0.7 + j * 1.3);
            cr = 150 + (255 - 150) * sh;
            cg = 118 + (228 - 118) * sh;
            cb = 40 + (156 - 40) * sh;
            alpha *= 0.65 + sh * 0.95;
          }
          if (heat > 0.01) {
            const hue = dotColors[hot.color];
            cr += (hue[0] - cr) * heat;
            cg += (hue[1] - cg) * heat;
            cb += (hue[2] - cb) * heat;
            alpha += (hotAlphaMax - baseAlpha) * heat;
          }
          ctx.strokeStyle = `rgba(${Math.round(cr)},${Math.round(cg)},${Math.round(cb)},${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      /* dots — subtle pastel spectrum, brightening slightly under the cursor.
         In gold the node is drawn as a tiny radial: near-white specular core
         falling to deep gold at the rim, which is what reads as polished metal
         rather than a flat coloured dot. */
      for (let i = 0; i < activeCount; i++) {
        const n = nodes[i];
        const hue = dotColors[n.color];
        const rad = n.r + n.heat * 0.6;
        if (metallic && i === coreIdx) {
          /* the amber-red power core: pulsing halo + white-hot center */
          const pulse = 0.5 + 0.5 * Math.sin(t * 1.6 + n.phX);
          const hr = 10 + pulse * 9;
          const halo = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, hr);
          halo.addColorStop(0, `rgba(255,196,150,${(0.5 + pulse * 0.3).toFixed(3)})`);
          halo.addColorStop(0.35, `rgba(232,102,42,${(0.3 + pulse * 0.2).toFixed(3)})`);
          halo.addColorStop(1, "rgba(200,44,20,0)");
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(n.x, n.y, hr, 0, Math.PI * 2);
          ctx.fill();
          const core = ctx.createRadialGradient(n.x - 0.8, n.y - 0.8, 0, n.x, n.y, 3.4);
          core.addColorStop(0, "rgba(255,244,230,0.98)");
          core.addColorStop(0.5, "rgba(240,110,50,0.95)");
          core.addColorStop(1, "rgba(178,36,18,0.85)");
          ctx.fillStyle = core;
          ctx.beginPath();
          ctx.arc(n.x, n.y, 3.4, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        if (metallic) {
          /* glitter — every node twinkles on its own phase; at the crest it
             throws a tiny 4-point star glint, so the lattice reads as metal
             catching countless points of light */
          const tw = 0.5 + 0.5 * Math.sin(t * (0.5 + n.spX * 5) + n.phX * 2.3);
          if (tw > 0.9) {
            const flare = (tw - 0.9) / 0.1; // 0..1 across the crest
            const len = 3 + flare * 4.5;
            ctx.strokeStyle = `rgba(255,246,220,${(0.5 * flare).toFixed(3)})`;
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(n.x - len, n.y);
            ctx.lineTo(n.x + len, n.y);
            ctx.moveTo(n.x, n.y - len);
            ctx.lineTo(n.x, n.y + len);
            ctx.stroke();
            ctx.lineWidth = 1;
          }
          /* emitter halo — the node nearest the cursor blooms into a bright
             gold/white source feeding the wires around it */
          if (n.heat > 0.12) {
            const hr = 4 + n.heat * 26;
            const halo = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, hr);
            halo.addColorStop(0, `rgba(255,244,214,${(0.5 * n.heat).toFixed(3)})`);
            halo.addColorStop(0.4, `rgba(235,184,62,${(0.28 * n.heat).toFixed(3)})`);
            halo.addColorStop(1, "rgba(235,184,62,0)");
            ctx.fillStyle = halo;
            ctx.beginPath();
            ctx.arc(n.x, n.y, hr, 0, Math.PI * 2);
            ctx.fill();
          }
          const g = ctx.createRadialGradient(
            n.x - rad * 0.35,
            n.y - rad * 0.35,
            0,
            n.x,
            n.y,
            rad * 1.9,
          );
          g.addColorStop(0, `rgba(255,250,235,${(0.95 * (0.5 + tw * 0.25 + n.heat * 0.3)).toFixed(3)})`);
          g.addColorStop(0.45, `rgba(${hue[0]},${hue[1]},${hue[2]},${(0.6 + tw * 0.3).toFixed(3)})`);
          g.addColorStop(1, `rgba(150,112,38,${(0.18 + tw * 0.14 + n.heat * 0.3).toFixed(3)})`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(n.x, n.y, rad * 1.9, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = `rgba(${hue[0]},${hue[1]},${hue[2]},${(0.5 + n.heat * 0.4).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(n.x, n.y, rad, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      /* data transmissions — coloured packets running the gold wires, each a
         comet head with a fading tail. The node under the cursor becomes a
         bright emitter, so interaction visibly injects traffic into the mesh. */
      if (pulsing && pairCount > 0) {
        ctx.lineCap = "round";
        for (const p of pulses) {
          if (p.t >= 1) {
            respawn(p);
            continue;
          }
          p.t += p.sp * dt;
          const a = nodes[p.i];
          const b = nodes[p.j];
          if (!a || !b) continue;
          const col = pulsePalette[p.c];
          const head = Math.min(1, p.t);
          const tail = Math.max(0, head - PULSE_TAIL);
          const hx = a.x + (b.x - a.x) * head;
          const hy = a.y + (b.y - a.y) * head;
          const tx = a.x + (b.x - a.x) * tail;
          const ty = a.y + (b.y - a.y) * tail;
          /* brightness eases in and out so packets never pop at the wire ends */
          const fade = Math.sin(Math.PI * head);
          /* calm traffic is dimmer and smaller — a current under the surface
             rather than sparks across it */
          const gain = calm ? 0.45 : 1;

          const grad = ctx.createLinearGradient(tx, ty, hx, hy);
          grad.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},0)`);
          grad.addColorStop(
            1,
            `rgba(${col[0]},${col[1]},${col[2]},${(0.85 * fade * gain).toFixed(3)})`,
          );
          ctx.strokeStyle = grad;
          ctx.lineWidth = calm ? 1.6 : 2.4;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(hx, hy);
          ctx.stroke();

          /* soft coloured bloom so each packet reads as a light source */
          const br = calm ? 6 : 9;
          const bloom = ctx.createRadialGradient(hx, hy, 0, hx, hy, br);
          bloom.addColorStop(
            0,
            `rgba(${col[0]},${col[1]},${col[2]},${(0.45 * fade * gain).toFixed(3)})`,
          );
          bloom.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
          ctx.fillStyle = bloom;
          ctx.beginPath();
          ctx.arc(hx, hy, br, 0, Math.PI * 2);
          ctx.fill();

          /* white-hot core keeps the hue readable at 2px on white */
          ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${(fade * (calm ? 0.7 : 1)).toFixed(3)})`;
          ctx.shadowColor = `rgba(${col[0]},${col[1]},${col[2]},${calm ? 0.5 : 0.95})`;
          ctx.shadowBlur = calm ? 7 : 12;
          ctx.beginPath();
          ctx.arc(hx, hy, calm ? 1.7 : 2.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
        ctx.lineWidth = 1;
      }
    };

    const running = () => inView && pageVisible && !reduced;

    const frame = (now: number) => {
      if (last === 0) last = now;
      const dt = Math.min(0.05, (now - last) / 1000);
      elapsed += dt;
      last = now;
      draw(elapsed, true, dt);
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (raf === 0 && running()) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    };
    const stop = () => {
      if (raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    const sync = () => {
      if (running()) start();
      else {
        stop();
        /* reduced motion: keep a fully static single frame on screen */
        if (reduced) draw(elapsed, false);
      }
    };

    const resize = () => {
      const rect = root.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      /* Safari's ResizeObserver can fire before layout with a zero-size rect;
         skip sizing/drawing then — the observer fires again with real bounds. */
      if (width <= 0 || height <= 0) return;
      /* small-viewport adaptation: fewer live nodes, and no cursor attraction
         until a pointer actually interacts (a touch re-enables it below — the
         pass only runs while mouse.active, so idle phones still skip it).
         Keyed to the viewport (not the observed rect) so embedded, non-fixed
         instances behave consistently with the site breakpoint. */
      const small = window.innerWidth < SMALL_VIEWPORT;
      activeCount = small ? Math.max(8, Math.round(count * SMALL_DENSITY_SCALE)) : count;
      attract = !small;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      /* repaint immediately so a paused/static mesh never shows stale scale */
      draw(elapsed, !reduced);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(root);
    resize();

    /* a fixed backdrop is always visible — skip the offscreen pause entirely */
    let io: IntersectionObserver | null = null;
    if (!fixed) {
      io = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          if (entry) {
            inView = entry.isIntersecting;
            sync();
          }
        },
        { rootMargin: "80px" },
      );
      io.observe(root);
    }

    const onVisibility = () => {
      pageVisible = !document.hidden;
      sync();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onReducedChange = () => {
      reduced = rm.matches;
      sync();
    };
    rm.addEventListener("change", onReducedChange);

    /* the canvas is pointer-events-none — track the cursor from the window
       and map into canvas space. Touch: pointermove covers drags; pointerdown
       lights the mesh at a TAP, and after lift the interaction point lingers
       briefly (touchFade, 1.2s) before decaying so taps feel alive on phones. */
    let touchFade = 0;
    const clearTouchFade = () => {
      if (touchFade !== 0) {
        window.clearTimeout(touchFade);
        touchFade = 0;
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      clearTouchFade();
      attract = true; // a real pointer is interacting — allow attraction on any viewport
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
      mouse.active =
        mouse.x >= -MOUSE_DIST &&
        mouse.x <= rect.width + MOUSE_DIST &&
        mouse.y >= -MOUSE_DIST &&
        mouse.y <= rect.height + MOUSE_DIST;
    };
    const onPointerDown = (e: PointerEvent) => {
      onPointerMove(e);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      clearTouchFade();
      touchFade = window.setTimeout(() => {
        touchFade = 0;
        mouse.active = false;
      }, 1200);
    };
    const onPointerLeave = () => {
      mouse.active = false;
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointercancel", onPointerUp, { passive: true });
    document.documentElement.addEventListener("pointerleave", onPointerLeave);

    sync();

    return () => {
      stop();
      ro.disconnect();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      rm.removeEventListener("change", onReducedChange);
      clearTouchFade();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [density, palette, fixed]);

  return (
    <div
      ref={rootRef}
      aria-hidden
      className={cn(
        "pointer-events-none overflow-hidden",
        fixed && "fixed inset-0",
        className,
      )}
    >
      {/* soft palette-tinted blobs drifting behind the mesh */}
      <div
        className="animate-floaty absolute -right-40 -top-44 h-[640px] w-[640px] rounded-full blur-3xl"
        style={{
          animationDuration: "38s",
          background: BLOBS[palette][0],
        }}
      />
      <div
        className="animate-floaty absolute -left-56 top-[26%] h-[560px] w-[560px] rounded-full blur-3xl"
        style={{
          animationDuration: "48s",
          animationDelay: "-12s",
          background: BLOBS[palette][1],
        }}
      />
      <div
        className="animate-floaty absolute -bottom-52 left-[28%] h-[620px] w-[620px] rounded-full blur-3xl"
        style={{
          animationDuration: "56s",
          animationDelay: "-22s",
          background: BLOBS[palette][2],
        }}
      />
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
    </div>
  );
}
