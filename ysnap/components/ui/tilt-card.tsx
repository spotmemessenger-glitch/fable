"use client";

import { useRef, type ReactNode, type PointerEvent } from "react";
import { motion, useMotionValue, useSpring, useTransform, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";

/**
 * Mouse-tracking 3D tilt with a moving sheen. Depth stays shallow (±6°)
 * so cards feel like physical glass, never like a game.
 */
export function TiltCard({
  children,
  className,
  maxTilt = 6,
}: {
  children: ReactNode;
  className?: string;
  maxTilt?: number;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);

  const rotateX = useSpring(useTransform(py, [0, 1], [maxTilt, -maxTilt]), {
    stiffness: 220,
    damping: 24,
  });
  const rotateY = useSpring(useTransform(px, [0, 1], [-maxTilt, maxTilt]), {
    stiffness: 220,
    damping: 24,
  });
  const sheenX = useTransform(px, [0, 1], ["20%", "80%"]);
  const sheenY = useTransform(py, [0, 1], ["20%", "80%"]);

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (reduce || e.pointerType !== "mouse" || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    px.set((e.clientX - rect.left) / rect.width);
    py.set((e.clientY - rect.top) / rect.height);
  };

  const onPointerLeave = () => {
    px.set(0.5);
    py.set(0.5);
  };

  return (
    <motion.div
      ref={ref}
      className={cn("group relative [transform-style:preserve-3d]", className)}
      style={{ rotateX: reduce ? 0 : rotateX, rotateY: reduce ? 0 : rotateY, perspective: 1000 }}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerCancel={onPointerLeave}
    >
      {children}
      {/* sheen that follows the cursor — fine pointers only, so a tap's sticky
          :hover can never leave it pinned on touch screens */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-500 pointer-fine:group-hover:opacity-100"
        style={{
          background: useTransform(
            [sheenX, sheenY],
            ([sx, sy]) =>
              `radial-gradient(280px circle at ${sx} ${sy}, rgb(255 255 255 / 0.55), transparent 65%)`,
          ),
        }}
      />
    </motion.div>
  );
}
