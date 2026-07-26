"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

/**
 * Dimensional viewfinder subjects for the live demo — gradient-shaded SVG
 * "3D renders" (light from top-left, specular highlights, contact shadows)
 * that float gently in the frame. Pure vectors: no photo licensing, no
 * three.js bundle cost, crisp at any DPR.
 */

export type SceneKey =
  | "medical"
  | "coins"
  | "rock"
  | "plants"
  | "essay"
  | "maths"
  | "calories"
  | "barcode"
  | "receipt"
  | "stamps";

/** Per-sample screen tint behind the subject, so the frame is never stark white. */
export const SCREEN_BG: Record<SceneKey | "upload", string> = {
  medical: "bg-[radial-gradient(120%_90%_at_50%_38%,#fdf1ef_0%,#f7e7e4_55%,#efdad6_100%)]",
  coins: "bg-[radial-gradient(120%_90%_at_50%_38%,#fdf6e8_0%,#f8ecd2_55%,#eedfba_100%)]",
  rock: "bg-[radial-gradient(120%_90%_at_50%_38%,#f6f0fc_0%,#ece2f8_55%,#ded0f0_100%)]",
  plants: "bg-[radial-gradient(120%_90%_at_50%_38%,#eef8ef_0%,#e0f1e2_55%,#cfe6d3_100%)]",
  essay: "bg-[radial-gradient(120%_90%_at_50%_38%,#f4f6f9_0%,#e9edf3_55%,#dde3ec_100%)]",
  maths: "bg-[radial-gradient(120%_90%_at_50%_38%,#eef3fb_0%,#e1e9f7_55%,#d2ddf0_100%)]",
  calories: "bg-[radial-gradient(120%_90%_at_50%_38%,#fdf4ea_0%,#f9e9d6_55%,#f0dcc0_100%)]",
  barcode: "bg-[radial-gradient(120%_90%_at_50%_38%,#edf8f6_0%,#dff0ed_55%,#cde5e0_100%)]",
  receipt: "bg-[radial-gradient(120%_90%_at_50%_38%,#f3f5f8_0%,#e8ecf1_55%,#dae0e9_100%)]",
  stamps: "bg-[radial-gradient(120%_90%_at_50%_38%,#faf2ec_0%,#f4e6da_55%,#ead6c4_100%)]",
  upload: "bg-sunken",
};

/* ------------------------------------------------------------------ shells */

function Float({ children, drift = 6 }: { children: ReactNode; drift?: number }) {
  const reduce = useReducedMotion();
  if (reduce) return <div className="relative">{children}</div>;
  return (
    <motion.div
      className="relative will-change-transform"
      animate={{ y: [0, -drift, 0], rotate: [-1.5, 1.5, -1.5] }}
      transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
    >
      {children}
    </motion.div>
  );
}

/** soft contact shadow under every subject */
function Ground({ w = 90 }: { w?: number }) {
  return (
    <div
      aria-hidden
      className="absolute left-1/2 top-full h-4 -translate-x-1/2 -translate-y-1 rounded-[50%] bg-ink/15 blur-[6px]"
      style={{ width: w }}
    />
  );
}

/* ------------------------------------------------------------------ scenes */

function PlantScene() {
  return (
    <Float>
      <svg viewBox="0 0 170 170" className="h-44 w-44" aria-hidden>
        <defs>
          <linearGradient id="pl-leaf" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#67c17c" />
            <stop offset="0.55" stopColor="#2e8c4a" />
            <stop offset="1" stopColor="#1b5c31" />
          </linearGradient>
          <linearGradient id="pl-leaf2" x1="1" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#8fd8a0" />
            <stop offset="0.6" stopColor="#3fa25c" />
            <stop offset="1" stopColor="#236b3a" />
          </linearGradient>
          <linearGradient id="pl-pot" x1="0" y1="0" x2="1" y2="0.2">
            <stop offset="0" stopColor="#e2916a" />
            <stop offset="0.5" stopColor="#c06a43" />
            <stop offset="1" stopColor="#8f4527" />
          </linearGradient>
        </defs>
        {/* stems */}
        <path d="M85 118C84 96 78 78 62 62M85 118C86 98 94 76 112 60" stroke="#2c7a42" strokeWidth="4" fill="none" strokeLinecap="round" />
        {/* left leaf with fenestration slits */}
        <g transform="rotate(-14 60 52)">
          <path d="M62 64C36 62 24 42 30 20c22-4 40 10 42 34 0 4-4 10-10 10Z" fill="url(#pl-leaf)" />
          <path d="M40 30l18 22M50 24l14 26" stroke="#eaf6ec" strokeWidth="3.4" strokeLinecap="round" opacity="0.9" />
          <path d="M34 24c10 12 22 24 32 34" stroke="#1b5c31" strokeWidth="1.6" opacity="0.5" fill="none" />
        </g>
        {/* right leaf */}
        <g transform="rotate(12 112 52)">
          <path d="M108 62c26-4 38-24 32-46-22-2-40 12-42 36 0 4 4 10 10 10Z" fill="url(#pl-leaf2)" />
          <path d="M132 22l-20 26M124 16l-16 28" stroke="#eef8f0" strokeWidth="3.4" strokeLinecap="round" opacity="0.9" />
          <path d="M138 20c-12 12-24 24-32 36" stroke="#236b3a" strokeWidth="1.6" opacity="0.5" fill="none" />
        </g>
        {/* young center leaf */}
        <path d="M85 96C80 82 82 68 92 58c8 10 8 26-2 38-2 2-4 2-5 0Z" fill="url(#pl-leaf)" opacity="0.95" />
        {/* pot */}
        <path d="M58 118h54l-7 34c-1 4-4 6-8 6H73c-4 0-7-2-8-6l-7-34Z" fill="url(#pl-pot)" />
        <ellipse cx="85" cy="118" rx="27" ry="7" fill="#d97f56" />
        <ellipse cx="85" cy="118" rx="21" ry="5" fill="#5c3320" />
        {/* specular */}
        <path d="M66 126c1 8 3 18 5 24" stroke="#f6c4a6" strokeWidth="3" strokeLinecap="round" opacity="0.55" />
      </svg>
      <Ground w={96} />
    </Float>
  );
}

function RockScene() {
  return (
    <Float drift={5}>
      <svg viewBox="0 0 170 170" className="h-44 w-44" aria-hidden>
        <defs>
          <linearGradient id="rk-a" x1="0" y1="0" x2="0.6" y2="1">
            <stop offset="0" stopColor="#e6d1fb" />
            <stop offset="0.5" stopColor="#a06ae0" />
            <stop offset="1" stopColor="#5c2ba0" />
          </linearGradient>
          <linearGradient id="rk-b" x1="1" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#d3b4f7" />
            <stop offset="0.6" stopColor="#8a4fd0" />
            <stop offset="1" stopColor="#47207e" />
          </linearGradient>
          <linearGradient id="rk-base" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#9d9aa6" />
            <stop offset="1" stopColor="#5d5a66" />
          </linearGradient>
        </defs>
        {/* rock base */}
        <path d="M30 118l18-16 34-8 40 10 18 16-8 20-44 10-46-8-12-24Z" fill="url(#rk-base)" />
        <path d="M30 118l18-16 12 22-18 18Z" fill="#726f7c" />
        {/* crystals — faceted prisms, each face a different lightness */}
        <g>
          <polygon points="62,104 54,52 70,38 74,102" fill="url(#rk-a)" />
          <polygon points="74,102 70,38 84,54 84,104" fill="#6d34b4" />
          <polygon points="88,102 84,40 102,26 106,100" fill="url(#rk-b)" />
          <polygon points="106,100 102,26 116,48 118,100" fill="#542692" />
          <polygon points="46,110 42,74 56,62 58,108" fill="url(#rk-b)" />
          <polygon points="118,104 118,66 132,58 134,104" fill="url(#rk-a)" />
        </g>
        {/* glints */}
        <g stroke="#ffffff" strokeWidth="1.6" strokeLinecap="round" opacity="0.9">
          <path d="M97 40v10M92 45h10" />
          <path d="M60 62v7M56.5 65.5h7" opacity="0.7" />
          <path d="M126 68v6M123 71h6" opacity="0.6" />
        </g>
        <path d="M56 54l12-12M88 44l12-14" stroke="#f1e4ff" strokeWidth="2" strokeLinecap="round" opacity="0.65" />
      </svg>
      <Ground w={104} />
    </Float>
  );
}

function CoinScene() {
  return (
    <Float drift={5}>
      <svg viewBox="0 0 170 170" className="h-44 w-44" aria-hidden>
        <defs>
          <linearGradient id="cn-face" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffe9a8" />
            <stop offset="0.55" stopColor="#e2b45e" />
            <stop offset="1" stopColor="#a4732a" />
          </linearGradient>
          <linearGradient id="cn-rim" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#c99b47" />
            <stop offset="1" stopColor="#7c561d" />
          </linearGradient>
          <linearGradient id="cn-top" x1="0" y1="0" x2="1" y2="0.4">
            <stop offset="0" stopColor="#fff3c8" />
            <stop offset="0.6" stopColor="#ecc26e" />
            <stop offset="1" stopColor="#bd8c38" />
          </linearGradient>
        </defs>
        {/* standing coin behind */}
        <g transform="rotate(-10 112 74)">
          <circle cx="112" cy="74" r="34" fill="url(#cn-face)" />
          <circle cx="112" cy="74" r="28" fill="none" stroke="#8a6224" strokeWidth="1.6" opacity="0.7" />
          <text x="112" y="80" textAnchor="middle" fontSize="24" fill="#7c561d" style={{ fontFamily: "Georgia, serif" }}>₹</text>
          <text x="112" y="94" textAnchor="middle" fontSize="7" letterSpacing="2" fill="#8a6224">1947</text>
          {/* specular sweep */}
          <path d="M88 56a34 34 0 0 1 30-14" stroke="#fff7dd" strokeWidth="5" strokeLinecap="round" fill="none" opacity="0.8" />
        </g>
        {/* stack of lying coins */}
        {[0, 1, 2].map((i) => {
          const y = 128 - i * 11;
          return (
            <g key={i}>
              <path d={`M34 ${y}a30 11 0 0 0 60 0v-6H34Z`} fill="url(#cn-rim)" />
              <ellipse cx="64" cy={y - 6} rx="30" ry="11" fill="url(#cn-top)" />
              <ellipse cx="64" cy={y - 6} rx="23" ry="8" fill="none" stroke="#a4732a" strokeWidth="1.2" opacity="0.6" />
            </g>
          );
        })}
        <text x="64" y="103" textAnchor="middle" fontSize="13" fill="#8a6224" style={{ fontFamily: "Georgia, serif" }}>₹</text>
        {/* reeded edge ticks */}
        <g stroke="#6e4c18" strokeWidth="1" opacity="0.5">
          {Array.from({ length: 9 }, (_, i) => {
            const x = 38 + i * 6.5;
            return <path key={i} d={`M${x} 124v5`} />;
          })}
        </g>
      </svg>
      <Ground w={100} />
    </Float>
  );
}

function MedicalScene() {
  return (
    <Float drift={5}>
      <svg viewBox="0 0 170 170" className="h-44 w-44" aria-hidden>
        <defs>
          <linearGradient id="md-red" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f28b8b" />
            <stop offset="0.5" stopColor="#d94f4f" />
            <stop offset="1" stopColor="#9c2626" />
          </linearGradient>
          <linearGradient id="md-cream" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fffdf6" />
            <stop offset="0.6" stopColor="#f2e9d8" />
            <stop offset="1" stopColor="#d8cab2" />
          </linearGradient>
          <linearGradient id="md-tab" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="1" stopColor="#d9dde6" />
          </linearGradient>
        </defs>
        {/* faint ECG line behind */}
        <path d="M18 52h28l7-16 10 34 8-18h34" stroke="#e0938d" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.55" />
        {/* capsule */}
        <g transform="rotate(-28 85 96)">
          <rect x="45" y="82" width="80" height="30" rx="15" fill="url(#md-cream)" />
          <path d="M45 97a15 15 0 0 1 15-15h25v30H60a15 15 0 0 1-15-15Z" fill="url(#md-red)" />
          <path d="M85 82v30" stroke="#8f8371" strokeWidth="1" opacity="0.5" />
          {/* specular streak */}
          <path d="M55 88c18-3 44-3 62 0" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" opacity="0.65" />
        </g>
        {/* tablet */}
        <g transform="translate(112 118)">
          <ellipse cx="0" cy="3" rx="19" ry="8" fill="#b9bec9" />
          <ellipse cx="0" cy="0" rx="19" ry="8" fill="url(#md-tab)" />
          <path d="M-12 0h24M0 -4v8" stroke="#a9aeba" strokeWidth="1.4" strokeLinecap="round" />
        </g>
      </svg>
      <Ground w={96} />
    </Float>
  );
}

function EssayScene() {
  return (
    <Float drift={4}>
      <svg viewBox="0 0 170 170" className="h-44 w-44" aria-hidden>
        <defs>
          <linearGradient id="es-page" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.75" stopColor="#f2f2f0" />
            <stop offset="1" stopColor="#dedcd6" />
          </linearGradient>
          <linearGradient id="es-pen" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#3c4152" />
            <stop offset="1" stopColor="#14161f" />
          </linearGradient>
        </defs>
        {/* back sheet */}
        <rect x="46" y="30" width="86" height="112" rx="6" fill="#e7e5df" transform="rotate(5 89 86)" />
        {/* front sheet with corner curl */}
        <g transform="rotate(-4 82 84)">
          <path d="M40 32a6 6 0 0 1 6-6h74a6 6 0 0 1 6 6v96l-16 16H46a6 6 0 0 1-6-6V32Z" fill="url(#es-page)" />
          <path d="M126 128l-16 16v-12a4 4 0 0 1 4-4h12Z" fill="#cfccc4" />
          {/* heading + text lines */}
          <rect x="52" y="42" width="46" height="6" rx="3" fill="#2f3038" />
          {[58, 68, 78, 88, 98, 108].map((y, i) => (
            <rect key={y} x="52" y={y} width={i % 3 === 2 ? 48 : 62} height="3.4" rx="1.7" fill="#c9c7bf" />
          ))}
          <rect x="52" y="118" width="34" height="3.4" rx="1.7" fill="#e9b84c" />
        </g>
        {/* fountain pen */}
        <g transform="rotate(34 110 116)">
          <rect x="80" y="110" width="62" height="10" rx="5" fill="url(#es-pen)" />
          <path d="M142 111l14 4-14 4c1.5-2.7 1.5-5.3 0-8Z" fill="#e2b45e" />
          <circle cx="150" cy="115" r="1.2" fill="#14161f" />
          <rect x="86" y="110" width="4" height="10" fill="#e2b45e" />
          <path d="M84 112c16-1 34-1 52 0" stroke="#8d93a8" strokeWidth="1.6" strokeLinecap="round" opacity="0.7" />
        </g>
      </svg>
      <Ground w={100} />
    </Float>
  );
}

function MathsScene() {
  return (
    <Float drift={4}>
      <svg viewBox="0 0 170 170" className="h-44 w-44" aria-hidden>
        <defs>
          <linearGradient id="mt-board" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#2c3a58" />
            <stop offset="1" stopColor="#101b30" />
          </linearGradient>
          <linearGradient id="mt-sph" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#9dc3ff" />
            <stop offset="0.55" stopColor="#4c7dff" />
            <stop offset="1" stopColor="#1f3fa8" />
          </linearGradient>
        </defs>
        {/* board with soft 3D tilt */}
        <g transform="rotate(-3 85 88)">
          <rect x="26" y="40" width="118" height="92" rx="12" fill="url(#mt-board)" />
          <rect x="26" y="40" width="118" height="92" rx="12" fill="none" stroke="#4a5c82" strokeWidth="1.4" opacity="0.7" />
          {/* equation */}
          <text x="85" y="66" textAnchor="middle" fontSize="14" fill="#f2f6ff" style={{ fontFamily: "Georgia, serif", fontStyle: "italic" }}>
            x² − 5x + 6 = 0
          </text>
          {/* axes */}
          <path d="M40 116h92M52 124V78" stroke="#54688f" strokeWidth="1.3" />
          {/* glowing parabola crossing x=2 and x=3 */}
          <path d="M46 84c14 34 24 44 36 44s24-12 40-48" stroke="#ffd166" strokeWidth="3" fill="none" strokeLinecap="round" />
          <circle cx="70" cy="116" r="3.4" fill="#ffd166" />
          <circle cx="96" cy="116" r="3.4" fill="#ffd166" />
          <text x="70" y="128" textAnchor="middle" fontSize="8" fill="#9fb2d6">2</text>
          <text x="96" y="128" textAnchor="middle" fontSize="8" fill="#9fb2d6">3</text>
        </g>
        {/* glossy sphere accent */}
        <circle cx="139" cy="46" r="13" fill="url(#mt-sph)" />
        <ellipse cx="134.5" cy="41" rx="5" ry="3.4" fill="#ffffff" opacity="0.7" transform="rotate(-24 134.5 41)" />
      </svg>
      <Ground w={110} />
    </Float>
  );
}

function CaloriesScene() {
  return (
    <Float drift={5}>
      <svg viewBox="0 0 170 170" className="h-44 w-44" aria-hidden>
        <defs>
          <linearGradient id="cl-bowl" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#4fa8a0" />
            <stop offset="0.6" stopColor="#2e7d76" />
            <stop offset="1" stopColor="#1c544f" />
          </linearGradient>
          <linearGradient id="cl-avo" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#b6dc7e" />
            <stop offset="1" stopColor="#6d9c3c" />
          </linearGradient>
        </defs>
        {/* steam curls */}
        <path d="M70 38c-4 6 4 8 0 14M88 30c-4 6 4 8 0 14M104 40c-4 6 4 8 0 14" stroke="#c8b49a" strokeWidth="2.4" fill="none" strokeLinecap="round" opacity="0.7" />
        {/* bowl */}
        <path d="M38 88c0 26 21 44 47 44s47-18 47-44H38Z" fill="url(#cl-bowl)" />
        <ellipse cx="85" cy="88" rx="47" ry="13" fill="#3b8d85" />
        <ellipse cx="85" cy="86" rx="42" ry="11" fill="#f7f3e8" />
        {/* rice mound */}
        <ellipse cx="70" cy="82" rx="20" ry="9" fill="#ffffff" />
        <ellipse cx="66" cy="78" rx="13" ry="6" fill="#f3efe2" />
        {/* avocado slices */}
        <path d="M96 74c10-3 18 1 20 8-8 4-17 3-22-2 0-3 0-5 2-6Z" fill="url(#cl-avo)" />
        <path d="M92 82c9-2 16 1 18 7-7 3-15 2-20-2 0-2 1-4 2-5Z" fill="url(#cl-avo)" opacity="0.85" />
        {/* tomato halves */}
        <circle cx="104" cy="90" r="7" fill="#e05545" />
        <circle cx="104" cy="90" r="4" fill="#f0796a" />
        <circle cx="92" cy="94" r="5.4" fill="#e05545" />
        {/* sesame */}
        <g fill="#b09566">
          <ellipse cx="64" cy="86" rx="1.6" ry="0.9" />
          <ellipse cx="74" cy="80" rx="1.6" ry="0.9" transform="rotate(30 74 80)" />
          <ellipse cx="58" cy="80" rx="1.6" ry="0.9" transform="rotate(-20 58 80)" />
        </g>
        {/* bowl specular */}
        <path d="M46 100c3 10 10 18 19 23" stroke="#8fd0c9" strokeWidth="3" strokeLinecap="round" opacity="0.55" />
        {/* chopsticks */}
        <path d="M116 58l26 34M124 54l24 36" stroke="#a1793f" strokeWidth="3.4" strokeLinecap="round" />
      </svg>
      <Ground w={104} />
    </Float>
  );
}

function BarcodeScene() {
  return (
    <Float drift={4}>
      <svg viewBox="0 0 170 170" className="h-44 w-44" aria-hidden>
        <defs>
          <linearGradient id="bc-box" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.7" stopColor="#eef1f0" />
            <stop offset="1" stopColor="#d6dcda" />
          </linearGradient>
          <linearGradient id="bc-side" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#c3cbc8" />
            <stop offset="1" stopColor="#a7b1ad" />
          </linearGradient>
        </defs>
        {/* box in slight 3D perspective */}
        <path d="M46 52l64-14 20 10-64 16-20-12Z" fill="#f4f6f5" />
        <path d="M46 52l20 12v62l-20-12V52Z" fill="url(#bc-side)" />
        <path d="M66 64l64-16v62l-64 16V64Z" fill="url(#bc-box)" />
        {/* teal band */}
        <path d="M66 70l64-16v12L66 82V70Z" fill="#2e7d76" />
        {/* barcode on the front face */}
        <g fill="#20241f" transform="translate(74 90) skewY(-13)">
          {[0, 3.4, 5.6, 9.8, 12.4, 16.8, 19.2, 23.4, 26.2, 30.4, 33.2, 37.6, 40.2, 44.6].map(
            (x, i) => (
              <rect key={i} x={x} y="0" width={i % 3 === 0 ? 2.6 : 1.4} height="26" />
            ),
          )}
        </g>
        {/* scanning laser */}
        <path d="M38 96l100-24" stroke="#e04430" strokeWidth="2.6" strokeLinecap="round" opacity="0.85" />
        <circle cx="138" cy="72" r="3.4" fill="#e04430" opacity="0.6" />
      </svg>
      <Ground w={96} />
    </Float>
  );
}

function ReceiptScene() {
  return (
    <Float drift={4}>
      <svg viewBox="0 0 170 170" className="h-44 w-44" aria-hidden>
        <defs>
          <linearGradient id="rc-paper" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.8" stopColor="#f0f0ec" />
            <stop offset="1" stopColor="#dcdcd4" />
          </linearGradient>
        </defs>
        {/* receipt with zigzag torn bottom, slight tilt */}
        <g transform="rotate(-5 85 88)">
          <path
            d="M52 26h66v106l-6.6-5-6.6 5-6.6-5-6.6 5-6.6-5-6.6 5-6.6-5-6.6 5-6.6-5-6.6 5V26Z"
            fill="url(#rc-paper)"
          />
          <rect x="62" y="36" width="34" height="5" rx="2.5" fill="#33352f" />
          {[50, 60, 70, 80].map((y) => (
            <g key={y}>
              <rect x="62" y={y} width="28" height="3.2" rx="1.6" fill="#c6c6bc" />
              <rect x="96" y={y} width="12" height="3.2" rx="1.6" fill="#a9a99d" />
            </g>
          ))}
          <path d="M62 92h46" stroke="#c6c6bc" strokeWidth="1.6" strokeDasharray="3 3" />
          <rect x="62" y="99" width="20" height="4.4" rx="2.2" fill="#33352f" />
          <rect x="90" y="99" width="18" height="4.4" rx="2.2" fill="#2e7d76" />
        </g>
        {/* coin beside */}
        <ellipse cx="128" cy="132" rx="14" ry="5.4" fill="#9a6b1f" />
        <ellipse cx="128" cy="129" rx="14" ry="5.4" fill="#e2b45e" />
        <ellipse cx="128" cy="129" rx="9" ry="3.4" fill="none" stroke="#a4732a" strokeWidth="1" />
      </svg>
      <Ground w={92} />
    </Float>
  );
}

function StampsScene() {
  return (
    <Float drift={4}>
      <svg viewBox="0 0 170 170" className="h-44 w-44" aria-hidden>
        <defs>
          <linearGradient id="st-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f6c98e" />
            <stop offset="1" stopColor="#d98a5b" />
          </linearGradient>
          <linearGradient id="st-hill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#9c5b46" />
            <stop offset="1" stopColor="#5f3128" />
          </linearGradient>
        </defs>
        {/* stamp with perforated (scalloped) edge — drawn as a rounded rect with
            punched holes along the border */}
        <g transform="rotate(-6 85 85)">
          <rect x="38" y="40" width="94" height="94" rx="4" fill="#f6efe2" />
          {/* perforation holes */}
          <g fill="#e9dcc5">
            {Array.from({ length: 8 }, (_, i) => (
              <circle key={`t${i}`} cx={45 + i * 11.5} cy="40" r="3.2" />
            ))}
            {Array.from({ length: 8 }, (_, i) => (
              <circle key={`b${i}`} cx={45 + i * 11.5} cy="134" r="3.2" />
            ))}
            {Array.from({ length: 8 }, (_, i) => (
              <circle key={`l${i}`} cx="38" cy={47 + i * 11.5} r="3.2" />
            ))}
            {Array.from({ length: 8 }, (_, i) => (
              <circle key={`r${i}`} cx="132" cy={47 + i * 11.5} r="3.2" />
            ))}
          </g>
          {/* vignette */}
          <rect x="48" y="50" width="74" height="74" fill="url(#st-sky)" />
          <circle cx="102" cy="66" r="8" fill="#fff3d6" />
          <path d="M48 124l22-34 14 18 10-12 28 28H48Z" fill="url(#st-hill)" />
          <rect x="48" y="50" width="74" height="74" fill="none" stroke="#8a5a3a" strokeWidth="1.6" />
          <text x="56" y="118" fontSize="15" fill="#f6efe2" style={{ fontFamily: "Georgia, serif" }}>5</text>
        </g>
        {/* postmark */}
        <circle cx="124" cy="52" r="17" fill="none" stroke="#5c5650" strokeWidth="1.6" opacity="0.6" strokeDasharray="4 3" />
        <path d="M112 48c8-2 16-2 24 0M112 56c8 2 16 2 24 0" stroke="#5c5650" strokeWidth="1.2" opacity="0.5" fill="none" />
      </svg>
      <Ground w={100} />
    </Float>
  );
}

const SCENES: Record<SceneKey, () => ReactNode> = {
  plants: PlantScene,
  rock: RockScene,
  coins: CoinScene,
  medical: MedicalScene,
  essay: EssayScene,
  maths: MathsScene,
  calories: CaloriesScene,
  barcode: BarcodeScene,
  receipt: ReceiptScene,
  stamps: StampsScene,
};

export function DemoScene({ sample }: { sample: SceneKey }) {
  const Comp = SCENES[sample];
  return <>{Comp()}</>;
}
