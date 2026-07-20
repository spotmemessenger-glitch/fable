"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * Liquid-glass divider — a slow organic wave that swells with scroll velocity,
 * standing in for a hard rule between sections. Two stacked sine layers on a
 * low-alpha accent→violet gradient. Paused offscreen / when hidden; a calm
 * static wave under prefers-reduced-motion.
 */
export default function WaveDivider({
  className,
  flip = false,
}: {
  className?: string;
  /** mirror vertically so adjacent dividers don't read as repeats */
  flip?: boolean;
}) {
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

    const rm = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = rm.matches;

    /* scroll-velocity → wave energy (lerped, decays back to calm) */
    let lastScrollY = typeof window !== "undefined" ? window.scrollY : 0;
    let energy = 0; // 0..1
    const onScroll = () => {
      const y = window.scrollY;
      const v = Math.min(1, Math.abs(y - lastScrollY) / 55);
      lastScrollY = y;
      if (v > energy) energy = v;
    };

    let elapsed = Math.random() * 100;
    let last = 0;

    const wave = (t: number, phase: number, ampBase: number, freq: number, yBase: number, alpha: number) => {
      const amp = ampBase * (0.55 + energy * 0.9);
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let x = 0; x <= width; x += 8) {
        const y =
          yBase +
          Math.sin(x * freq + t * 0.9 + phase) * amp +
          Math.sin(x * freq * 2.3 + t * 1.4 + phase) * amp * 0.32;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, width, 0);
      g.addColorStop(0, `rgba(76,125,255,${alpha})`);
      g.addColorStop(0.5, `rgba(110,110,247,${alpha})`);
      g.addColorStop(1, `rgba(16,179,163,${alpha})`);
      ctx.fillStyle = g;
      ctx.fill();
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, width, height);
      if (flip) {
        ctx.save();
        ctx.translate(0, height);
        ctx.scale(1, -1);
      }
      wave(t, 0, height * 0.16, 0.012, height * 0.5, 0.05);
      wave(t, 2.1, height * 0.12, 0.017, height * 0.62, 0.06);
      if (flip) ctx.restore();
    };

    const running = () => inView && pageVisible && !reduced;
    const frame = (now: number) => {
      if (last === 0) last = now;
      elapsed += Math.min(0.05, (now - last) / 1000);
      last = now;
      energy += (0 - energy) * 0.04; // decay toward calm
      draw(elapsed);
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
        if (reduced) draw(elapsed);
      }
    };

    const resize = () => {
      const rect = root.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      if (width <= 0 || height <= 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(elapsed);
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
      { rootMargin: "120px" },
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
    window.addEventListener("scroll", onScroll, { passive: true });

    sync();

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      rm.removeEventListener("change", onReducedChange);
      window.removeEventListener("scroll", onScroll);
    };
  }, [flip]);

  return (
    <div
      ref={rootRef}
      aria-hidden
      className={cn("pointer-events-none relative h-16 w-full overflow-hidden md:h-24", className)}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
