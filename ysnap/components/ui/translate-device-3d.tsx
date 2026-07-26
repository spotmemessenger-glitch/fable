"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { YsnapMark } from "@/components/ui/ysnap-mark";
import s from "./translate-device-3d.module.css";

/**
 * TranslateDevice3D — the translation section's phone as a true CSS-3D
 * object in deep-blue titanium. Language chips orbit the stage in parallax,
 * then fly into the viewfinder one by one and land as a detected message +
 * live translation. Drag rotates; double-click toggles the auto sway.
 *
 * Port notes: responsive (fixed 700×820 scene scales to its container),
 * pauses offscreen and on hidden tabs, reduced-motion renders a static pose
 * with one settled exchange and parked chips. The speaker glyph on outgoing
 * bubbles is visual only — no browser TTS on a marketing page.
 */

type Lang = {
  chip: string;
  dot: string;
  code: string;
  name: string;
  orig: string;
  tr: string;
  x: number; // % of scene
  y: number;
  z: number; // parallax depth
};

const LANGS: Lang[] = [
  { chip: "Hola", dot: "#2fb47c", code: "ES", name: "Spanish", orig: "¿Dónde está la estación?", tr: "Where is the station?", x: 10, y: 16, z: 120 },
  { chip: "你好", dot: "#ff5e62", code: "ZH", name: "Chinese", orig: "附近有好餐厅吗？", tr: "Any good restaurants nearby?", x: 84, y: 12, z: 90 },
  { chip: "Hello", dot: "#ffb02a", code: "EN", name: "English", orig: "Can you help me?", tr: "¿Puedes ayudarme?", x: 90, y: 44, z: 150 },
  { chip: "مرحبا", dot: "#2fb47c", code: "AR", name: "Arabic", orig: "كم سعر التذكرة؟", tr: "How much is the ticket?", x: 6, y: 56, z: 100 },
  { chip: "नमस्ते", dot: "#ff4f9a", code: "HI", name: "Hindi", orig: "मुझे रास्ता बताइए", tr: "Please show me the way", x: 86, y: 78, z: 130 },
  { chip: "Olá", dot: "#6d5df6", code: "PT", name: "Portuguese", orig: "Que horas são agora?", tr: "What time is it now?", x: 12, y: 86, z: 110 },
  { chip: "Bonjour", dot: "#4d7ef0", code: "FR", name: "French", orig: "Où est le musée ?", tr: "Where is the museum?", x: 4, y: 32, z: 140 },
  { chip: "こんにちは", dot: "#ff8f47", code: "JA", name: "Japanese", orig: "駅はどこですか？", tr: "Where is the station?", x: 88, y: 28, z: 70 },
];

type NewChatItem =
  | { kind: "det"; dot: string; name: string }
  | { kind: "in"; text: string }
  | { kind: "out"; text: string }
  | { kind: "meta"; text: string };
type ChatItem = NewChatItem & { id: number };

const SCENE_W = 700;
const SCENE_H = 820;
const SLICES = 15;
const THICKNESS = 34;

function SpkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 9v6h4l5 4V5L8 9H4z" />
      <path
        d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"
        fill="none"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MicSvg() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <line x1="12" y1="18" x2="12" y2="21" />
    </svg>
  );
}

export default function TranslateDevice3D({ className }: { className?: string }) {
  const reduce = useReducedMotion() ?? false;
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const phRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [scale, setScale] = useState(1);
  const [pair, setPair] = useState<{ from: string; to: string }>({ from: "ES", to: "EN" });
  const [items, setItems] = useState<ChatItem[]>(() =>
    reduce
      ? [
          { id: 0, kind: "det", dot: LANGS[0].dot, name: LANGS[0].name },
          { id: 1, kind: "in", text: LANGS[0].orig },
          { id: 2, kind: "out", text: LANGS[0].tr },
          { id: 3, kind: "meta", text: "English · under 200 ms" },
        ]
      : [],
  );

  /* responsive fit — the scene keeps its fixed design size and scales down */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      if (r.width > 0) setScale(Math.min(1, r.width / SCENE_W));
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  /* sway + parallax + chip float + fly-in message cycle */
  useEffect(() => {
    const scene = sceneRef.current;
    const stage = stageRef.current;
    const ph = phRef.current;
    const shadow = shadowRef.current;
    if (!scene || !stage || !ph || !shadow) return;

    if (reduce) {
      ph.style.transform = "rotateX(6deg) rotateY(-16deg)";
      return;
    }

    let ry = -16,
      rx = 6,
      tryY = -16,
      trx = 6;
    let auto = true;
    let dragging = false;
    let lx = 0,
      ly = 0,
      mx = 0,
      my = 0;
    let raf = 0;
    let inView = true;
    let pageVisible = !document.hidden;
    let t = Math.random() * 20;
    let pt = 0;
    const flying = new Set<number>();
    const phases = LANGS.map(() => Math.random() * 7);

    const frame = (now: number) => {
      if (pt === 0) pt = now;
      const dt = Math.min(0.05, (now - pt) / 1000);
      pt = now;
      t += dt;
      if (auto && !dragging) {
        tryY = -16 + Math.sin(t * 0.45) * 20 + mx * 7;
        trx = 6 + Math.sin(t * 0.3) * 3 - my * 5;
      }
      ry += (tryY - ry) * Math.min(1, dt * 6);
      rx += (trx - rx) * Math.min(1, dt * 6);
      const fl = Math.sin(t * 1.05) * 7;
      ph.style.transform = `translateY(${fl}px) rotateX(${rx}deg) rotateY(${ry}deg)`;
      shadow.style.transform = `translateX(-50%) scale(${1 - fl / 150}, 1)`;
      shadow.style.opacity = `${0.8 - fl / 55}`;
      chipRefs.current.forEach((el, i) => {
        if (!el || flying.has(i)) return;
        const k = LANGS[i].z / 120;
        el.style.transform = `translate(-50%,-50%) translate(${mx * k * 26}px, ${
          my * k * 18 + Math.sin(t * 1.2 + phases[i]) * 8
        }px) scale(${1 + LANGS[i].z / 900})`;
      });
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
    io.observe(scene);
    const onVis = () => {
      pageVisible = !document.hidden;
      sync();
    };
    document.addEventListener("visibilitychange", onVis);

    /* pointer: drag on stage rotates; window move drives parallax */
    const onDown = (e: PointerEvent) => {
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
      stage.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      tryY += (e.clientX - lx) * 0.45;
      trx = Math.max(-38, Math.min(38, trx - (e.clientY - ly) * 0.3));
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
    const onWinMove = (e: PointerEvent) => {
      mx = (e.clientX / innerWidth - 0.5) * 2;
      my = (e.clientY / innerHeight - 0.5) * 2;
    };
    stage.addEventListener("pointerdown", onDown);
    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerup", onUp);
    stage.addEventListener("pointercancel", onUp);
    stage.addEventListener("dblclick", onDbl);
    window.addEventListener("pointermove", onWinMove, { passive: true });

    /* --------------------------- fly-in → translate message cycle */
    let idx = 0;
    let nextId = 100;
    let dead = false;
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => {
      timers.push(window.setTimeout(() => (dead ? undefined : fn()), ms));
    };
    const push = (batch: NewChatItem[]) =>
      setItems((prev) => [...prev, ...batch.map((b) => ({ ...b, id: nextId++ }))].slice(-6));

    const cycle = () => {
      if (!running()) {
        later(cycle, 1200); // parked offscreen — retry without advancing
        return;
      }
      const i = idx % LANGS.length;
      idx++;
      const L = LANGS[i];
      const el = chipRefs.current[i];
      if (el) {
        const cr = el.getBoundingClientRect();
        const pr = ph.getBoundingClientRect();
        const tx = pr.left + pr.width / 2 - (cr.left + cr.width / 2);
        const ty = pr.top + pr.height * 0.42 - (cr.top + cr.height / 2);
        flying.add(i);
        el.classList.add(s.fly);
        el.style.transform = `translate(-50%,-50%) translate(${tx}px,${ty}px) scale(.18)`;
        el.style.opacity = "0";
      }
      later(() => {
        setPair({ from: L.code, to: L.code === "EN" ? "ES" : "EN" });
        push([
          { kind: "det", dot: L.dot, name: L.name },
          { kind: "in", text: L.orig },
        ]);
        later(() => {
          push([
            { kind: "out", text: L.tr },
            { kind: "meta", text: `${L.code === "EN" ? "Spanish" : "English"} · under 200 ms` },
          ]);
        }, 650);
        /* respawn the chip back at its home position */
        later(() => {
          if (el) {
            el.classList.remove(s.fly);
            el.classList.add(s.hid);
            el.style.transform = "translate(-50%,-50%)";
            later(() => {
              el.classList.remove(s.hid);
              el.style.opacity = "1";
              flying.delete(i);
            }, 900);
          }
        }, 300);
      }, 1050);
      later(cycle, 4600);
    };
    later(cycle, 1400);

    sync();

    return () => {
      dead = true;
      stop();
      timers.forEach((x) => window.clearTimeout(x));
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      stage.removeEventListener("pointerdown", onDown);
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerup", onUp);
      stage.removeEventListener("pointercancel", onUp);
      stage.removeEventListener("dblclick", onDbl);
      window.removeEventListener("pointermove", onWinMove);
    };
  }, [reduce]);

  return (
    <div
      ref={wrapRef}
      /* flex + justify-center is load-bearing, not cosmetic. The scene's
         layout box stays 700px wide however narrow the wrapper gets, so with
         it as a plain block child its box starts at the wrapper's left edge
         and its centre lands ~350px to the right — off-screen on a phone.
         Scaling about that centre pushed the device off the right edge and
         clipped it. Flex-centring the box first means the centre is always
         the wrapper's centre, so the scaled result stays put at any width.
         This mirrors hero-device-3d, which was already correct for this
         reason. */
      className={`relative mx-auto flex w-full max-w-[700px] justify-center ${className ?? ""}`}
      style={{ height: SCENE_H * scale }}
    >
      <div
        ref={sceneRef}
        className={s.scene}
        style={{ transform: `scale(${scale})`, transformOrigin: "top center" }}
      >
        <div ref={stageRef} className={s.stage}>
          <div ref={phRef} className={s.ph}>
            {Array.from({ length: SLICES }, (_, i) => (
              <div
                key={i}
                className={`${s.layer} ${s.slice} ${i === 0 || i === SLICES - 1 ? s.edge : ""}`}
                style={{
                  transform: `translateZ(${-THICKNESS / 2 + i * (THICKNESS / (SLICES - 1))}px)`,
                }}
              />
            ))}

            {/* back face */}
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
                  <div className={s.bsub}>CHAT</div>
                </div>
                <div className={s.imprint}>YSNAP EDITION · DEEP BLUE · LIVE TRANSLATE</div>
              </div>
            </div>

            {/* front face — live translate screen */}
            <div className={`${s.layer} ${s.front}`}>
              <div className={s.bez}>
                <div className={s.island} />
                <div className={s.screen}>
                  <YsnapMark tone="blue" className={s.brandMark} />
                  <div className={s.brand}>
                    <b>Ysnap</b> chat
                  </div>
                  <div className={s.pill}>
                    <span>{pair.from}</span>
                    <span className={s.arr}>→</span>
                    <span>{pair.to}</span>
                  </div>
                  <div className={s.chat}>
                    {items.map((it) => {
                      if (it.kind === "det")
                        return (
                          <div key={it.id} className={s.det}>
                            <i style={{ background: it.dot }} />
                            {it.name} · detected
                          </div>
                        );
                      if (it.kind === "in")
                        return (
                          <div key={it.id} className={`${s.bub} ${s.bubIn}`}>
                            {it.text}
                          </div>
                        );
                      if (it.kind === "out")
                        return (
                          <div key={it.id} className={`${s.bub} ${s.bubOut}`}>
                            <span>{it.text}</span>
                            <span className={s.spk}>
                              <SpkIcon />
                            </span>
                          </div>
                        );
                      return (
                        <div key={it.id} className={s.meta}>
                          {it.text}
                        </div>
                      );
                    })}
                    <div className={s.listen}>
                      <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" aria-hidden>
                        <rect x="9" y="3" width="6" height="11" rx="3" />
                        <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
                      </svg>
                      Listening
                      <span className={s.dts}>
                        <i />
                        <i />
                        <i />
                      </span>
                    </div>
                  </div>
                  <div className={s.foot}>
                    <div className={s.field}>
                      Type or speak<span className={s.caret} />
                    </div>
                    <div className={s.micb}>
                      <MicSvg />
                    </div>
                  </div>
                  <div className={s.hbar}>
                    <i />
                  </div>
                  <div className={s.sheen} />
                </div>
              </div>
            </div>

            <div className={`${s.btn} ${s.bAct}`} />
            <div className={`${s.btn} ${s.bV1}`} />
            <div className={`${s.btn} ${s.bV2}`} />
            <div className={`${s.btn} ${s.bPwr}`} />
            <div className={`${s.btn} ${s.bCam}`} />
          </div>
          <div ref={shadowRef} className={s.shadow} />
        </div>

        {/* orbiting language chips — fly into the screen one by one */}
        {LANGS.map((L, i) => (
          <div
            key={L.code}
            ref={(el) => {
              chipRefs.current[i] = el;
            }}
            className={s.lchip}
            style={{ left: `${L.x}%`, top: `${L.y}%`, transform: "translate(-50%,-50%)" }}
            aria-hidden
          >
            <i style={{ background: L.dot }} />
            {L.chip}
          </div>
        ))}
      </div>
    </div>
  );
}
