"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import s from "./hero-device-3d.module.css";

/**
 * HeroDevice3D — the hero phone as a true CSS-3D object. Fifteen stacked body
 * slices give it real thickness; the front face carries the Voice Translator
 * screen (matching the real app), the back a titanium camera plateau. A rAF
 * loop sways it (drag to rotate, double-click toggles the auto sway).
 *
 * Site conventions: scales to its container (the source banner was a fixed
 * 540×800 stage), pauses offscreen and on hidden tabs, and renders a static
 * three-quarter pose under prefers-reduced-motion.
 */

/* ------------------------------------------------------------------ body */

const SLICES = 15;
const THICKNESS = 34;
const STAGE_W = 540;
const STAGE_H = 800;

/* animated equalizer bars — count only; heights come from CSS keyframes */
const WAVE_BARS = Array.from({ length: 22 });

export default function HeroDevice3D({ className }: { className?: string }) {
  const reduce = useReducedMotion() ?? false;
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const phRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  /* Fit the fixed 540×800 stage into whatever box the hero gives us. The +70
     height headroom keeps the phone's bottom edge inside the section even at
     the deepest perspective tilt — the hero clips overflow, and without slack
     the projected bottom of the phone swings past the fold and gets cut. */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      if (r.width > 0 && r.height > 0)
        setScale(Math.min(r.width / STAGE_W, r.height / (STAGE_H + 70)));
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  /* 3D sway + drag rotation */
  useEffect(() => {
    const stage = stageRef.current;
    const ph = phRef.current;
    const shadow = shadowRef.current;
    if (!stage || !ph || !shadow) return;

    if (reduce) {
      ph.style.transform = "rotateX(6deg) rotateY(-18deg)";
      return;
    }

    let ry = -18,
      rx = 6,
      tryY = -18,
      trx = 6;
    let auto = true;
    let dragging = false;
    let lx = 0,
      ly = 0;
    let raf = 0;
    let inView = true;
    let pageVisible = !document.hidden;
    let t = Math.random() * 20;
    let pt = 0;

    const frame = (now: number) => {
      if (pt === 0) pt = now;
      const dt = Math.min(0.05, (now - pt) / 1000);
      pt = now;
      t += dt;
      if (auto && !dragging) {
        tryY = -18 + Math.sin(t * 0.5) * 26;
        trx = 6 + Math.sin(t * 0.33) * 4;
      }
      ry += (tryY - ry) * Math.min(1, dt * 7);
      rx += (trx - rx) * Math.min(1, dt * 7);
      const fl = Math.sin(t * 1.1) * 7;
      ph.style.transform = `translateY(${fl}px) rotateX(${rx}deg) rotateY(${ry}deg)`;
      shadow.style.transform = `translateX(-50%) scale(${1 - fl / 160}, 1)`;
      shadow.style.opacity = `${0.75 - fl / 60}`;
      raf = requestAnimationFrame(frame);
    };
    const running = () => inView && pageVisible;
    const start = () => {
      if (raf === 0 && running()) {
        pt = 0;
        raf = requestAnimationFrame(frame);
      }
    };
    const stop = () => {
      if (raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    const sync = () => (running() ? start() : stop());

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry) {
          inView = entry.isIntersecting;
          sync();
        }
      },
      { rootMargin: "80px" },
    );
    io.observe(stage);
    const onVis = () => {
      pageVisible = !document.hidden;
      sync();
    };
    document.addEventListener("visibilitychange", onVis);

    const onDown = (e: PointerEvent) => {
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
      stage.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      tryY += (e.clientX - lx) * 0.45;
      trx = Math.max(-40, Math.min(40, trx - (e.clientY - ly) * 0.3));
      lx = e.clientX;
      ly = e.clientY;
      auto = false;
    };
    const onUp = () => {
      dragging = false;
    };
    const onDbl = () => {
      auto = !auto;
    };
    stage.addEventListener("pointerdown", onDown);
    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerup", onUp);
    stage.addEventListener("pointercancel", onUp);
    stage.addEventListener("dblclick", onDbl);

    sync();

    return () => {
      stop();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      stage.removeEventListener("pointerdown", onDown);
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerup", onUp);
      stage.removeEventListener("pointercancel", onUp);
      stage.removeEventListener("dblclick", onDbl);
    };
  }, [reduce]);

  return (
    /* items-start: anchor the phone to the top so all fit slack goes below it —
       lifting it clear of the section fold rather than centering into it */
    <div ref={wrapRef} className={`flex h-full w-full items-start justify-center ${className ?? ""}`}>
      <div
        ref={stageRef}
        className={s.stage}
        style={{ transform: `scale(${scale})`, transformOrigin: "top center" }}
      >
        <div ref={phRef} className={s.ph}>
          {/* body slices — the phone's physical thickness */}
          {Array.from({ length: SLICES }, (_, i) => (
            <div
              key={i}
              className={`${s.layer} ${s.slice} ${i === 0 || i === SLICES - 1 ? s.edge : ""}`}
              style={{
                transform: `translateZ(${-THICKNESS / 2 + i * (THICKNESS / (SLICES - 1))}px)`,
              }}
            />
          ))}

          {/* back face — titanium glass + camera plateau */}
          <div className={`${s.layer} ${s.backFace}`}>
            <div className={s.glass}>
              <div className={s.plateau}>
                <div className={`${s.lens} ${s.l1}`} />
                <div className={`${s.lens} ${s.l2}`} />
                <div className={`${s.lens} ${s.l3}`} />
                <div className={`${s.dotf} ${s.flash}`} />
                <div className={`${s.dotf} ${s.lidar}`} />
                <div className={`${s.dotf} ${s.micd}`} />
              </div>
              <div className={s.blogo}>
                <div className={s.yl}>
                  Y<b>snap</b>
                </div>
                <div className={s.bsub}>TRANSLATE</div>
              </div>
              <div className={s.imprint}>YSNAP EDITION · COSMIC ORANGE · TITANIUM</div>
            </div>
          </div>

          {/* front face — bezel, island, Voice Translator screen */}
          <div className={`${s.layer} ${s.front}`}>
            <div className={s.bez}>
              <div className={s.island} />
              <div className={s.screen}>
                <div className={s.sbar}>
                  <span>9:41</span>
                  <span className={s.sic}>
                    <svg width="17" height="11" viewBox="0 0 17 11" aria-hidden>
                      <g fill="#111">
                        <rect x="0" y="7" width="3" height="4" rx="1" />
                        <rect x="4.5" y="5" width="3" height="6" rx="1" />
                        <rect x="9" y="2.5" width="3" height="8.5" rx="1" />
                        <rect x="13.5" y="0" width="3" height="11" rx="1" />
                      </g>
                    </svg>
                    <svg width="15" height="11" viewBox="0 0 15 11" aria-hidden>
                      <path d="M7.5 10.5 L1 4 A9.2 9.2 0 0 1 14 4 Z" fill="#111" />
                    </svg>
                    <svg width="25" height="12" viewBox="0 0 25 12" aria-hidden>
                      <rect x="0.5" y="0.5" width="20" height="11" rx="3.5" fill="none" stroke="#111" opacity=".4" />
                      <rect x="2" y="2" width="14" height="8" rx="2" fill="#111" />
                      <rect x="22" y="3.5" width="2.5" height="5" rx="1.2" fill="#111" opacity=".4" />
                    </svg>
                  </span>
                </div>

                {/* header */}
                <div className={s.vhead}>
                  <span className={s.vback} aria-hidden />
                  <span className={s.vtitle}>Voice Translator</span>
                  <span className={s.vgear} aria-hidden />
                </div>

                {/* language pair */}
                <div className={s.langpair}>
                  <div className={s.lang}>
                    <span className={s.langcode}>ES</span>
                    <span className={s.langname}>Spanish</span>
                  </div>
                  <div className={s.swap} aria-hidden>
                    <svg viewBox="0 0 24 24" fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M7 4 3 8l4 4" />
                      <path d="M3 8h14" />
                      <path d="m17 20 4-4-4-4" />
                      <path d="M21 16H7" />
                    </svg>
                  </div>
                  <div className={`${s.lang} ${s.langto}`}>
                    <span className={s.langcode}>EN</span>
                    <span className={s.langname}>English</span>
                  </div>
                </div>

                {/* live voice-translation card */}
                <div className={s.vcard}>
                  <div className={s.vlabel}>
                    <span className={s.vlwave} aria-hidden>
                      <i /><i /><i />
                    </span>
                    VOICE TRANSLATION
                  </div>
                  <div className={s.vorig}>“¿Dónde nos vemos?”</div>
                  <div className={s.wave} aria-hidden>
                    {WAVE_BARS.map((_, i) => (
                      <span key={i} style={{ animationDelay: `${(i % 11) * 0.09}s` }} />
                    ))}
                  </div>
                  <div className={s.vtrans}>
                    <span className={s.g}>⊕</span>
                    Where shall we meet?
                  </div>
                </div>

                {/* mic */}
                <div className={s.micwrap}>
                  <button className={s.micbig} type="button" aria-hidden tabIndex={-1}>
                    <span className={s.ring} />
                    <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" aria-hidden>
                      <rect x="9" y="3" width="6" height="11" rx="3" />
                      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
                      <line x1="12" y1="18" x2="12" y2="21" />
                    </svg>
                  </button>
                  <div className={s.mictext}>Listening…</div>
                </div>

                {/* recent */}
                <div className={s.recent}>
                  <div className={s.recenth}>Recent translations</div>
                  <div className={s.rrow}>
                    <span className={s.ric} aria-hidden>
                      <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" aria-hidden>
                        <rect x="9" y="3" width="6" height="11" rx="3" />
                        <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
                        <line x1="12" y1="18" x2="12" y2="21" />
                      </svg>
                    </span>
                    <span className={s.rtext}>
                      <span className={s.rt1}>Perfect, see you soon</span>
                      <span className={s.rt2}>auto → EN · just now</span>
                    </span>
                    <span className={s.rchev} aria-hidden />
                  </div>
                </div>

                <div className={s.hbar}>
                  <i />
                </div>
                <div className={s.sheen} />
              </div>
            </div>
          </div>

          {/* side buttons */}
          <div className={`${s.btn} ${s.bAct}`} />
          <div className={`${s.btn} ${s.bV1}`} />
          <div className={`${s.btn} ${s.bV2}`} />
          <div className={`${s.btn} ${s.bPwr}`} />
          <div className={`${s.btn} ${s.bCam}`} />
        </div>
        <div ref={shadowRef} className={s.shadow} />
      </div>
    </div>
  );
}
