"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";
import { EASE, fadeRise, stagger, viewportOnce, spring } from "@/lib/motion";
import { Section, SectionHeading } from "@/components/ui/section";
import { Reveal } from "@/components/ui/reveal";
import { ButtonLink } from "@/components/ui/button";
import { CheckIcon } from "@/components/ui/icons";

type Billing = "monthly" | "annual";

type Tier = {
  name: string;
  blurb: string;
  price: Record<Billing, string>;
  cadence: Record<Billing, string>;
  features: string[];
  cta: { label: string; href: string };
  featured?: boolean;
};

const TIERS: Tier[] = [
  {
    name: "Starter",
    blurb: "Everything to get going",
    price: { monthly: "$0", annual: "$0" },
    cadence: { monthly: "free forever", annual: "free forever" },
    features: [
      "25 translations per day",
      "10 camera scans per day",
      "Standard voices",
      "40 languages",
    ],
    cta: { label: "Download free", href: "#download" },
  },
  {
    name: "Pro",
    blurb: "The full YSNAP experience",
    price: { monthly: "$9.99", annual: "$6.67" },
    cadence: {
      monthly: "per month, billed monthly",
      annual: "per month, billed annually ($79.99/yr)",
    },
    features: [
      "Unlimited translation",
      "All 12 camera modes",
      "Voice cloning",
      "120+ languages",
      "Offline packs",
      "Priority processing",
    ],
    cta: { label: "Get Pro", href: "#download" },
    featured: true,
  },
  {
    name: "Teams",
    blurb: "For crews that work worldwide",
    price: { monthly: "$19.99", annual: "$19.99" },
    cadence: { monthly: "per user, per month", annual: "per user, per month" },
    features: ["Everything in Pro", "Shared glossaries", "Admin console", "SSO"],
    cta: { label: "Contact sales", href: "#" },
  },
];

const BILLING_OPTIONS: { value: Billing; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "annual", label: "Annual" },
];

export default function Pricing() {
  const [billing, setBilling] = useState<Billing>("annual");
  const reduce = useReducedMotion();

  return (
    <Section id="pricing" tone="surface">
      <div className="shell">
        <SectionHeading
          eyebrow="Pricing"
          title={
            <>
              Start <span className="text-gradient">free</span>. Upgrade when
              ready.
            </>
          }
          description="Every plan includes translation, voice, and camera. Pay only for more depth and speed."
        />

        {/* Billing period toggle */}
        <Reveal className="mb-12 flex justify-center md:mb-16">
          <div
            role="group"
            aria-label="Billing period"
            className="inline-flex items-center rounded-full border border-hairline bg-sunken p-1"
          >
            {BILLING_OPTIONS.map((option) => {
              const active = billing === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setBilling(option.value)}
                  className={cn(
                    "relative cursor-pointer rounded-full px-5 py-2 text-sm font-medium transition-colors duration-300",
                    active ? "text-ink" : "text-muted hover:text-ink",
                  )}
                >
                  {active ? (
                    <motion.span
                      layoutId="billing-thumb"
                      aria-hidden
                      className="absolute inset-0 bg-surface shadow-soft"
                      style={{ borderRadius: 9999 }}
                      transition={reduce ? { duration: 0 } : spring}
                    />
                  ) : null}
                  <span className="relative z-10 inline-flex items-center gap-2">
                    {option.label}
                    {option.value === "annual" ? (
                      <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-accent-deep">
                        Save 33%
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </Reveal>

        {/* Tier cards */}
        <motion.div
          variants={stagger(0, 0.08)}
          initial="hidden"
          whileInView="visible"
          viewport={viewportOnce}
          className="mx-auto grid max-w-5xl grid-cols-1 items-stretch gap-6 md:grid-cols-3"
        >
          {TIERS.map((tier) => (
            <motion.div
              key={tier.name}
              variants={fadeRise}
              onPointerMove={
                tier.featured
                  ? undefined
                  : (e) => {
                      if (e.pointerType !== "mouse") return;
                      const r = e.currentTarget.getBoundingClientRect();
                      e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
                      e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
                    }
              }
              className={cn(
                "group relative flex flex-col rounded-card p-8",
                tier.featured
                  ? "bg-ink text-white shadow-pop lg:-translate-y-3"
                  : "border border-hairline bg-surface shadow-soft transition-all duration-300 hover:-translate-y-1 hover:shadow-lift",
              )}
            >
              {!tier.featured ? (
                /* Cursor-following hairline glow: the radial gradient is
                   mask-clipped to the 1px border ring, so the interior stays
                   pristine white and the light lives strictly on the edge.
                   Fine pointers only — on touch a tap's sticky :hover would
                   otherwise freeze the glow at its default position. */
                <div
                  aria-hidden
                  className="pointer-events-none absolute -inset-px rounded-[calc(var(--radius-card)+1px)] opacity-0 transition-opacity duration-500 pointer-fine:group-hover:opacity-100"
                  style={{
                    background:
                      "radial-gradient(220px circle at var(--mx, 50%) var(--my, 0%), rgb(76 125 255 / 0.35), transparent 70%)",
                    padding: "1px",
                    WebkitMask:
                      "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
                    WebkitMaskComposite: "xor",
                    maskComposite: "exclude",
                  }}
                />
              ) : null}
              {tier.featured ? (
                <>
                  {/* accent glow, clipped to the card */}
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 overflow-hidden rounded-card"
                  >
                    <div
                      className="absolute -right-20 -top-20 h-72 w-72 rounded-full"
                      style={{
                        background:
                          "radial-gradient(closest-side, rgb(76 125 255 / 0.26), transparent)",
                      }}
                    />
                  </div>
                  <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-accent px-3.5 py-1.5 text-xs font-semibold text-white shadow-glow">
                    Most popular
                  </span>
                </>
              ) : null}

              <div className="relative">
                <h3 className="text-xl font-medium">{tier.name}</h3>
                <p
                  className={cn(
                    "mt-1.5 text-sm",
                    tier.featured ? "text-white/60" : "text-muted",
                  )}
                >
                  {tier.blurb}
                </p>

                <div className="mt-8">
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.div
                      key={`${tier.name}-${tier.price[billing]}`}
                      initial={
                        reduce
                          ? { opacity: 0 }
                          : { opacity: 0, y: 12, filter: "blur(4px)" }
                      }
                      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                      exit={
                        reduce
                          ? { opacity: 0 }
                          : { opacity: 0, y: -12, filter: "blur(4px)" }
                      }
                      transition={{ duration: 0.3, ease: EASE }}
                    >
                      <p className="text-5xl font-medium tracking-tight tabular-nums">
                        {tier.price[billing]}
                      </p>
                      <p
                        className={cn(
                          "mt-2 text-sm",
                          tier.featured ? "text-white/50" : "text-faint",
                        )}
                      >
                        {tier.cadence[billing]}
                      </p>
                    </motion.div>
                  </AnimatePresence>
                </div>

                <ul className="mt-8 flex flex-col gap-3">
                  {tier.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-3 text-[15px]">
                      <CheckIcon
                        className={cn(
                          "mt-1 h-4 w-4 shrink-0",
                          tier.featured ? "text-accent" : "text-faint",
                        )}
                      />
                      <span className={tier.featured ? "text-white/80" : "text-ink-soft"}>
                        {feature}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="relative mt-auto pt-10">
                <ButtonLink
                  href={tier.cta.href}
                  variant={tier.featured ? "primary" : "secondary"}
                  className={cn(
                    "w-full",
                    tier.featured && "bg-white text-ink hover:bg-white",
                  )}
                >
                  {tier.cta.label}
                </ButtonLink>
              </div>
            </motion.div>
          ))}
        </motion.div>

        <Reveal delay={0.15}>
          <p className="mt-10 text-center text-sm text-faint">
            Prices in USD. Cancel anytime.
          </p>
        </Reveal>
      </div>
    </Section>
  );
}
