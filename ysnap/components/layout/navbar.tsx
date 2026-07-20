"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion, useScroll } from "framer-motion";
import { Logo } from "@/components/ui/logo";
import { ButtonLink } from "@/components/ui/button";
import { navLinks } from "@/lib/site";
import { cn } from "@/lib/cn";
import { EASE, spring } from "@/lib/motion";

/**
 * Sticky navigation: transparent over the hero, condensing into a floating
 * frosted-glass pill once the page scrolls.
 */
export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const reduce = useReducedMotion();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const { scrollYProgress } = useScroll();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // scroll-spy: highlight the nav link whose section is in the reading band
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveSection("#" + entry.target.id);
        }
      },
      { rootMargin: "-40% 0px -55% 0px" },
    );
    for (const link of navLinks) {
      const el = document.querySelector(link.href);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  // lock body scroll while the mobile menu is open
  useEffect(() => {
    document.documentElement.style.overflow = open ? "hidden" : "";
    return () => {
      document.documentElement.style.overflow = "";
    };
  }, [open]);

  // close the mobile menu on Escape and return focus to the toggle
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <header className="fixed inset-x-0 top-0 z-50">
      <div
        className={cn(
          "relative mx-auto flex items-center justify-between transition-all duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
          scrolled
            ? "mt-3 h-14 max-w-4xl rounded-full px-4 glass"
            : "mt-0 h-20 max-w-7xl bg-transparent px-6",
        )}
      >
        <a
          href="#top"
          aria-label="YSNAP home"
          className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent"
        >
          <Logo />
        </a>

        {/* desktop links */}
        <nav
          aria-label="Primary"
          className="hidden items-center gap-1 lg:flex"
          onMouseLeave={() => setHovered(null)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHovered(null);
          }}
        >
          {navLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onMouseEnter={() => setHovered(link.href)}
              onFocus={() => setHovered(link.href)}
              aria-current={activeSection === link.href ? "true" : undefined}
              className={cn(
                "relative rounded-full px-3.5 py-2 text-[15px] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
                activeSection === link.href ? "text-ink" : "text-muted hover:text-ink",
              )}
            >
              {hovered === link.href && (
                <motion.span
                  layoutId="nav-hover"
                  aria-hidden
                  className="absolute inset-0 rounded-full bg-ink/5"
                  transition={reduce ? { duration: 0 } : spring}
                />
              )}
              <span className="relative z-10">{link.label}</span>
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          <ButtonLink href="#download" size="md" className={cn(scrolled && "h-10 px-5")}>
            Download App
          </ButtonLink>
        </div>

        {/* mobile toggle */}
        <button
          ref={toggleRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          className="grid h-11 w-11 cursor-pointer place-items-center rounded-full lg:hidden"
        >
          <span className="relative block h-3.5 w-5" aria-hidden>
            <span
              className={cn(
                "absolute left-0 top-0 h-[1.5px] w-full bg-ink transition-all duration-300",
                open && "top-1/2 -translate-y-1/2 rotate-45",
              )}
            />
            <span
              className={cn(
                "absolute bottom-0 left-0 h-[1.5px] w-full bg-ink transition-all duration-300",
                open && "bottom-1/2 translate-y-1/2 -rotate-45",
              )}
            />
          </span>
        </button>

        {/* reading-progress hairline, visible once the nav condenses into the pill */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-6 bottom-0 h-px overflow-hidden rounded-full bg-ink/[0.05] transition-opacity duration-500",
            !scrolled && "opacity-0",
          )}
        >
          <motion.div
            className="h-full w-full origin-left bg-accent/60"
            style={{ scaleX: scrollYProgress }}
          />
        </div>
      </div>

      {/* mobile menu */}
      <AnimatePresence>
        {open && (
          <motion.nav
            id="mobile-menu"
            aria-label="Mobile"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -12 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="glass mx-3 mt-2 rounded-[1.75rem] p-3 lg:hidden"
          >
            <ul className="flex flex-col">
              {navLinks.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    onClick={() => setOpen(false)}
                    className="block rounded-2xl px-4 py-3.5 text-lg font-medium text-ink transition-colors hover:bg-ink/5"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
              <li className="p-2 pt-3">
                <ButtonLink href="#download" onClick={() => setOpen(false)} className="w-full">
                  Download App
                </ButtonLink>
              </li>
            </ul>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  );
}
