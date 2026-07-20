"use client";

import { motion, useTransform, type MotionValue } from "framer-motion";

/**
 * Floating glass 3D ornaments for the hero — a glassmorphic speech bubble with
 * living soundwaves, a metallic camera-lens puck, and two gradient orbs.
 * All pointer-events-none and lg-only so mid-size layouts stay uncluttered.
 * Each drifts upward at its own rate on scroll (same scrub pattern as the chips).
 */
export function HeroOrnaments({
  progress,
  reduce,
}: {
  progress: MotionValue<number>;
  reduce: boolean;
}) {
  const yBubble = useTransform(progress, [0, 1], [0, -76]);
  const yLens = useTransform(progress, [0, 1], [0, -108]);
  const yOrbA = useTransform(progress, [0, 1], [0, -52]);
  const yOrbB = useTransform(progress, [0, 1], [0, -92]);

  const HEIGHTS = [0.45, 0.8, 0.6, 1, 0.5, 0.78, 0.35];

  return (
    <>
      {/* speech bubble with glowing soundwaves — Voice AI made tactile */}
      <motion.div
        className="pointer-events-none absolute hidden lg:block lg:left-[10%] lg:top-[30%]"
        style={reduce ? undefined : { y: yBubble }}
      >
        <div className="glass animate-floaty relative rounded-2xl px-4 pb-3 pt-3.5" style={{ animationDelay: "0.9s" }}>
          <div className="flex h-8 items-end gap-1">
            {HEIGHTS.map((h, i) => (
              <span
                key={i}
                className="animate-soundwave w-[3px] rounded-full bg-gradient-to-t from-violet to-accent"
                style={{
                  height: `${Math.round(h * 100)}%`,
                  animationDelay: `${(i * 0.13).toFixed(2)}s`,
                  boxShadow: "0 0 8px rgb(110 110 247 / 0.35)",
                }}
              />
            ))}
          </div>
          <span
            aria-hidden
            className="absolute -bottom-1.5 left-6 h-3 w-3 rotate-45 rounded-[3px] border-b border-r border-white/65 bg-white/70"
          />
        </div>
      </motion.div>

      {/* metallic camera-lens puck — AI Camera */}
      <motion.div
        className="pointer-events-none absolute hidden lg:block lg:right-[8%] lg:top-[40%]"
        style={reduce ? undefined : { y: yLens }}
      >
        <div className="glass animate-floaty flex h-20 w-20 items-center justify-center rounded-full" style={{ animationDelay: "2.1s" }}>
          <div
            className="relative h-14 w-14 rounded-full"
            style={{
              background:
                "conic-gradient(from 210deg, #dfe3ea, #b6bdc9, #f2f4f8, #c4cad5, #dfe3ea)",
              boxShadow: "0 6px 18px rgb(11 12 14 / 0.14)",
            }}
          >
            <div
              className="absolute inset-[5px] rounded-full"
              style={{
                background:
                  "radial-gradient(circle at 35% 30%, #7fd4c9 0%, #10b3a3 34%, #0b6e88 68%, #083344 100%)",
              }}
            />
            <div
              className="absolute inset-[5px] rounded-full"
              style={{
                background:
                  "radial-gradient(circle at 32% 28%, rgb(255 255 255 / 0.6), transparent 42%)",
              }}
            />
          </div>
        </div>
      </motion.div>

      {/* gradient orbs — soft geometry filling the lower corners */}
      <motion.div
        className="pointer-events-none absolute hidden lg:block lg:left-[16%] lg:top-[76%]"
        style={reduce ? undefined : { y: yOrbA }}
      >
        <div
          className="animate-floaty h-12 w-12 rounded-full"
          style={{
            animationDelay: "3.8s",
            background:
              "radial-gradient(circle at 32% 30%, #ffffff 0%, #aab8ff 26%, #6e6ef7 68%, #4c56c9 100%)",
            boxShadow:
              "0 18px 40px rgb(110 110 247 / 0.28), inset 0 -6px 14px rgb(255 255 255 / 0.35)",
          }}
        />
      </motion.div>
      <motion.div
        className="pointer-events-none absolute hidden lg:block lg:right-[18%] lg:top-[73%]"
        style={reduce ? undefined : { y: yOrbB }}
      >
        <div
          className="animate-floaty h-7 w-7 rounded-full"
          style={{
            animationDelay: "5.2s",
            background:
              "radial-gradient(circle at 34% 30%, #fff3dd 0%, #ffd28a 30%, #f59e0b 72%, #c67a06 100%)",
            boxShadow:
              "0 12px 28px rgb(245 158 11 / 0.3), inset 0 -4px 10px rgb(255 255 255 / 0.4)",
          }}
        />
      </motion.div>
    </>
  );
}
