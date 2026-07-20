import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Reveal } from "@/components/ui/reveal";

/**
 * Section + SectionHeading enforce the page's vertical rhythm and type
 * hierarchy so all 18 sections read as one composed document.
 */

export function Section({
  id,
  children,
  className,
  tone = "canvas",
}: {
  id?: string;
  children: ReactNode;
  className?: string;
  /** canvas = #FAFAFA page color, surface = white band for gentle chapter changes */
  tone?: "canvas" | "surface";
}) {
  return (
    <section
      id={id}
      className={cn(
        "relative scroll-mt-24 py-24 md:py-36",
        /* translucent so the fixed site-wide mesh ghosts through white bands */
        tone === "surface" && "bg-surface/85",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "center",
  className,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  align?: "center" | "left";
  className?: string;
}) {
  const centered = align === "center";
  return (
    <Reveal
      className={cn(
        "mb-14 flex flex-col gap-5 md:mb-20",
        centered ? "items-center text-center" : "items-start text-left",
        className,
      )}
    >
      {eyebrow ? (
        <span className="inline-flex items-center rounded-full border border-accent/25 bg-accent/[0.06] px-3.5 py-1 text-xs font-semibold tracking-[0.14em] text-accent-deep uppercase">
          {eyebrow}
        </span>
      ) : null}
      <h2 className="max-w-3xl text-[2rem] font-medium leading-[1.08] md:text-[2.6rem]">{title}</h2>
      {description ? (
        <p className={cn("max-w-2xl text-lg text-muted md:text-xl", centered && "mx-auto")}>
          {description}
        </p>
      ) : null}
    </Reveal>
  );
}
