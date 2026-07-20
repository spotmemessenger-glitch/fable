"use client";

import { motion } from "framer-motion";
import { Section, SectionHeading } from "@/components/ui/section";
import { Counter } from "@/components/ui/counter";
import { Reveal } from "@/components/ui/reveal";
import PingGauge from "@/components/ui/ping-gauge";
import { fadeRise, stagger, viewportOnce } from "@/lib/motion";

/* ------------------------------------------------------------------ data */

type Stat = {
  to: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  label: string;
  /** Hue tick class — one spectrum hue per stat; numerals stay ink. */
  tick: string;
};

const STATS: Stat[] = [
  { to: 120, suffix: "+", label: "Languages", tick: "bg-accent" },
  { to: 2, suffix: "B+", label: "Translations", tick: "bg-teal" },
  { to: 200, prefix: "<", suffix: "ms", label: "Avg response", tick: "bg-violet" },
  { to: 99.2, decimals: 1, suffix: "%", label: "Accuracy", tick: "bg-coral" },
];

/* ------------------------------------------------------------------ section */

export default function PerformanceStats() {
  return (
    <Section id="performance" tone="surface">
      <div className="shell">
        <SectionHeading
          eyebrow="Performance"
          title={
            <>
              Instant, <span className="text-gradient">everywhere.</span>
            </>
          }
        />

        <motion.div
          variants={stagger(0.1, 0.08)}
          initial="hidden"
          whileInView="visible"
          viewport={viewportOnce}
          className="grid grid-cols-2 gap-y-12 md:grid-cols-4 md:gap-y-0 md:divide-x md:divide-hairline"
        >
          {STATS.map((stat) => (
            <motion.div
              key={stat.label}
              variants={fadeRise}
              className="flex flex-col items-center px-4 text-center md:px-6"
            >
              <Counter
                to={stat.to}
                prefix={stat.prefix}
                suffix={stat.suffix}
                decimals={stat.decimals}
                className="font-display text-5xl font-medium tabular-nums text-ink md:text-6xl"
              />
              <span aria-hidden className={`mt-4 h-1 w-6 rounded-full ${stat.tick}`} />
              <span className="mt-3 text-xs tracking-[0.18em] text-faint uppercase">
                {stat.label}
              </span>
            </motion.div>
          ))}
        </motion.div>

        <Reveal delay={0.2}>
          <PingGauge />
        </Reveal>

        <Reveal delay={0.25}>
          <p className="mt-10 text-center text-sm text-faint">
            Benchmarked on everyday devices, not lab hardware.
          </p>
        </Reveal>
      </div>
    </Section>
  );
}
