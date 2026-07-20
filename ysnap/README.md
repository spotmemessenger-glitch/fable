# YSNAP — Marketing Site

Premium, Apple-grade landing page for **YSNAP** — an AI super-app combining language
intelligence, computer vision and voice AI.

> One AI. Every Language. Every Vision.

## Stack

| Layer      | Choice                                                     |
| ---------- | ---------------------------------------------------------- |
| Framework  | Next.js 15 (App Router) · React 19 · TypeScript (strict)   |
| Styling    | Tailwind CSS v4 (CSS-first tokens in `app/globals.css`)    |
| Motion     | Framer Motion (entrances/micro) · GSAP ScrollTrigger (pinned showcase) · Lenis (smooth scroll) |
| 3D         | Three.js via React Three Fiber + drei (hero scene only)    |
| Audio      | Web Audio API (live waveform driven by real ElevenLabs demo audio in `public/audio`) |

## Architecture

```
app/
  layout.tsx        fonts, metadata, JSON-LD, smooth-scroll provider, nav/footer
  page.tsx          assembles the 17 landing sections in narrative order
  globals.css       the entire design system: color/type/shadow/radius tokens + utilities
  robots.ts / sitemap.ts / icon.svg
components/
  layout/           navbar (glass pill on scroll), footer
  providers/        smooth-scroll (Lenis ⟷ GSAP ScrollTrigger sync, reduced-motion aware)
  sections/         one file per landing section — self-contained, data arrays at top
  three/            R3F hero scene (dynamically imported, never SSR'd)
  ui/               primitives: Button, Section/SectionHeading, Reveal/WordReveal/LetterReveal,
                    Magnetic, TiltCard, Counter, PhoneFrame, StoreBadge, Logo
lib/
  cn.ts             clsx + tailwind-merge
  motion.ts         house easing + shared variants (every entrance uses these)
  site.ts           single source of truth for nav/footer/copy constants
```

## Design system rules

- **Light only.** Canvas `#FAFAFA`, white cards, hairline `#ECECEC` borders, radii 24–36px.
- **Accent budget.** Soft blue `#4C7DFF` → violet `#6E6EF7` appear only in: eyebrow pills,
  one gradient phrase per section, icon glyphs, faint glows, the featured pricing card and
  the closing CTA. Everything else is ink & white.
- **Type.** Geist for display, Inter for body. Weight ≤600. Hierarchy via ink opacity, not grays.
- **Motion.** One easing curve (`lib/motion.ts` `EASE`), entrances 0.6–0.9s, whileInView once.
  `prefers-reduced-motion` collapses all CSS animation globally and gates every JS animation.

## Develop

```bash
npm run dev     # http://localhost:3000
npm run build   # production build
npx tsc --noEmit
```

Audio demo assets were generated with ElevenLabs (`eleven_multilingual_v2`).
