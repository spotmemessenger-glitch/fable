/* Holographic lighting rig for the custom Iron Man core.
   Everything here is light drawn over the SVG figure (screen-blended canvas):
     - audio-ripple rings radiating from the arc reactor
     - drifting spark particles
     - a holographic scan sweep
     - a reactor bloom that pulses with the voice
   Plus it drives the SVG figure directly: glowing eyes, the reactor core, and
   a segmented MOUTH EQUALIZER whose bars follow the actual speech frequencies,
   so the mouth articulates with the words rather than just the volume.
   No dependencies. */

(function () {
  "use strict";

  const canvas = document.getElementById("reactor");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height, CX = W / 2;
  // Arc-reactor centre as a fraction of the stage. The figure is 90% tall,
  // grid-centred, so its reactor (SVG y=352/400=0.88) sits at 0.05 + 0.88*0.90.
  const RX = W * 0.5, RY = H * 0.842;

  const state = { level: 0, target: 0, mode: "idle", t: 0 };
  window.reactorState = state;

  const GOLD = [255, 208, 92], CYAN = [130, 224, 255];
  const MODE_LABEL = { idle: "ONLINE", listening: "LISTENING", thinking: "PROCESSING", speaking: "SPEAKING" };

  // --- SVG handles ---
  let eyeL = null, eyeR = null, core = null;
  const bars = [];
  const NBARS = 9, BAR_BOTTOM = 260;
  function buildSvg() {
    eyeL = document.getElementById("eye-l");
    eyeR = document.getElementById("eye-r");
    core = document.getElementById("reactor-core");
    const g = document.getElementById("mouth-bars");
    if (g && !bars.length) {
      const SVGNS = "http://www.w3.org/2000/svg";
      const wBar = 4, span = 228 - 172, gap = (span - NBARS * wBar) / (NBARS - 1);
      for (let i = 0; i < NBARS; i++) {
        const r = document.createElementNS(SVGNS, "rect");
        r.setAttribute("x", (172 + i * (wBar + gap)).toFixed(1));
        r.setAttribute("width", wBar);
        r.setAttribute("rx", "1.4");
        r.setAttribute("fill", "url(#barGrad)");
        r.setAttribute("y", (BAR_BOTTOM - 3).toFixed(1));
        r.setAttribute("height", "3");
        g.appendChild(r);
        bars.push(r);
      }
    }
  }
  buildSvg();

  const lerp = (a, b, k) => a + (b - a) * k;
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const rnd = () => Math.random();

  // --- particles + ripples ---
  const sparks = [];
  for (let i = 0; i < 46; i++) sparks.push(makeSpark(true));
  function makeSpark(init) {
    return {
      x: CX + (rnd() - 0.5) * W * 0.72,
      y: init ? H * (0.1 + rnd() * 0.85) : H * 0.94,
      vx: (rnd() - 0.5) * 0.35, vy: -(0.18 + rnd() * 0.6),
      life: 0.4 + rnd() * 0.6, tw: rnd() * 6.28,
    };
  }
  const ripples = [];
  let rippleTimer = 0, scanY = -60;

  function draw() {
    state.t += 0.016;
    state.level = lerp(state.level, state.target, 0.28);
    const L = state.level, t = state.t;

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter"; // additive light

    // drifting sparks
    for (const s of sparks) {
      s.x += s.vx; s.y += s.vy; s.life -= 0.006;
      if (s.life <= 0 || s.y < H * 0.06) Object.assign(s, makeSpark(false));
      const a = Math.max(0, s.life) * (0.4 + 0.6 * Math.sin(t * 3 + s.tw));
      ctx.fillStyle = rgba(GOLD, a * 0.6);
      ctx.beginPath(); ctx.arc(s.x, s.y, 1.3, 0, 6.2832); ctx.fill();
    }

    // audio-ripple rings from the reactor
    rippleTimer -= 1;
    if (rippleTimer <= 0) {
      const active = L > 0.05 || state.mode !== "idle";
      ripples.push({ r: 36, life: active ? 1 : 0.5 });
      rippleTimer = active ? Math.max(8, 26 - L * 18) : 64;
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i];
      rp.r += 2.4 + L * 3.5; rp.life -= 0.012;
      if (rp.life <= 0) { ripples.splice(i, 1); continue; }
      ctx.strokeStyle = rgba(GOLD, rp.life * 0.4);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(RX, RY, rp.r, 0, 6.2832); ctx.stroke();
    }

    // reactor bloom
    const bloom = ctx.createRadialGradient(RX, RY, 3, RX, RY, 90 + L * 70);
    bloom.addColorStop(0, rgba(CYAN, 0.4 + L * 0.5));
    bloom.addColorStop(0.35, rgba(GOLD, 0.16 + L * 0.28));
    bloom.addColorStop(1, rgba(GOLD, 0));
    ctx.fillStyle = bloom;
    ctx.beginPath(); ctx.arc(RX, RY, 90 + L * 70, 0, 6.2832); ctx.fill();

    // spectrum ring around the reactor
    const spec = window.audioSpectrum || null;
    if (spec) {
      ctx.save(); ctx.translate(RX, RY);
      for (let i = 0; i < 60; i++) {
        const mag = spec[Math.floor((i / 60) * spec.length)] / 255;
        const a = (i / 60) * 6.2832;
        const inner = 40, outer = inner + mag * 40 + 2;
        ctx.strokeStyle = rgba(i % 5 ? GOLD : CYAN, 0.3 + mag * 0.6);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
        ctx.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
        ctx.stroke();
      }
      ctx.restore();
    }

    // holographic scan sweep down the figure
    scanY += 2.4; if (scanY > H + 40) scanY = -40;
    const band = ctx.createLinearGradient(0, scanY - 34, 0, scanY + 34);
    band.addColorStop(0, rgba(CYAN, 0));
    band.addColorStop(0.5, rgba(CYAN, 0.10));
    band.addColorStop(1, rgba(CYAN, 0));
    ctx.fillStyle = band; ctx.fillRect(W * 0.12, scanY - 34, W * 0.76, 68);
    ctx.strokeStyle = rgba(CYAN, 0.22); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(W * 0.12, scanY); ctx.lineTo(W * 0.88, scanY); ctx.stroke();

    ctx.globalCompositeOperation = "source-over";
    driveFigure(L, t);
    requestAnimationFrame(draw);
  }

  function driveFigure(L, t) {
    if (!eyeL) buildSvg();
    const speaking = state.mode === "speaking";

    // eyes: steady gold glow that breathes and brightens when active
    if (eyeL && eyeR) {
      const base = speaking ? 0.95 : state.mode === "listening" ? 0.85 : 0.8;
      const o = Math.min(1, base + L * 0.2 + Math.sin(t * 3) * 0.06);
      eyeL.style.opacity = o; eyeR.style.opacity = o;
    }

    // reactor core pulse
    if (core) {
      core.setAttribute("r", (10 + L * 7 + Math.sin(t * 2.4) * 0.5).toFixed(1));
      core.style.opacity = (0.85 + L * 0.15).toFixed(3);
    }

    // MOUTH EQUALIZER — each bar tracks a different speech frequency band, so
    // the mouth articulates with the words (symmetric, mouth-like).
    const spec = window.audioSpectrum || null;
    const half = (NBARS - 1) / 2;
    for (let i = 0; i < NBARS; i++) {
      let h;
      if (speaking && spec) {
        const bi = i <= half ? i : NBARS - 1 - i;      // symmetric around centre
        const idx = 3 + Math.floor((bi / half) * 46);   // spread across voice bins
        h = 3 + (spec[idx] / 255) * 27;
      } else if (speaking) {
        h = 3 + Math.abs(Math.sin(t * 13 + i)) * 7;     // fallback wiggle
      } else {
        h = 2.5 + Math.abs(Math.sin(t * 2 + i * 0.6)) * 1.6; // idle breathing
      }
      bars[i].setAttribute("height", h.toFixed(1));
      bars[i].setAttribute("y", (BAR_BOTTOM - h).toFixed(1));
    }
  }
  draw();

  window.setReactorMode = function (mode) {
    state.mode = mode;
    const label = document.getElementById("reactor-label");
    if (label) label.textContent = MODE_LABEL[mode] || mode.toUpperCase();
    // a burst of ripples when JARVIS starts speaking
    if (mode === "speaking") for (let k = 0; k < 3; k++) ripples.push({ r: 36 + k * 20, life: 1 });
  };
  window.setReactorLevel = function (v) {
    state.target = Math.max(0, Math.min(1, v));
  };
})();
