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
    /* Always open on the first section (hero). "auto" scroll restoration was
       dropping refreshes mid-page (into the demo). Manual restoration alone
       isn't enough on iOS Safari, which restores scroll from the back/forward
       cache regardless — so we ALSO force the top on `pageshow` (fires on every
       load AND on bfcache restore). Runs for everyone, motion or not. */
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";

    let lenis: Lenis | null = null;
    const toTop = () => {
      window.scrollTo(0, 0);
      lenis?.scrollTo(0, { immediate: true });
    };
    toTop();
    window.addEventListener("pageshow", toTop);

    let raf: ((time: number) => void) | null = null;
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      gsap.registerPlugin(ScrollTrigger);

      lenis = new Lenis({
        duration: 1.15,
        easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        touchMultiplier: 1.5,
        anchors: true,
      });
      lenis.scrollTo(0, { immediate: true });
      lenis.on("scroll", ScrollTrigger.update);

      const tick = (time: number) => lenis!.raf(time * 1000);
      raf = tick;
      gsap.ticker.add(tick);
      gsap.ticker.lagSmoothing(0);
    }

    return () => {
      window.removeEventListener("pageshow", toTop);
      if (raf) gsap.ticker.remove(raf);
      lenis?.destroy();
    };
  }, []);

  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
