import { cn } from "@/lib/cn";
import { YsnapMark } from "@/components/ui/ysnap-mark";

/**
 * Wordmark = glyph + "YSNAP". The glyph itself lives in YsnapMark so the
 * navbar, the footer, the hero and the in-device screen all draw the same
 * artwork — one file to change if the brand moves.
 */
export function Logo({ className, glyphOnly = false }: { className?: string; glyphOnly?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <YsnapMark className="h-8 w-8" />
      {!glyphOnly && (
        <span className="font-display text-[19px] font-semibold tracking-[-0.02em] text-ink">
          YSNAP
        </span>
      )}
    </span>
  );
}
