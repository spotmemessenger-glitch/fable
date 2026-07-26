import { cn } from "@/lib/cn";

/**
 * App Store / Google Play badges drawn in-house so they match the design
 * system (official marketing badges clash with a hairline aesthetic).
 */
export function StoreBadge({
  store,
  href = "#download",
  variant = "dark",
  className,
}: {
  store: "apple" | "google";
  href?: string;
  variant?: "dark" | "light";
  className?: string;
}) {
  const isApple = store === "apple";
  return (
    <a
      href={href}
      className={cn(
        "inline-flex h-13 cursor-pointer items-center gap-3 rounded-2xl px-5 transition-all duration-300 will-change-transform hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent",
        variant === "dark"
          ? "bg-ink text-white shadow-soft hover:shadow-lift"
          : "border border-white/25 bg-white/10 text-white backdrop-blur hover:bg-white/15",
        className,
      )}
    >
      {isApple ? (
        /* Apple's mark is monochrome by brand guideline — white on dark is the
           correct, canonical treatment, so it inherits the badge's text colour. */
        <svg viewBox="0 0 24 24" className="h-6 w-6 fill-current" aria-hidden>
          <path d="M17.05 12.54c-.03-2.89 2.36-4.27 2.47-4.34-1.35-1.97-3.44-2.24-4.18-2.27-1.78-.18-3.47 1.05-4.37 1.05-.9 0-2.29-1.02-3.77-1-1.94.03-3.72 1.13-4.72 2.86-2.01 3.49-.51 8.66 1.45 11.49.96 1.39 2.1 2.94 3.6 2.89 1.45-.06 1.99-.93 3.74-.93s2.24.93 3.77.9c1.56-.03 2.54-1.41 3.49-2.8 1.1-1.61 1.55-3.17 1.58-3.25-.04-.02-3.03-1.16-3.06-4.6zM14.16 4.06c.8-.97 1.34-2.31 1.19-3.66-1.15.05-2.55.77-3.38 1.74-.74.85-1.39 2.22-1.22 3.53 1.29.1 2.6-.65 3.41-1.61z" />
        </svg>
      ) : (
        /* Google Play's mark IS four-colour — these four paths are its four
           segments. They were previously drawn in one inherited colour with
           opacity faking the facets, which read as a washed-out grey smudge.
           Painting each facet its real brand colour is both more legible at
           24px and what people recognise as the Play badge. */
        <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden>
          {/* left spine */}
          <path
            d="M3.61 1.81C3.23 2.2 3 2.8 3 3.58v16.83c0 .79.23 1.39.61 1.78l.1.09 9.44-9.43v-.22L3.71 1.72l-.1.09z"
            fill="#00A0FF"
          />
          {/* right tip */}
          <path
            d="M16.3 15.99l-3.15-3.14v-.22l3.15-3.15.07.04 3.73 2.12c1.07.6 1.07 1.59 0 2.2l-3.73 2.11-.07.04z"
            fill="#FFCE00"
          />
          {/* lower facet */}
          <path
            d="M16.37 15.95l-3.22-3.21-9.54 9.54c.35.37.93.42 1.59.05l11.17-6.38"
            fill="#FF3A44"
          />
          {/* upper facet */}
          <path
            d="M16.37 8.52L5.2 2.15c-.66-.38-1.24-.33-1.59.04l9.54 9.54 3.22-3.21z"
            fill="#00D66F"
          />
        </svg>
      )}
      <span className="flex flex-col items-start leading-none">
        <span className="text-[10px] font-medium uppercase tracking-wide opacity-70">
          {isApple ? "Download on the" : "Get it on"}
        </span>
        <span className="mt-1 text-[15px] font-semibold">
          {isApple ? "App Store" : "Google Play"}
        </span>
      </span>
    </a>
  );
}
