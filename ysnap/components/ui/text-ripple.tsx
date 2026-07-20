"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * Infinite text ripple — world-script greetings drift like faint stars behind
 * the hero. When the pointer nears a glyph it gently morphs into its Latin
 * transliteration and warms toward the accent hue: translation, literally
 * happening in the background.
 *
 * Perf/a11y mirrors MeshBackground: DPR-aware sizing, rAF paused when
 * offscreen or the tab is hidden, static frame under prefers-reduced-motion.
 */

type Pair = readonly [native: string, latin: string];

const GREETINGS: readonly Pair[] = [
  ["नमस्ते", "namaste"],
  ["வணக்கம்", "vanakkam"],
  ["こんにちは", "konnichiwa"],
  ["안녕하세요", "annyeong"],
  ["مرحبا", "marhaba"],
  ["你好", "nǐ hǎo"],
  ["Привет", "privet"],
  ["Γειά σου", "yassou"],
  ["שלום", "shalom"],
  ["สวัสดี", "sawasdee"],
  ["নমস্কার", "nomoshkar"],
  ["హలో", "halo"],
  ["ሰላም", "selam"],
  ["Xin chào", "sin chow"],
  ["Habari", "habari"],
  ["Olá", "olá"],
];

/* same stack the phone screen texture uses — covers Indic scripts on win/mac */
const FONT_STACK =
  '"Segoe UI","Nirmala UI","Tamil Sangam MN","Devanagari Sangam MN","Noto Sans Tamil","Noto Sans Devanagari",Inter,sans-serif';

const MOUSE_DIST = 150; // px — morph radius around the cursor
const SMALL_VIEWPORT = 768;

type Glyph = {
  pair: Pair;
  bx: number;
  by: number;
  ampX: number;
  ampY: number;
  sp: number;
  ph: number;
  size: number;
  morph: number; // 0 native … 1 latin (lerped)
  x: number;
  y: number;
};

/* hand-placed fractional positions so glyphs ring the headline, never behind it */
const SLOTS: ReadonlyArray<readonly [number, number]> = [
  [0.07, 0.16], [0.2, 0.08], [0.36, 0.05], [0.62, 0.06], [0.8, 0.09], [0.93, 0.17],
  [0.04, 0.42], [0.96, 0.4], [0.06, 0.68], [0.94, 0.66],
  [0.12, 0.88], [0.3, 0.94], [0.5, 0.97], [0.7, 0.93], [0.88, 0.87], [0.22, 0.52],
];

export default function TextRipple({ className }: { className?: string }) {
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
    let activeCount = GREETINGS.length;
    const mouse = { x: -10000, y: -10000, active: false };

    const rm = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = rm.matches;

    const glyphs: Glyph[] = GREETINGS.map((pair, i) => ({
      pair,
      bx: SLOTS[i % SLOTS.length][0],
      by: SLOTS[i % SLOTS.length][1],
      ampX: 8 + Math.random() * 14,
      ampY: 10 + Math.random() * 16,
      sp: 0.05 + Math.random() * 0.08,
      ph: Math.random() * Math.PI * 2,
      size: 13 + Math.random() * 6,
      morph: 0,
      x: 0,
      y: 0,
    }));

    let elapsed = Math.random() * 100;
    let last = 0;

    const draw = (t: number, interactive: boolean) => {
      ctx.clearRect(0, 0, width, height);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let i = 0; i < activeCount; i++) {
        const g = glyphs[i];
        g.x = g.bx * width + Math.sin(t * g.sp + g.ph) * g.ampX;
        g.y = g.by * height + Math.cos(t * g.sp * 1.3 + g.ph) * g.ampY;

        let target = 0;
        if (interactive && mouse.active) {
          const d = Math.hypot(mouse.x - g.x, mouse.y - g.y);
          if (d < MOUSE_DIST) target = 1 - d / MOUSE_DIST;
        }
        g.morph += (target - g.morph) * 0.07;
        const m = g.morph;

        ctx.font = `500 ${g.size}px ${FONT_STACK}`;
        /* native script fades out as the transliteration fades in */
        if (m < 0.98) {
          ctx.fillStyle = `rgba(11,12,14,${(0.16 * (1 - m)).toFixed(3)})`;
          ctx.fillText(g.pair[0], g.x, g.y - m * 4);
        }
        if (m > 0.02) {
          /* latin form warms toward the accent blue as it resolves */
          const cr = Math.round(11 + (76 - 11) * m);
          const cg = Math.round(12 + (125 - 12) * m);
          const cb = Math.round(14 + (255 - 14) * m);
          ctx.fillStyle = `rgba(${cr},${cg},${cb},${(0.1 + 0.42 * m).toFixed(3)})`;
          ctx.fillText(g.pair[1], g.x, g.y + (1 - m) * 6);
        }
      }
    };

    const running = () => inView && pageVisible && !reduced;

    const frame = (now: number) => {
      if (last === 0) last = now;
      elapsed += Math.min(0.05, (now - last) / 1000);
      last = now;
      draw(elapsed, true);
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
        if (reduced) draw(elapsed, false);
      }
    };

    const resize = () => {
      const rect = root.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      if (width <= 0 || height <= 0) return;
      activeCount = window.innerWidth < SMALL_VIEWPORT ? 9 : GREETINGS.length;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(elapsed, !reduced);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(root);
    resize();

    const io = new IntersectionObserver(
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

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
      mouse.active =
        mouse.x >= -MOUSE_DIST &&
        mouse.x <= rect.width + MOUSE_DIST &&
        mouse.y >= -MOUSE_DIST &&
        mouse.y <= rect.height + MOUSE_DIST;
    };
    const onPointerLeave = () => {
      mouse.active = false;
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onPointerLeave);

    sync();

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      rm.removeEventListener("change", onReducedChange);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0", className)}
      /* keep the exact headline zone clean — glyphs live around it */
      style={{
        maskImage:
          "radial-gradient(ellipse 46% 38% at 50% 30%, transparent 42%, black 78%)",
        WebkitMaskImage:
          "radial-gradient(ellipse 46% 38% at 50% 30%, transparent 42%, black 78%)",
      }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
