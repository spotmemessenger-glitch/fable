"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";
import s from "./privacy-shield-3d.module.css";

/**
 * PrivacyShield3D — the privacy visual as a true CSS-3D object: twelve
 * extruded slices give the shield thickness, a glass face carries the
 * padlock, compliance badges orbit it in 3D, and intercepted packets are
 * deflected off a force-field dome (feeding the "threats blocked" counter).
 * Every few seconds a verify pulse sweeps the shield and the lock re-seats.
 *
 * Site conventions: fills its container (the source was a fixed 660×560
 * card), orbit radius scales with the box so badges never overflow on
 * phones, all timers pause offscreen and on hidden tabs, and
 * prefers-reduced-motion renders one settled frame with no loops.
 */

const SLICES = 12;
const THICKNESS = 26;

const BADGES = [
  { text: "GDPR READY", dot: "#22b573", y: -46 },
  { text: "SOC 2 · IN PROGRESS", dot: "#f5a623", y: 34 },
  { text: "AES-256", dot: "#7b5cff", y: 96 },
  { text: "E2E ENCRYPTED", dot: "#4f8dff", y: -102 },
  { text: "0 BREACHES · EVER", dot: "#ff3b47", y: -18 },
];

export default function PrivacyShield3D({ className }: { className?: string }) {
  const reduce = useReducedMotion() ?? false;
  const stageRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLDivElement>(null);
  const domeRef = useRef<HTMLDivElement>(null);
  const lockRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const scanRef = useRef<HTMLDivElement>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLElement>(null);
  const badgeRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const stage = stageRef.current;
    const wrap = wrapRef.current;
    const shadow = shadowRef.current;
    const dome = domeRef.current;
    if (!stage || !wrap || !shadow || !dome) return;

    if (reduce) {
      wrap.style.transform = "rotateX(8deg) rotateY(-14deg)";
      badgeRefs.current.forEach((el, i) => {
        if (!el) return;
        const a = (i / BADGES.length) * Math.PI * 2;
        el.style.transform = `translate(-50%,-50%) translate(${Math.sin(a) * 130}px, ${BADGES[i].y}px)`;
      });
      return;
    }

    let ry = -14,
      rx = 8,
      tryY = -14,
      trx = 8;
    let auto = true;
    let dragging = false;
    let lx = 0,
      ly = 0,
      mx = 0,
      my = 0;
    let raf = 0;
    let inView = false;
    let pageVisible = !document.hidden;
    let t = 0;
    let pt = 0;
    /* orbit radius tracks the box so badges stay inside on small screens */
    let orbitR = 150;
    let domeR = 150;

    const measure = () => {
      const r = stage.getBoundingClientRect();
      if (r.width <= 0) return;
      /* A badge is centred on the orbit, so it needs half its own width of
         clearance too — sizing the orbit off the box alone clipped the wider
         badges ("SOC 2 · IN PROGRESS") against the card on phones. */
      const widest = badgeRefs.current.reduce(
        (w, el) => Math.max(w, el?.getBoundingClientRect().width ?? 0),
        0,
      );
      const roomy = Math.min(r.width, r.height) * 0.42;
      const fits = r.width / 2 - widest / 2 - 6;
      orbitR = Math.max(64, Math.min(roomy, fits));
      /* Below this the badges would sit on top of the shield — drop them and
         let the shield carry the frame on its own. */
      const tooTight = fits < 78;
      badgeRefs.current.forEach((el) => {
        if (el) el.style.display = tooTight ? "none" : "";
      });
      domeR = Math.min(orbitR * 1.06, Math.min(r.width, r.height) * 0.46);
      dome.style.width = `${domeR * 2}px`;
      dome.style.height = `${domeR * 2}px`;
    };
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    measure();

    const frame = (now: number) => {
      if (pt === 0) pt = now;
      const dt = Math.min(0.05, (now - pt) / 1000);
      pt = now;
      t += dt;
      if (auto && !dragging) {
        tryY = -14 + Math.sin(t * 0.4) * 16 + mx * 6;
        trx = 8 + Math.sin(t * 0.27) * 3 - my * 5;
      }
      ry += (tryY - ry) * Math.min(1, dt * 6);
      rx += (trx - rx) * Math.min(1, dt * 6);
      const fl = Math.sin(t * 1.0) * 6;
      wrap.style.transform = `translateY(${fl}px) rotateX(${rx}deg) rotateY(${ry}deg)`;
      shadow.style.transform = `translateX(-50%) scale(${1 - fl / 120}, 1)`;

      const A = t * 0.55;
      badgeRefs.current.forEach((el, i) => {
        if (!el) return;
        const a = A + (i / BADGES.length) * Math.PI * 2;
        const x = Math.sin(a) * orbitR;
        const z = Math.cos(a) * orbitR;
        const sc = 0.82 + ((z + orbitR) / (2 * orbitR)) * 0.28;
        el.style.transform = `translate(-50%,-50%) translate(${x}px, ${
          BADGES[i].y + Math.sin(t * 1.3 + i) * 6
        }px) scale(${sc})`;
        el.style.zIndex = z > 0 ? "12" : "2";
        el.style.opacity = z > 0 ? "1" : "0.55";
        el.style.filter = z > 0 ? "none" : "blur(1.2px)";
      });
      raf = requestAnimationFrame(frame);
    };

    /* ------------------------------------------- verify pulse + packets */
    let blocked = 12482;
    const timeouts: number[] = [];
    const later = (fn: () => void, ms: number) => {
      timeouts.push(window.setTimeout(fn, ms));
    };

    const verify = () => {
      const scan = scanRef.current;
      const lock = lockRef.current;
      const inner = innerRef.current;
      const toast = toastRef.current;
      if (!scan || !lock || !inner || !toast) return;
      scan.style.transition = "none";
      scan.style.top = "4%";
      scan.style.opacity = "1";
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          scan.style.transition = "top 1.1s ease-in-out, opacity .4s .9s";
          scan.style.top = "88%";
          scan.style.opacity = "0";
        }),
      );
      later(() => lock.classList.add(s.lockOpen), 350);
      later(() => {
        lock.classList.remove(s.lockOpen);
        const rip = document.createElement("div");
        rip.className = s.lockRip;
        inner.appendChild(rip);
        later(() => rip.remove(), 950);
        toast.classList.add(s.toastShow);
        later(() => toast.classList.remove(s.toastShow), 2100);
      }, 1050);
    };

    const packet = () => {
      const W = stage.clientWidth;
      const H = stage.clientHeight;
      if (W <= 0) return;
      const p = document.createElement("div");
      p.className = s.pkt;
      const side = Math.floor(Math.random() * 4);
      let x0: number, y0: number;
      if (side === 0) {
        x0 = -30;
        y0 = Math.random() * H;
      } else if (side === 1) {
        x0 = W + 30;
        y0 = Math.random() * H;
      } else if (side === 2) {
        x0 = Math.random() * W;
        y0 = -30;
      } else {
        x0 = Math.random() * W;
        y0 = H + 30;
      }
      const cx = W / 2;
      const cy = H * 0.52;
      const ang = Math.atan2(cy - y0, cx - x0);
      const hx = cx - Math.cos(ang) * (orbitR * 0.9);
      const hy = cy - Math.sin(ang) * (orbitR * 0.9);
      p.style.cssText = `left:${x0}px;top:${y0}px;background:${
        Math.random() < 0.72 ? "#ff3b47" : "#ff7a2e"
      };transition:left 1.15s cubic-bezier(.3,.1,.6,1), top 1.15s cubic-bezier(.3,.1,.6,1), opacity .3s 1s`;
      stage.appendChild(p);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          p.style.left = `${hx}px`;
          p.style.top = `${hy}px`;
          p.style.opacity = "0";
        }),
      );
      later(() => {
        const rip = document.createElement("div");
        rip.className = s.rip;
        rip.style.left = `${hx}px`;
        rip.style.top = `${hy}px`;
        rip.style.transform = "translate(-50%,-50%)";
        stage.appendChild(rip);
        later(() => rip.remove(), 1050);
        p.remove();
        /* the dome flushes red for a beat at the point of impact */
        dome.classList.add(s.domeHit);
        later(() => dome.classList.remove(s.domeHit), 380);
        blocked++;
        if (countRef.current) countRef.current.textContent = blocked.toLocaleString("en-US");
      }, 1150);
    };

    let verifyIv = 0;
    let packetIv = 0;
    const startLoops = () => {
      if (!verifyIv) verifyIv = window.setInterval(verify, 5600);
      if (!packetIv) packetIv = window.setInterval(packet, 1300);
    };
    const stopLoops = () => {
      window.clearInterval(verifyIv);
      window.clearInterval(packetIv);
      verifyIv = 0;
      packetIv = 0;
    };

    const running = () => inView && pageVisible;
    const sync = () => {
      if (running()) {
        if (raf === 0) {
          pt = 0;
          raf = requestAnimationFrame(frame);
        }
        startLoops();
      } else {
        if (raf !== 0) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        stopLoops();
      }
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry) {
          const wasIdle = !inView;
          inView = entry.isIntersecting;
          sync();
          if (inView && wasIdle) later(verify, 900); // greet on arrival
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

    /* drag to rotate; double-click toggles the auto sway */
    const onDown = (e: PointerEvent) => {
      dragging = true;
      auto = false;
      lx = e.clientX;
      ly = e.clientY;
      stage.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      tryY += (e.clientX - lx) * 0.5;
      trx = Math.max(-32, Math.min(38, trx - (e.clientY - ly) * 0.35));
      lx = e.clientX;
      ly = e.clientY;
    };
    const onUp = () => {
      dragging = false;
    };
    const onDbl = () => {
      auto = !auto;
    };
    const onWinMove = (e: PointerEvent) => {
      mx = (e.clientX / window.innerWidth - 0.5) * 2;
      my = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    stage.addEventListener("pointerdown", onDown);
    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerup", onUp);
    stage.addEventListener("pointercancel", onUp);
    stage.addEventListener("dblclick", onDbl);
    window.addEventListener("pointermove", onWinMove, { passive: true });

    sync();

    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      stopLoops();
      timeouts.forEach((x) => window.clearTimeout(x));
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      stage.removeEventListener("pointerdown", onDown);
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerup", onUp);
      stage.removeEventListener("pointercancel", onUp);
      stage.removeEventListener("dblclick", onDbl);
      window.removeEventListener("pointermove", onWinMove);
      stage.querySelectorAll(`.${s.pkt}, .${s.rip}`).forEach((n) => n.remove());
    };
  }, [reduce]);

  return (
    <div
      ref={stageRef}
      className={`${s.stage} ${className ?? ""}`}
      role="img"
      aria-label="A 3D shield with a padlock, encircled by GDPR, SOC 2, AES-256 and end-to-end-encryption badges, deflecting incoming threats"
    >
      <div ref={toastRef} className={s.toast} aria-hidden>
        ✓ Verified · AES-256
      </div>
      <div className={s.counter} aria-hidden>
        <i />
        THREATS BLOCKED{" "}
        <b ref={countRef as React.RefObject<HTMLElement>}>12,482</b>
      </div>

      <div ref={domeRef} className={s.dome} aria-hidden />
      <div ref={shadowRef} className={s.shadow} aria-hidden />

      <div ref={wrapRef} className={s.shieldWrap} aria-hidden>
        {Array.from({ length: SLICES }, (_, i) => (
          <div
            key={i}
            className={`${s.sh} ${i === SLICES - 1 ? s.face : s.body}`}
            style={{
              transform: `translateZ(${-THICKNESS / 2 + i * (THICKNESS / (SLICES - 1))}px)`,
            }}
          />
        ))}
        <div ref={innerRef} className={`${s.sh} ${s.inner}`}>
          <div ref={lockRef} className={s.lock}>
            <div className={s.shackle} />
            <div className={s.lockBody}>
              <div className={s.keyhole} />
            </div>
          </div>
        </div>
        <div ref={scanRef} className={s.scanBeam} />
      </div>

      {BADGES.map((b, i) => (
        <div
          key={b.text}
          ref={(el) => {
            badgeRefs.current[i] = el;
          }}
          className={s.badge}
          aria-hidden
        >
          <i style={{ background: b.dot }} />
          {b.text}
        </div>
      ))}
    </div>
  );
}
