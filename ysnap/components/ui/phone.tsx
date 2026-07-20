import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Reusable CSS device frame — a calm, premium phone silhouette with a Dynamic
 * Island, hairline bezel and glass reflection. Screens are composed by children.
 *
 * pose="tilted" presents the device in 3D perspective (three-quarter turn with
 * a visible extruded edge) so mockups read as objects, not flat cards. Wrap in
 * a parent with `perspective` for the effect; the frame supplies its own here.
 */
export function PhoneFrame({
  children,
  className,
  width = 320,
  pose = "flat",
}: {
  children: ReactNode;
  className?: string;
  /** CSS width in px; height follows the 19.5:9 aspect ratio. */
  width?: number;
  /** flat = straight-on (default) · tilted = 3D three-quarter presentation */
  pose?: "flat" | "tilted";
}) {
  const tilted = pose === "tilted";
  return (
    <div style={tilted ? { perspective: "1200px" } : undefined}>
      <div
        className={cn(
          "relative select-none rounded-device border border-chassis-edge bg-[linear-gradient(165deg,#fcfcfd,#ececee)] p-[10px] shadow-[inset_0_1px_1px_rgb(255_255_255/0.95),inset_0_-1px_1px_rgb(11_12_14/0.06),0_4px_8px_rgb(11_12_14/0.06),0_28px_72px_rgb(11_12_14/0.14)]",
          tilted &&
            "transition-transform duration-700 [transform:rotateY(-14deg)_rotateX(4deg)] [transform-style:preserve-3d] hover:[transform:rotateY(-6deg)_rotateX(2deg)]",
          className,
        )}
        style={{ width, aspectRatio: "9 / 19.5" }}
      >
        {/* extruded edge — fakes device thickness along the turned-away side */}
        {tilted && (
          <div
            aria-hidden
            className="absolute -right-[6px] top-[6px] bottom-[6px] w-[7px] rounded-r-[10px] bg-[linear-gradient(90deg,#d7d7db,#b9b9bf)]"
            style={{ transform: "rotateY(-38deg) translateZ(-2px)", transformOrigin: "left center" }}
          />
        )}
        {/* screen */}
        <div className="relative h-full w-full overflow-hidden rounded-device-screen border border-hairline bg-white shadow-[inset_0_0_0_1px_rgb(11_12_14/0.05),inset_0_2px_8px_rgb(11_12_14/0.05)]">
          {children}
          {/* dynamic island */}
          <div
            aria-hidden
            className="absolute left-1/2 top-3 z-20 h-[26px] w-[92px] -translate-x-1/2 rounded-full bg-ink shadow-[0_0_0_2px_rgb(11_12_14/0.04)]"
          />
          {/* glass reflection */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-10 bg-[linear-gradient(115deg,rgb(255_255_255/0.35)_0%,rgb(255_255_255/0)_28%)]"
          />
        </div>
        {/* side buttons */}
        <div aria-hidden className="absolute -left-[2px] top-[22%] h-14 w-[3px] rounded-full bg-[linear-gradient(90deg,#e9e9eb,#cfcfd3)]" />
        <div aria-hidden className="absolute -right-[2px] top-[18%] h-20 w-[3px] rounded-full bg-[linear-gradient(270deg,#e9e9eb,#cfcfd3)]" />
      </div>
    </div>
  );
}
