"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";

/**
 * YSNAPAI neural 3D banner — a dark "window" into the brain, ported from the
 * standalone banner concept: a rotating point-cloud brain (gold nodes, electric
 * blue synapses) over a breathing wireframe terrain, with travelling signals
 * and synapse flashes. Drag rotates; double-click/tap toggles auto-rotation.
 *
 * Port notes vs. the original fixed 1136×420 banner:
 * - responsive: canvas fills the card; the brain sits left-of-centre when the
 *   copy overlay is visible (md+) and centres on small screens
 * - wheel/pinch zoom removed — inside a scrolling page they hijack scroll
 * - site conventions added: rAF pauses offscreen and when the tab is hidden;
 *   prefers-reduced-motion renders a single static frame with no rotation
 */

/* ------------------------------------------------------- stroke wordmark */

const GLYPH: Record<string, number[][][]> = {
  Y: [
    [
      [0, 0],
      [5, 6.5],
    ],
    [
      [10, 0],
      [5, 6.5],
      [5, 14],
    ],
  ],
  S: [
    [
      [9, 1],
      [2, 1],
      [1, 2],
      [1, 6],
      [2, 7],
      [8, 7],
      [9, 8],
      [9, 12],
      [8, 13],
      [1, 13],
    ],
  ],
  N: [
    [
      [1, 14],
      [1, 0],
      [9, 14],
      [9, 0],
    ],
  ],
  A: [
    [
      [0, 14],
      [5, 0],
      [10, 14],
    ],
    [
      [2.3, 9.5],
      [7.7, 9.5],
    ],
  ],
  P: [
    [
      [1, 14],
      [1, 0],
      [8, 0],
      [9, 1],
      [9, 6],
      [8, 7],
      [1, 7],
    ],
  ],
  I: [
    [
      [2, 0],
      [8, 0],
    ],
    [
      [5, 0],
      [5, 14],
    ],
    [
      [2, 14],
      [8, 14],
    ],
  ],
};

/** "YSNAP" in electric blue, the "AI" in gold — precomputed, pure math. */
const WORDMARK_PATHS: { d: string; stroke: string }[] = (() => {
  const word = "YSNAPAI";
  const size = 58;
  const s = size / 14;
  const adv = 10 * s + 18;
  let x = 6;
  const out: { d: string; stroke: string }[] = [];
  [...word].forEach((ch, i) => {
    for (const pl of GLYPH[ch]) {
      const d =
        "M " +
        pl.map((p) => `${(x + p[0] * s).toFixed(1)} ${(8 + p[1] * s).toFixed(1)}`).join(" L ");
      out.push({ d, stroke: i < 5 ? "#19c8ff" : "#ffc94d" });
    }
    x += adv;
  });
  return out;
})();

const LINES = [
  "SPEAK ANY WORLD LANGUAGE — IN YOUR OWN VOICE.",
  "TRANSLATE. INSTANTLY. EVERYWHERE.",
  "DISCOVER ANYTHING THROUGH OUR LENS.",
] as const;

/* ------------------------------------------------------------ component */

export default function NeuralBrainBanner() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tlRef = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();

  /* typewriter tagline */
  useEffect(() => {
    const el = tlRef.current;
    if (!el) return;
    if (reduce) {
      el.textContent = LINES[0];
      return;
    }
    let li = 0;
    let ci = 0;
    let del = false;
    let timer = 0;
    const step = () => {
      const line = LINES[li];
      if (!del) {
        ci++;
        el.textContent = line.slice(0, ci);
        timer = window.setTimeout(step, ci >= line.length ? ((del = true), 2100) : 34);
        return;
      }
      ci--;
      el.textContent = line.slice(0, ci);
      if (ci <= 0) {
        del = false;
        li = (li + 1) % LINES.length;
        timer = window.setTimeout(step, 420);
        return;
      }
      timer = window.setTimeout(step, 11);
    };
    step();
    return () => window.clearTimeout(timer);
  }, [reduce]);

  /* 3D engine */
  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    if (!wrap || !cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    let W = 0;
    let H = 0;
    let DPR = 1;
    let cssW = 0;

    let seed = 1337;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    const makeSprite = (color: string, inner: string) => {
      const s = document.createElement("canvas");
      s.width = s.height = 64;
      const c = s.getContext("2d")!;
      const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, inner);
      g.addColorStop(0.25, color);
      g.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
      return s;
    };
    const SPR: Record<string, HTMLCanvasElement> = {
      gold: makeSprite("rgba(255,201,77,.55)", "rgba(255,246,220,1)"),
      amber: makeSprite("rgba(255,170,60,.5)", "rgba(255,230,190,1)"),
      blue: makeSprite("rgba(25,200,255,.5)", "rgba(210,244,255,1)"),
      white: makeSprite("rgba(160,225,255,.7)", "rgba(255,255,255,1)"),
    };

    const bump = (x: number, y: number, z: number) =>
      0.5 * Math.sin(4.2 * x + 2.1 * z) +
      0.4 * Math.sin(3.6 * y + 1.9 * x + 1.3) +
      0.3 * Math.sin(5.1 * z + 2.7 * y + 0.6) +
      0.25 * Math.sin(7.3 * x + 4.1 * y + 3.2 * z);

    /* ---------- brain point cloud + cerebellum + stem ---------- */
    type Node3 = { x: number; y: number; z: number; c: string; s: number; ph: number };
    const nodes: Node3[] = [];
    for (let i = 0; i < 680; i++) {
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const r0 = Math.sqrt(1 - u * u);
      const dx = r0 * Math.cos(th);
      const dy = u;
      const dz = r0 * Math.sin(th);
      const surf = rnd() > 0.18;
      const r = (surf ? 1 : 0.72 + rnd() * 0.22) * (1 + 0.075 * bump(dx, dy, dz));
      let x = dx * r * 1.02;
      let y = dy * r * 0.92;
      const z = dz * r * 1.32;
      if (Math.abs(x) < 0.14 && y > 0.15) y *= 0.8;
      x += Math.sign(x) * 0.05;
      if (y < -0.5) y = -0.5 - (y + 0.5) * 0.35;
      if (z > 0.9) y *= 0.9;
      const cr = rnd();
      nodes.push({
        x,
        y,
        z,
        c: cr < 0.58 ? "gold" : cr < 0.76 ? "amber" : cr < 0.92 ? "blue" : "white",
        s: (0.5 + rnd() * 1.1) * (surf ? 1 : 0.7),
        ph: rnd() * 7,
      });
    }
    for (let i = 0; i < 120; i++) {
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const r0 = Math.sqrt(1 - u * u);
      const r = 1 + 0.1 * bump(r0, u, th);
      nodes.push({
        x: r0 * Math.cos(th) * 0.46 * r,
        y: -0.52 + u * 0.3 * r,
        z: -1.05 - r0 * Math.sin(th) * 0.42 * r,
        c: rnd() < 0.65 ? "gold" : "blue",
        s: 0.4 + rnd() * 0.8,
        ph: rnd() * 7,
      });
    }
    for (let i = 0; i < 22; i++) {
      const t0 = i / 21;
      const p = {
        x: Math.sin(t0 * 2.2) * 0.12,
        y: -0.62 - t0 * 1.55,
        z: -0.55 + Math.sin(t0 * 3.1) * 0.16 - t0 * 0.15,
      };
      for (let k = 0; k < 3; k++)
        nodes.push({
          x: p.x + (rnd() - 0.5) * 0.22,
          y: p.y + (rnd() - 0.5) * 0.12,
          z: p.z + (rnd() - 0.5) * 0.22,
          c: rnd() < 0.55 ? "gold" : "blue",
          s: 0.35 + rnd() * 0.6,
          ph: rnd() * 7,
        });
    }

    const edges: [number, number, number, boolean][] = [];
    {
      const MAXD2 = 0.28 * 0.28;
      const deg = new Array(nodes.length).fill(0);
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          if (deg[i] > 5) break;
          const b = nodes[j];
          if (deg[j] > 5) continue;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dz = a.z - b.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < MAXD2) {
            edges.push([i, j, 0.5 + rnd() * 0.5, rnd() < 0.14]);
            deg[i]++;
            deg[j]++;
          }
        }
      }
    }
    const adj: number[][] = nodes.map(() => []);
    for (const [i, j] of edges) {
      adj[i].push(j);
      adj[j].push(i);
    }

    /* ---------- terrain + dust ---------- */
    const GXN = 40;
    const GZN = 18;
    type TPoint = { gx: number; gz: number; c: string; s: number; ph: number; show: boolean };
    const terr: TPoint[] = [];
    for (let iz = 0; iz < GZN; iz++)
      for (let ix = 0; ix < GXN; ix++)
        terr.push({
          gx: (ix / (GXN - 1) - 0.5) * 15,
          gz: (iz / (GZN - 1) - 0.5) * 7,
          c: rnd() < 0.55 ? "gold" : rnd() < 0.5 ? "amber" : "blue",
          s: 0.5 + rnd() * 1.4,
          ph: rnd() * 7,
          show: rnd() < 0.6,
        });
    const tEdges: [number, number][] = [];
    for (let iz = 0; iz < GZN; iz++)
      for (let ix = 0; ix < GXN; ix++) {
        const i = iz * GXN + ix;
        if (ix < GXN - 1 && rnd() < 0.7) tEdges.push([i, i + 1]);
        if (iz < GZN - 1 && rnd() < 0.7) tEdges.push([i, i + GXN]);
        if (ix < GXN - 1 && iz < GZN - 1 && rnd() < 0.18) tEdges.push([i, i + GXN + 1]);
      }
    const terrY = (x: number, z: number, t: number) =>
      -2.35 +
      0.3 * Math.sin(x * 0.55 + t * 0.7) +
      0.2 * Math.sin(z * 0.9 - t * 0.5 + x * 0.3) +
      0.13 * Math.sin((x + z) * 1.3 + t * 0.9);
    const dust = Array.from({ length: 36 }, () => ({
      x: (rnd() - 0.5) * 15,
      y: -2.5 + rnd() * 1.1,
      z: (rnd() - 0.5) * 7,
      c: rnd() < 0.5 ? "gold" : rnd() < 0.55 ? "amber" : "blue",
      s: 3 + rnd() * 6,
      ph: rnd() * 7,
    }));

    /* ---------- signals + flashes ---------- */
    type Signal = { path: number[]; t: number; sp: number };
    const signals: Signal[] = [];
    const newSignal = () => {
      let n = Math.floor(rnd() * nodes.length);
      let hops = 3 + Math.floor(rnd() * 4);
      const path = [n];
      while (hops--) {
        const a = adj[n];
        if (!a.length) break;
        n = a[Math.floor(rnd() * a.length)];
        path.push(n);
      }
      if (path.length >= 2) signals.push({ path, t: 0, sp: 0.9 + rnd() * 1.4 });
    };
    for (let i = 0; i < 14; i++) newSignal();
    const flashes: { n: number; t: number }[] = [];

    /* ---------- camera ---------- */
    let yaw = 0.55;
    let pitch = 0.13;
    const dist = 4.5;
    let auto = !reduce;
    let dragging = false;
    let lx = 0;
    let ly = 0;

    const TARGET = { x: 0, y: -0.55, z: 0 };
    const BLUE = "#19c8ff";
    const BLUE2 = "#3d7bff";
    const GOLDL = "#ffc94d";
    let sy = 0,
      cy2 = 0,
      sp = 0,
      cp = 0,
      fov = 0,
      cxp = 0,
      cyp = 0;
    type Pt = { x: number; y: number; z: number; s: number };
    const P: Pt = { x: 0, y: 0, z: 0, s: 0 };
    const Q: Pt = { x: 0, y: 0, z: 0, s: 0 };
    const proj = (x: number, y: number, z: number, out: Pt) => {
      x -= TARGET.x;
      y -= TARGET.y;
      z -= TARGET.z;
      const x1 = x * cy2 + z * sy;
      const z1 = -x * sy + z * cy2;
      const y1 = y * cp - z1 * sp;
      let z2 = y * sp + z1 * cp;
      z2 += dist;
      if (z2 < 0.4) return false;
      const s = fov / z2;
      out.x = cxp + x1 * s;
      out.y = cyp - y1 * s;
      out.z = z2;
      out.s = s;
      return true;
    };

    /* ---------- draw one frame at time t ---------- */
    const draw = (t: number, dt: number, animate: boolean) => {
      sy = Math.sin(yaw);
      cy2 = Math.cos(yaw);
      sp = Math.sin(pitch);
      cp = Math.cos(pitch);
      fov = H * 0.92;
      /* brain left-of-centre when the copy overlay is showing (md+) */
      cxp = W * (cssW >= 768 ? 0.295 : 0.5);
      cyp = H * 0.44;

      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = "lighter";
      const focus = dist;

      /* terrain */
      ctx.lineWidth = Math.max(1, DPR * 0.8);
      for (const [i, j] of tEdges) {
        const a = terr[i];
        const b = terr[j];
        if (!proj(a.gx, terrY(a.gx, a.gz, t), a.gz, P) || !proj(b.gx, terrY(b.gx, b.gz, t), b.gz, Q))
          continue;
        ctx.globalAlpha = 0.15 * Math.min(1, 3.2 / ((P.z + Q.z) / 2));
        ctx.strokeStyle = BLUE2;
        ctx.beginPath();
        ctx.moveTo(P.x, P.y);
        ctx.lineTo(Q.x, Q.y);
        ctx.stroke();
      }
      for (const p of terr) {
        if (!p.show) continue;
        if (!proj(p.gx, terrY(p.gx, p.gz, t), p.gz, P)) continue;
        const b = Math.abs(P.z - focus) / focus;
        const sz = p.s * (1 + 0.3 * Math.sin(t * 2 + p.ph)) * P.s * 0.02 * (1 + b * 2.2);
        ctx.globalAlpha = Math.min(0.8, 0.5 / (1 + b * 3));
        ctx.drawImage(SPR[p.c], P.x - sz, P.y - sz, sz * 2, sz * 2);
      }
      for (const p of dust) {
        if (!proj(p.x, p.y + 0.1 * Math.sin(t + p.ph), p.z, P)) continue;
        const sz = p.s * P.s * 0.02;
        ctx.globalAlpha = 0.09 + 0.05 * Math.sin(t * 1.4 + p.ph);
        ctx.drawImage(SPR[p.c], P.x - sz, P.y - sz, sz * 2, sz * 2);
      }

      /* brain edges — electric blue (some gold) */
      for (const [i, j, al, g] of edges) {
        const a = nodes[i];
        const b = nodes[j];
        if (!proj(a.x, a.y, a.z, P) || !proj(b.x, b.y, b.z, Q)) continue;
        const dep = Math.max(0.15, Math.min(1, 3.4 / ((P.z + Q.z) / 2)));
        ctx.globalAlpha = al * 0.44 * dep;
        ctx.strokeStyle = g ? GOLDL : BLUE;
        ctx.beginPath();
        ctx.moveTo(P.x, P.y);
        ctx.lineTo(Q.x, Q.y);
        ctx.stroke();
      }
      /* brain nodes — gold */
      for (const p of nodes) {
        if (!proj(p.x, p.y, p.z, P)) continue;
        const b = Math.abs(P.z - focus) / focus;
        const sz = p.s * (1 + 0.28 * Math.sin(t * 2.3 + p.ph)) * P.s * 0.019 * (1 + b * 1.6);
        ctx.globalAlpha = Math.min(1, 0.8 / (1 + b * 2.2));
        ctx.drawImage(SPR[p.c], P.x - sz, P.y - sz, sz * 2, sz * 2);
      }

      if (animate) {
        /* travelling signals */
        let respawn = 0;
        for (let si = signals.length - 1; si >= 0; si--) {
          const s = signals[si];
          s.t += dt * s.sp;
          const seg = Math.floor(s.t);
          const a = nodes[s.path[seg]];
          const b = nodes[s.path[seg + 1]];
          if (seg >= s.path.length - 1 || !a || !b) {
            signals.splice(si, 1);
            respawn++;
            continue;
          }
          const f = s.t - seg;
          if (!proj(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f, P))
            continue;
          const sz = P.s * 0.028;
          ctx.globalAlpha = 0.9;
          ctx.drawImage(SPR.white, P.x - sz, P.y - sz, sz * 2, sz * 2);
        }
        while (respawn-- > 0) newSignal();

        /* synapse flashes */
        if (rnd() < dt * 2.2) flashes.push({ n: Math.floor(rnd() * nodes.length), t: 0 });
        for (let i = flashes.length - 1; i >= 0; i--) {
          const f = flashes[i];
          f.t += dt * 2.4;
          if (f.t > 1) {
            flashes.splice(i, 1);
            continue;
          }
          const p = nodes[f.n];
          if (!proj(p.x, p.y, p.z, P)) continue;
          const r = f.t * P.s * 0.09;
          const a = 1 - f.t;
          ctx.globalAlpha = a * 0.8;
          const sz = P.s * 0.05 * (1 - f.t * 0.5);
          ctx.drawImage(SPR.white, P.x - sz, P.y - sz, sz * 2, sz * 2);
          ctx.globalAlpha = a * 0.5;
          ctx.strokeStyle = "#bfe9ff";
          ctx.lineWidth = DPR;
          ctx.beginPath();
          ctx.arc(P.x, P.y, r, 0, 7);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    };

    /* ---------- loop + lifecycle ---------- */
    let raf = 0;
    let inView = false;
    let pageVisible = !document.hidden;
    let t = 0;
    let pt = 0;

    const frame = (now: number) => {
      if (pt === 0) pt = now;
      const dt = Math.min(0.05, (now - pt) / 1000);
      pt = now;
      t += dt;
      if (auto && !dragging) yaw += dt * 0.22;
      draw(t, dt, true);
      raf = requestAnimationFrame(frame);
    };
    const running = () => inView && pageVisible && !reduce;
    const start = () => {
      if (raf === 0 && running()) {
        pt = 0;
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
        if (reduce) draw(0, 0, false);
      }
    };

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      cssW = rect.width;
      DPR = Math.min(devicePixelRatio || 1, 2);
      W = cv.width = Math.round(rect.width * DPR);
      H = cv.height = Math.round(rect.height * DPR);
      draw(t, 0, false); // repaint immediately so a paused canvas isn't stale
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry) {
          inView = entry.isIntersecting;
          sync();
        }
      },
      { rootMargin: "80px" },
    );
    io.observe(wrap);
    const onVis = () => {
      pageVisible = !document.hidden;
      sync();
    };
    document.addEventListener("visibilitychange", onVis);

    /* drag to rotate; double-click toggles auto-rotate. touch-action pan-y on
       the canvas keeps vertical page scrolling alive on touch. */
    const onDown = (e: PointerEvent) => {
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
      cv.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      yaw += (e.clientX - lx) * 0.005;
      pitch = Math.max(-0.9, Math.min(1.1, pitch + (e.clientY - ly) * 0.004));
      lx = e.clientX;
      ly = e.clientY;
      auto = false;
    };
    const onUp = () => {
      dragging = false;
    };
    const onDbl = () => {
      auto = !auto;
    };
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("pointercancel", onUp);
    cv.addEventListener("dblclick", onDbl);

    sync();

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      cv.removeEventListener("pointerdown", onDown);
      cv.removeEventListener("pointermove", onMove);
      cv.removeEventListener("pointerup", onUp);
      cv.removeEventListener("pointercancel", onUp);
      cv.removeEventListener("dblclick", onDbl);
    };
  }, [reduce]);

  return (
    <div
      ref={wrapRef}
      className="relative h-[420px] overflow-hidden rounded-hero border shadow-soft"
      style={{
        background: "radial-gradient(ellipse at 30% 45%, #08131f 0%, #040a12 55%, #020509 100%)",
        borderColor: "rgba(25,200,255,.22)",
        boxShadow:
          "0 0 60px rgba(25,200,255,.14), 0 24px 70px rgba(0,0,0,.45), inset 0 0 80px rgba(10,60,110,.15)",
      }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing [touch-action:pan-y]"
        role="img"
        aria-label="Interactive 3D neural brain — gold neurons joined by electric blue synapses, with signals travelling across the network"
      />

      {/* scanlines + inner rim + corner accents */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          background:
            "linear-gradient(to bottom, transparent, rgba(60,180,255,.04) 50%, transparent)",
          backgroundSize: "100% 5px",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-[10px] rounded-[27px] border"
        style={{ borderColor: "rgba(25,200,255,.14)" }}
      />
      {(
        [
          ["top-[18px] left-[18px] rounded-tl-[14px] border-r-0 border-b-0", "rgba(25,200,255,.55)"],
          ["top-[18px] right-[18px] rounded-tr-[14px] border-l-0 border-b-0", "rgba(255,201,77,.55)"],
          ["bottom-[18px] left-[18px] rounded-bl-[14px] border-r-0 border-t-0", "rgba(255,201,77,.55)"],
          ["bottom-[18px] right-[18px] rounded-br-[14px] border-l-0 border-t-0", "rgba(25,200,255,.55)"],
        ] as const
      ).map(([cls, color], i) => (
        <div
          key={i}
          aria-hidden
          className={`pointer-events-none absolute h-[26px] w-[26px] border-2 ${cls}`}
          style={{ borderColor: color }}
        />
      ))}

      {/* status badge */}
      <div className="pointer-events-none absolute left-11 top-6 flex items-center gap-2 font-mono text-[10px] tracking-[3px] text-[#6fa9cc]">
        <i
          className="h-[7px] w-[7px] animate-pulse rounded-full"
          style={{ background: "#19c8ff", boxShadow: "0 0 10px #19c8ff" }}
        />
        NEURAL LENS · ONLINE
      </div>

      {/* right-side copy — hidden on small screens where the brain centres */}
      <div className="pointer-events-none absolute right-12 top-1/2 hidden w-[520px] -translate-y-1/2 md:block">
        <svg
          viewBox="0 0 470 74"
          className="block w-[430px]"
          style={{ filter: "drop-shadow(0 0 14px rgba(25,200,255,.55))" }}
          aria-label="YSNAPAI"
        >
          {WORDMARK_PATHS.map((p, i) => (
            <path
              key={i}
              d={p.d}
              fill="none"
              stroke={p.stroke}
              strokeWidth={6.5}
              strokeLinecap="square"
              strokeLinejoin="miter"
            />
          ))}
        </svg>
        <div className="mt-5 min-h-[44px] font-mono text-[15px] leading-[1.55] tracking-[2.5px] text-[#bfe9ff] [text-shadow:0_0_12px_rgba(25,200,255,.6)]">
          <span ref={tlRef} />
          <span
            className="ml-1 inline-block h-4 w-[9px] animate-pulse align-[-2px]"
            style={{ background: "#19c8ff", boxShadow: "0 0 8px #19c8ff" }}
          />
        </div>
        <div className="mt-4 flex gap-2.5">
          {["◉ SPEAK", "⇄ TRANSLATE", "◎ LENS"].map((chip) => (
            <span
              key={chip}
              className="whitespace-nowrap rounded-full border px-3 py-1.5 font-mono text-[10px] tracking-[2px] text-[#7fb6d8]"
              style={{ borderColor: "rgba(25,200,255,.3)", background: "rgba(25,200,255,.05)" }}
            >
              {chip.split(" ")[0]} <b className="font-normal text-[#ffc94d]">{chip.split(" ")[1]}</b>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
