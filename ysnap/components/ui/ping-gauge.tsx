"use client";

import { useEffect, useRef } from "react";
import { useInView, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";

/**
 * Speed-test ping gauge — a live latency trace that, when scrolled into view,
 * spikes fast to ~180 ms and settles, leaving a fading light-trail behind the
 * marker. The numeric readout ticks with it. One-shot; static under reduced
 * motion. Canvas keeps the trail crisp without per-frame React renders.
 */

const TARGET = 182; // ms — settle point (the "< 200 ms" promise, measured)
const SCALE_MAX = 260; // ms mapped to the right edge

export default function PingGauge({ className }: { className?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const inView = useInView(wrapRef, { once: true, amount: 0.5 });
  const reduce = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    const readout = readoutRef.current;
    if (!inView || !canvas || !readout) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    const trail: { x: number; life: number }[] = [];

    const size = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();

    const midY = () => height / 2;
    const msToX = (ms: number) => (Math.min(ms, SCALE_MAX) / SCALE_MAX) * width;

    const drawTrack = () => {
      ctx.clearRect(0, 0, width, height);
      const y = midY();
      /* base rail */
      ctx.strokeStyle = "rgba(11,12,14,0.06)";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(3, y);
      ctx.lineTo(width - 3, y);
      ctx.stroke();
      /* 200 ms threshold tick */
      const tx = msToX(200);
      ctx.strokeStyle = "rgba(11,12,14,0.14)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tx, y - 8);
      ctx.lineTo(tx, y + 8);
      ctx.stroke();
    };

    if (reduce) {
      drawTrack();
      const y = midY();
      const x = msToX(TARGET);
      ctx.fillStyle = "#4c7dff";
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      readout.textContent = `${TARGET} ms`;
      return;
    }

    let raf = 0;
    const start = performance.now();
    const DURATION = 1500;

    /* ease: overshoot toward ~205ms then settle to TARGET (ping "spike") */
    const curve = (t: number) => {
      if (t < 0.42) return (t / 0.42) * 205; // fast rush up past target
      const k = (t - 0.42) / 0.58;
      const settle = 1 - Math.pow(1 - k, 3);
      return 205 + (TARGET - 205) * settle;
    };

    const tick = (now: number) => {
      const t = Math.min((now - start) / DURATION, 1);
      const ms = curve(t);
      const x = msToX(ms);
      const y = midY();

      drawTrack();

      /* light-trail: sample points fade out behind the marker */
      trail.push({ x, life: 1 });
      if (trail.length > 46) trail.shift();
      for (const p of trail) {
        p.life *= 0.9;
        const warm = ms > 200;
        const col = warm ? "245,158,11" : "76,125,255";
        ctx.strokeStyle = `rgba(${col},${(p.life * 0.5).toFixed(3)})`;
        ctx.lineWidth = 2 + p.life * 2.5;
        ctx.beginPath();
        ctx.moveTo(p.x, y);
        ctx.lineTo(x, y);
        ctx.stroke();
      }

      /* active fill from origin to marker */
      const grad = ctx.createLinearGradient(0, 0, x, 0);
      grad.addColorStop(0, "rgba(76,125,255,0.35)");
      grad.addColorStop(1, "rgba(110,110,247,0.9)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(3, y);
      ctx.lineTo(x, y);
      ctx.stroke();

      /* marker */
      ctx.fillStyle = ms > 200 ? "#f59e0b" : "#4c7dff";
      ctx.shadowColor = ms > 200 ? "rgba(245,158,11,0.6)" : "rgba(76,125,255,0.6)";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      readout.textContent = `${Math.round(ms)} ms`;

      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(() => size());
    ro.observe(canvas);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [inView, reduce]);

  return (
    <div
      ref={wrapRef}
      className={cn(
        "mx-auto mt-14 flex max-w-xl flex-col gap-3 rounded-card border border-hairline bg-surface/70 px-6 py-5 shadow-soft",
        className,
      )}
    >
      <div className="flex items-baseline justify-between">
        <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-faint">
          <span className="relative flex h-1.5 w-1.5" aria-hidden>
            <span className="animate-pulse-ring absolute inset-0 rounded-full bg-accent" />
            <span className="relative h-1.5 w-1.5 rounded-full bg-accent" />
          </span>
          Live latency
        </span>
        <span
          ref={readoutRef}
          className="font-display text-lg font-medium tabular-nums text-ink"
          aria-hidden
        >
          182 ms
        </span>
      </div>
      <canvas ref={canvasRef} className="h-8 w-full" />
      <div className="flex justify-between text-[10px] tabular-nums text-faint">
        <span>0</span>
        <span>200 ms budget</span>
        <span>260</span>
      </div>
    </div>
  );
}
