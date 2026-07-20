import type { Variants, Transition } from "framer-motion";

/** House easing — every entrance on the site uses this curve. */
export const EASE: Transition["ease"] = [0.22, 1, 0.36, 1];

export const spring: Transition = { type: "spring", stiffness: 260, damping: 28 };

/** Standard entrance: rise + fade + un-blur. */
export const fadeRise: Variants = {
  hidden: { opacity: 0, y: 24, filter: "blur(6px)" },
  visible: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.8, ease: EASE },
  },
};

/** Parent container that staggers its children. */
export const stagger = (delayChildren = 0, staggerChildren = 0.08): Variants => ({
  hidden: {},
  visible: { transition: { delayChildren, staggerChildren } },
});

/** Soft scale-in used for cards and media. */
export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: 16 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { duration: 0.9, ease: EASE },
  },
};

/**
 * Default viewport config: animate once, as soon as the element is ~80px into
 * the viewport. Margin-based (not fraction-based) so tall elements still fire
 * on short viewports — a 30%-visible threshold can never be met by a block
 * taller than ~3x the viewport.
 */
export const viewportOnce = { once: true, amount: "some", margin: "0px 0px -80px 0px" } as const;
