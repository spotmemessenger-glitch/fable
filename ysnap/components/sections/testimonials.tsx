"use client";

import { useRef, useSyncExternalStore } from "react";
import {
  motion,
  useAnimationFrame,
  useInView,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "framer-motion";
import { cn } from "@/lib/cn";
import { Section, SectionHeading } from "@/components/ui/section";
import { Reveal } from "@/components/ui/reveal";

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

const COLUMN_DURATIONS = [38, 46, 42] as const;

const VERTICAL_MASK: React.CSSProperties = {
  maskImage: "linear-gradient(to bottom, transparent, black 12%, black 88%, transparent)",
  WebkitMaskImage: "linear-gradient(to bottom, transparent, black 12%, black 88%, transparent)",
};

/* ------------------------------------------------------------------ hooks */

const DESKTOP_QUERY = "(min-width: 768px)";

function subscribeToDesktop(onChange: () => void): () => void {
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** True on md+ viewports; false on the server and below 768px. */
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribeToDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}

/* ------------------------------------------------------------------ card */

function initialsOf(name: string): string {
  return name
    .split(" ")
    .map((word) => word[0])
    .slice(0, 2)
    .join("");
}

function TestimonialCard({ testimonial }: { testimonial: Testimonial }) {
  return (
    <figure
      className={cn(
        "rounded-card border border-hairline bg-surface p-6 shadow-soft",
        testimonial.accent && "border-accent/20 bg-accent/[0.04]",
      )}
    >
      <blockquote className="text-[15px] leading-relaxed text-ink-soft">
        {testimonial.quote}
      </blockquote>
      <figcaption className="mt-5 flex items-center gap-3">
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

/* ------------------------------------------------------------------ marquee column */

function MarqueeColumn({
  items,
  duration,
  reversed = false,
  active = true,
}: {
  items: Testimonial[];
  duration: number;
  reversed?: boolean;
  /** False while the section is offscreen — freezes the frame loop. */
  active?: boolean;
}) {
  const reduce = useReducedMotion();
  const paused = useRef(false);
  /** Progress through one loop period, in percent of track height: 0 → 50. */
  const progress = useMotionValue(0);
  const y = useTransform(progress, (v) => `${-v}%`);

  useAnimationFrame((_, delta) => {
    if (reduce || !active || paused.current) return;
    const step = (delta / 1000) * (50 / duration);
    let next = progress.get() + (reversed ? -step : step);
    next = ((next % 50) + 50) % 50;
    progress.set(next);
  });

  if (reduce) {
    return (
      <div className="flex h-[560px] flex-col gap-4 overflow-hidden" style={VERTICAL_MASK}>
        {items.map((testimonial) => (
          <TestimonialCard key={testimonial.name} testimonial={testimonial} />
        ))}
      </div>
    );
  }

  return (
    <div
      className="h-[560px] overflow-hidden"
      style={VERTICAL_MASK}
      onMouseEnter={() => {
        paused.current = true;
      }}
      onMouseLeave={() => {
        paused.current = false;
      }}
      onFocus={() => {
        paused.current = true;
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          paused.current = false;
        }
      }}
    >
      {/* Content duplicated once; translating by -50% of the track = one seamless period. */}
      <motion.div style={{ y }} className="flex flex-col">
        {[...items, ...items].map((testimonial, i) => (
          <div
            key={`${testimonial.name}-${i}`}
            className="pb-4"
            aria-hidden={i >= items.length || undefined}
          >
            <TestimonialCard testimonial={testimonial} />
          </div>
        ))}
      </motion.div>
    </div>
  );
}

/* ------------------------------------------------------------------ section */

export default function Testimonials() {
  const isDesktop = useIsDesktop();
  const gridRef = useRef<HTMLDivElement>(null);
  const inView = useInView(gridRef);

  const columns: Testimonial[][] = [
    TESTIMONIALS.slice(0, 3),
    TESTIMONIALS.slice(3, 6),
    TESTIMONIALS.slice(6, 9),
  ];

  return (
    <Section id="testimonials" tone="canvas">
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

        {/* Desktop — three vertical marquee columns (not rendered below md) */}
        <Reveal className="hidden md:block">
          <div ref={gridRef} className="hidden md:grid md:grid-cols-3 md:gap-4">
            {isDesktop &&
              columns.map((column, i) => (
                <MarqueeColumn
                  key={i}
                  items={column}
                  duration={COLUMN_DURATIONS[i]}
                  reversed={i === 1}
                  active={inView}
                />
              ))}
          </div>
        </Reveal>

        {/* Mobile — first three quotes, static */}
        <div className="flex flex-col gap-4 md:hidden">
          {TESTIMONIALS.slice(0, 3).map((testimonial, i) => (
            <Reveal key={testimonial.name} delay={i * 0.08}>
              <TestimonialCard testimonial={testimonial} />
            </Reveal>
          ))}
        </div>
      </div>
    </Section>
  );
}
