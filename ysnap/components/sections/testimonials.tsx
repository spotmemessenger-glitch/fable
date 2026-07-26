"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/cn";
import { EASE, fadeRise, viewportOnce } from "@/lib/motion";
import { Section, SectionHeading } from "@/components/ui/section";

/* ------------------------------------------------------------------ data */

type Testimonial = {
  name: string;
  role: string;
  quote: string;
  accent?: boolean;
  /** Avatar hue chip classes — one spectrum hue per testimonial. */
  chip: string;
};

/** Spectrum cycle: one hue per avatar, never mixed within a card. */
const CHIP_HUES = [
  "bg-accent/[0.12] text-accent-deep",
  "bg-teal/[0.12] text-teal",
  "bg-coral/[0.12] text-coral",
  "bg-violet/[0.12] text-violet",
  "bg-amber/[0.12] text-amber",
  "bg-green/[0.12] text-green",
  "bg-rose/[0.12] text-rose",
] as const;

const RAW_TESTIMONIALS: Omit<Testimonial, "chip">[] = [
  {
    name: "Amara Diallo",
    role: "Travel blogger",
    quote:
      "Pointed my camera at a handwritten menu in Hanoi and ordered like a regular. The waitress asked how long I'd lived there.",
  },
  {
    name: "Jonas Weber",
    role: "Exchange student",
    quote:
      "My professor in Kyoto talks fast. Live captions keep up, and after class I get the transcript in German and Japanese side by side.",
  },
  {
    name: "Priya Nair",
    role: "ICU nurse",
    accent: true,
    quote:
      "A patient's father only spoke Malayalam. Voice mode carried the whole admission conversation — nobody had to wait an hour for a phone interpreter.",
  },
  {
    name: "Marco Esposito",
    role: "Chef",
    quote:
      "Scanned a dosa in Bangalore and had the calories before the chutney arrived. I use the food mode on every research trip now.",
  },
  {
    name: "Lena Fischer",
    role: "Founder",
    quote:
      "Our support inbox arrives in eleven languages. My co-founder and I answer all of it ourselves, and customers assume we have a big team.",
  },
  {
    name: "Sofia Reyes",
    role: "Language teacher",
    quote:
      "My students record themselves and compare against the voice playback. The ones who used to mumble through their R sounds now correct each other.",
  },
  {
    name: "Tomasz Kowalski",
    role: "Hiker",
    quote:
      "Twelve days on the Camino with the offline pack. It read trail signs, a pharmacy label and one very stern farmer's fence notice without a bar of signal.",
  },
  {
    name: "Hanna Park",
    role: "Expat parent",
    accent: true,
    quote:
      "School letters used to pile up unread on our fridge in Lyon. Now I scan them at the gate and reply to the teacher before pickup.",
  },
  {
    name: "Alistair Finch",
    role: "Numismatist",
    quote:
      "The coin scanner identified a worn 1923 Weimar 500-mark piece my loupe and I had argued about for a week. Mint mark, metal, the lot.",
  },
];

const TESTIMONIALS: Testimonial[] = RAW_TESTIMONIALS.map((testimonial, i) => ({
  ...testimonial,
  chip: CHIP_HUES[i % CHIP_HUES.length],
}));

/* Two cards per column. Desktop shows all three columns (6 reviews); tablet
   and mobile collapse to the first column only (2 reviews). */
const COLUMNS: Testimonial[][] = [
  TESTIMONIALS.slice(0, 2),
  TESTIMONIALS.slice(2, 4),
  TESTIMONIALS.slice(4, 6),
];

/* ------------------------------------------------------------------ card */

function initialsOf(name: string): string {
  return name
    .split(" ")
    .map((word) => word[0])
    .slice(0, 2)
    .join("");
}

function TestimonialCard({ testimonial }: { testimonial: Testimonial }) {
  const [expanded, setExpanded] = useState(false);
  /** True only when the collapsed quote is actually truncated — the trigger
      is hidden otherwise so short quotes never show a pointless "Read more". */
  const [truncated, setTruncated] = useState(false);
  const quoteRef = useRef<HTMLQuoteElement>(null);

  useEffect(() => {
    const el = quoteRef.current;
    if (!el || expanded) return; // clamp is off while expanded — nothing to measure
    const measure = () => setTruncated(el.scrollHeight > el.clientHeight + 1);
    measure();
    /* On first page load the mount measurement runs before the web fonts
       finish swapping, when the quote still fits in 3 lines — re-measure once
       fonts settle so the reflow that pushes it to 4 lines is caught. */
    document.fonts?.ready.then(measure).catch(() => {});
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [expanded]);

  const showToggle = truncated || expanded;

  return (
    <figure
      className={cn(
        /* Fixed height while collapsed gives every card the same footprint;
           expanding drops to auto so only the opened card grows. mt-auto pins
           the caption to the bottom edge regardless of quote length. */
        "flex flex-col rounded-card border border-hairline bg-surface p-5 shadow-soft",
        !expanded && "h-[12rem]",
        testimonial.accent && "border-accent/20 bg-accent/[0.04]",
      )}
    >
      <blockquote
        ref={quoteRef}
        className={cn(
          "text-[15px] leading-relaxed text-ink-soft",
          !expanded && "line-clamp-3",
        )}
      >
        {testimonial.quote}
      </blockquote>

      {showToggle ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-2 cursor-pointer self-start text-[13px] font-medium text-accent-deep underline-offset-4 transition-colors duration-200 hover:text-accent hover:underline"
        >
          {expanded ? "Read less" : "Read more"}
        </button>
      ) : null}

      <figcaption className="mt-auto flex items-center gap-3 pt-4">
        <span
          aria-hidden
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
            testimonial.chip,
          )}
        >
          {initialsOf(testimonial.name)}
        </span>
        <span className="flex flex-col">
          <span className="text-sm font-medium text-faint">{testimonial.name}</span>
          <span className="text-xs text-faint">{testimonial.role}</span>
        </span>
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------ section */

export default function Testimonials() {
  return (
    <Section id="testimonials" tone="canvas" className="md:!py-24">
      <div className="shell">
        <SectionHeading
          eyebrow="Loved worldwide"
          title={
            <>
              People stopped translating.{" "}
              <span className="text-gradient">They started talking.</span>
            </>
          }
        />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {COLUMNS.map((column, c) => (
            <div
              key={c}
              className={cn(
                "flex flex-col gap-4",
                /* Only the first column is shown below md — 2 reviews on
                   tablet/mobile, all 6 on desktop. */
                c > 0 && "hidden md:flex",
              )}
            >
              {column.map((testimonial, row) => (
                /* Per-card entrance mirrors the site's Reveal (fade + rise +
                   un-blur), swept diagonally by index. `layout` eases the
                   height change when a card expands and slides the card below
                   it down instead of snapping — both gated by the global
                   MotionConfig reducedMotion="user". */
                <motion.div
                  key={testimonial.name}
                  layout
                  variants={fadeRise}
                  initial="hidden"
                  whileInView="visible"
                  viewport={viewportOnce}
                  transition={{
                    duration: 0.8,
                    ease: EASE,
                    delay: (c * 2 + row) * 0.06,
                    layout: { duration: 0.42, ease: EASE },
                  }}
                >
                  <TestimonialCard testimonial={testimonial} />
                </motion.div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}
