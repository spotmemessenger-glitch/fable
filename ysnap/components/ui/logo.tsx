import { cn } from "@/lib/cn";

/** YSNAP mark: rounded glyph tile + wordmark. The one place gradient is allowed at rest. */
export function Logo({ className, glyphOnly = false }: { className?: string; glyphOnly?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span
        aria-hidden
        className="grid h-8 w-8 place-items-center rounded-[10px] bg-[linear-gradient(135deg,var(--color-accent),var(--color-violet))] shadow-[0_4px_14px_rgb(76_125_255/0.35)]"
      >
        <svg viewBox="0 0 20 20" className="h-4.5 w-4.5" fill="none" aria-hidden>
          <path
            d="M4 3l6 8v6M16 3l-4.6 6.1"
            stroke="white"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {!glyphOnly && (
        <span className="font-display text-[19px] font-semibold tracking-[-0.02em] text-ink">
          YSNAP
        </span>
      )}
    </span>
  );
}
