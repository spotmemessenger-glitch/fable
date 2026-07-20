"use client";

import { useEffect, type ReactNode } from "react";
import Lenis from "lenis";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { MotionConfig } from "framer-motion";

/**
 * Site-wide cinematic scrolling: Lenis drives the scroll position and GSAP's
 * ticker drives Lenis, so ScrollTrigger animations stay perfectly in sync.
 * Disabled entirely for users who prefer reduced motion.
 *
 * The wrapping MotionConfig reducedMotion="user" makes EVERY Framer Motion
 * component honour prefers-reduced-motion — including entrance primitives like
 * Reveal that don't check useReducedMotion themselves — since the global CSS
 * reduced-motion block cannot reach Framer's JS-driven transform/filter tweens.
 */
export default function SmoothScroll({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    gsap.registerPlugin(ScrollTrigger);

    const lenis = new Lenis({
      duration: 1.15,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      touchMultiplier: 1.5,
      anchors: true,
    });

    lenis.on("scroll", ScrollTrigger.update);

    const raf = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(raf);
    gsap.ticker.lagSmoothing(0);

    return () => {
      gsap.ticker.remove(raf);
      lenis.destroy();
    };
  }, []);

  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
