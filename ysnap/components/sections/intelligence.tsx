import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Section, SectionHeading } from "@/components/ui/section";
import { Reveal } from "@/components/ui/reveal";
import { GlobeIcon } from "@/components/ui/icons";
import NeuralBrainBanner from "@/components/sections/neural-brain-banner";

/* ------------------------------------------------------------------ data */

type Sense = {
  name: string;
  blurb: string; // six-word descriptor
  icon: ReactNode;
  /** hue classes for the icon chip — one hue per sense */
  chip: string;
};

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const SENSES: Sense[] = [
  {
    name: "Vision AI",
    blurb: "Reads scenes, text and objects instantly",
    chip: "bg-teal/10 text-teal",
    icon: (
      <svg {...iconProps} className="h-[18px] w-[18px]" aria-hidden>
        <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z" />
        <circle cx="12" cy="12" r="2.75" />
      </svg>
    ),
  },
  {
    name: "Language AI",
    blurb: "Translates 120+ languages with native fluency",
    chip: "bg-accent/10 text-accent",
    icon: <GlobeIcon className="h-[18px] w-[18px]" />,
  },
  {
    name: "Voice AI",
    blurb: "Hears, understands and speaks like you",
    chip: "bg-violet/10 text-violet",
    icon: (
      <svg {...iconProps} className="h-[18px] w-[18px]" aria-hidden>
        <path d="M4 10v4" />
        <path d="M8 7v10" />
        <path d="M12 4v16" />
        <path d="M16 7v10" />
        <path d="M20 10v4" />
      </svg>
    ),
  },
  {
    name: "Cloud AI",
    blurb: "Deep reasoning served under 200 ms",
    chip: "bg-amber/10 text-amber",
    icon: (
      <svg {...iconProps} className="h-[18px] w-[18px]" aria-hidden>
        <path d="M6.5 18a4 4 0 0 1-.55-7.96 6 6 0 0 1 11.7 1.06A3.6 3.6 0 0 1 17.4 18H6.5Z" />
      </svg>
    ),
  },
  {
    name: "On-device AI",
    blurb: "Private, offline and always within reach",
    chip: "bg-green/10 text-green",
    icon: (
      <svg {...iconProps} className="h-[18px] w-[18px]" aria-hidden>
        <rect x="7" y="7" width="10" height="10" rx="2" />
        <path d="M9 3v2.5M15 3v2.5M9 18.5V21M15 18.5V21M3 9h2.5M3 15h2.5M18.5 9H21M18.5 15H21" />
        <rect x="10.5" y="10.5" width="3" height="3" rx="0.75" />
      </svg>
    ),
  },
];

/* --------------------------------------------------------------- section */

export default function Intelligence() {
  return (
    <Section id="intelligence" tone="surface">
      <div className="shell">
        <SectionHeading
          eyebrow="Intelligence"
          title={
            <>
              One mind. <span className="text-gradient">Five senses.</span>
            </>
          }
          description="Vision, language, voice, cloud and on-device models don't take turns — they reason together. Every answer draws on all five at once."
        />

        <Reveal>
          <NeuralBrainBanner />
        </Reveal>

        <ul className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:mt-8 md:grid-cols-5 md:gap-4">
          {SENSES.map((sense, i) => (
            <Reveal
              as="li"
              key={sense.name}
              delay={0.08 * i}
              className={cn(
                "group rounded-card border border-hairline bg-surface p-4 shadow-soft transition-all duration-300 hover:-translate-y-1 hover:shadow-lift",
                i === 4 && "col-span-2 sm:col-span-1",
              )}
            >
              <span className={cn("flex h-9 w-9 items-center justify-center rounded-xl", sense.chip)}>
                {sense.icon}
              </span>
              <h3 className="mt-3 text-sm font-medium tracking-normal text-ink">
                {sense.name}
              </h3>
              <p className="mt-1 text-[13px] leading-snug text-faint">
                {sense.blurb}
              </p>
            </Reveal>
          ))}
        </ul>
      </div>
    </Section>
  );
}
