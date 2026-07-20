"use client";

import { useRef, type CSSProperties } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import { cn } from "@/lib/cn";

/**
 * Ambient glow that drifts gently counter to scroll so it reads as atmosphere
 * rather than paint. Glows are the furthest depth layer, so they move the
 * least — keep `distance` under ~32px or the depth stack inverts.
 *
 * Drop-in replacement for the static `radial-gradient` glow divs: pass the
 * exact same className / inline background style.
 */
export function ParallaxGlow({
  className,
  style,
  distance = 28,
}: {
  className?: string;
  style?: CSSProperties;
  distance?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
  const y = useTransform(scrollYProgress, [0, 1], [distance, -distance]);

  if (reduce) {
    return (
      <div
        ref={ref}
        aria-hidden
        className={cn("pointer-events-none", className)}
        style={style}
      />
    );
  }

  return (
    <motion.div
      ref={ref}
      aria-hidden
      className={cn("pointer-events-none", className)}
      style={{ ...style, y }}
    />
  );
}
