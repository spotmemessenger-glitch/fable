"use client";

import type { CSSProperties, ReactNode } from "react";
import { Section } from "@/components/ui/section";
import { Reveal } from "@/components/ui/reveal";

/* ------------------------------------------------------------------ glyphs */

function OrbGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16" />
    </svg>
  );
}

function TriangleGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 5.5 19 18H5z" />
    </svg>
  );
}

function DiamondGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 4.5 19 12l-7 7.5L5 12z" />
    </svg>
  );
}

function RingsGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="9.5" cy="12" r="5.5" />
      <circle cx="14.5" cy="12" r="5.5" />
    </svg>
  );
}

/* -------------------------------------------------------------------- data */

type Brand = {
  name: string;
  glyph?: ReactNode;
};

const BRANDS: Brand[] = [
  { name: "Atlas Travel", glyph: <OrbGlyph /> },
  { name: "LinguaLab" },
  { name: "Northwind", glyph: <TriangleGlyph /> },
  { name: "Beacon Health" },
  { name: "Polyglot Club", glyph: <DiamondGlyph /> },
  { name: "Fieldnote" },
  { name: "Kyoto Labs", glyph: <RingsGlyph /> },
  { name: "Meridian U" },
];

/* ----------------------------------------------------------------- section */

function LogoRow({ ariaHidden = false }: { ariaHidden?: boolean }) {
  return (
    <div
      aria-hidden={ariaHidden || undefined}
      className="flex shrink-0 items-center gap-16 pr-16"
    >
      {BRANDS.map((brand) => (
        <span
          key={brand.name}
          className="flex items-center gap-2.5 font-display text-lg font-semibold tracking-tight whitespace-nowrap text-ink opacity-40 md:text-xl"
        >
          {brand.glyph}
          {brand.name}
        </span>
      ))}
    </div>
  );
}

export default function TrustedBy() {
  return (
    <Section tone="canvas" className="py-14! md:py-16!">
      <div className="shell">
        <Reveal>
          <p className="text-center text-sm text-faint">
            Trusted by curious minds at
          </p>
        </Reveal>
        <Reveal delay={0.12} className="group marquee-mask mt-8 overflow-hidden">
          <div
            className="flex w-max animate-marquee group-hover:[animation-play-state:paused] group-focus-within:[animation-play-state:paused]"
            style={{ "--marquee-duration": "45s" } as CSSProperties}
          >
            <LogoRow />
            <LogoRow ariaHidden />
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
