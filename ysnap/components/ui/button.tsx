"use client";

import { forwardRef, type ButtonHTMLAttributes, type AnchorHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "cta" | "inverse";
type Size = "md" | "lg";

const base =
  "inline-flex cursor-pointer select-none items-center justify-center gap-2 rounded-full font-medium " +
  "transition-all duration-300 will-change-transform " +
  "focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent " +
  "active:scale-[0.98]";

const variants: Record<Variant, string> = {
  primary:
    "bg-ink bg-[linear-gradient(180deg,#1c1f25,#0b0c0e_58%)] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(11_12_14/0.04),0_8px_24px_rgb(11_12_14/0.05)] hover:-translate-y-0.5 hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_2px_4px_rgb(11_12_14/0.05),0_18px_44px_rgb(11_12_14/0.1)]",
  secondary:
    "bg-surface bg-[linear-gradient(180deg,#ffffff,#fafafa)] text-ink border border-hairline shadow-[inset_0_1px_0_#ffffff,0_1px_2px_rgb(11_12_14/0.04),0_8px_24px_rgb(11_12_14/0.05)] hover:-translate-y-0.5 hover:border-[#dcdcdc] hover:shadow-[inset_0_1px_0_#ffffff,0_2px_4px_rgb(11_12_14/0.05),0_18px_44px_rgb(11_12_14/0.1)]",
  ghost: "text-ink hover:bg-ink/5",
  /* Accent-glow hover is sanctioned only on closing-CTA / pricing surfaces. */
  cta: "bg-ink bg-[linear-gradient(180deg,#1c1f25,#0b0c0e_58%)] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(11_12_14/0.04),0_8px_24px_rgb(11_12_14/0.05)] hover:-translate-y-0.5 hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_2px_6px_rgb(11_12_14/0.12),0_14px_34px_color-mix(in_srgb,var(--color-accent)_28%,transparent)]",
  /* White-on-dark surfaces (pricing featured card, download CTA). */
  inverse:
    "text-ink bg-white bg-[linear-gradient(180deg,#ffffff,#f1f1f4)] shadow-[inset_0_1px_0_#ffffff,0_1px_2px_rgb(11_12_14/0.12)] hover:-translate-y-0.5 hover:shadow-[inset_0_1px_0_#ffffff,0_14px_34px_rgb(11_12_14/0.28)]",
};

const sizes: Record<Size, string> = {
  md: "h-11 px-6 text-[15px]",
  lg: "h-13 px-8 text-base",
};

type CommonProps = { variant?: Variant; size?: Size; className?: string };

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & CommonProps
>(function Button({ variant = "primary", size = "md", className, ...props }, ref) {
  return (
    <button
      ref={ref}
      className={cn(base, variants[variant], sizes[size], className)}
      {...props}
    />
  );
});

export const ButtonLink = forwardRef<
  HTMLAnchorElement,
  AnchorHTMLAttributes<HTMLAnchorElement> & CommonProps
>(function ButtonLink({ variant = "primary", size = "md", className, ...props }, ref) {
  return (
    <a
      ref={ref}
      className={cn(base, variants[variant], sizes[size], className)}
      {...props}
    />
  );
});
