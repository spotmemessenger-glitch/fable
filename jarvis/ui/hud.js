/* Drives the animated light over the Iron Man core image:
   - golden eyes that breathe with audio
   - a yellow mouth that lip-syncs to JARVIS's speech
   - an arc-reactor bloom + spectrum ring that pulse with the voice
   The image supplies the artwork; this supplies the life. No dependencies. */

(function () {
  "use strict";

  const canvas = document.getElementById("reactor");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  // Reactor centre as a fraction of the image (measured from core.jpg).
  const RX = W * 0.505, RY = H * 0.685;

  const state = { level: 0, target: 0, mode: "idle", t: 0 };
  window.reactorState = state;

  const GOLD = [255, 208, 92];
  const CYAN = [120, 220, 255];
  const MODE_LABEL = { idle: "ONLINE", listening: "LISTENING", thinking: "PROCESSING", speaking: "SPEAKING" };

  let eyeL = null, eyeR = null, mouth = null, reactor = null;
  function grab() {
    eyeL = document.getElementById("eye-l");
    eyeR = document.getElementById("eye-r");
    mouth = document.getElementById("mouth-glow");
    reactor = document.getElementById("reactor-core");
  }
  grab();

  const lerp = (a, b, k) => a + (b - a) * k;
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  function draw() {
    state.t += 0.016;
    state.level = lerp(state.level, state.target, 0.28);
    const L = state.level;
    const t = state.t;

    ctx.clearRect(0, 0, W, H);

    // reactor bloom (screen-blended over the image reactor)
    const bloom = ctx.createRadialGradient(RX, RY, 4, RX, RY, 120 + L * 90);
    bloom.addColorStop(0, rgba(CYAN, 0.35 + L * 0.5));
    bloom.addColorStop(0.3, rgba(GOLD, 0.18 + L * 0.3));
    bloom.addColorStop(1, rgba(GOLD, 0));
    ctx.fillStyle = bloom;
    ctx.beginPath(); ctx.arc(RX, RY, 120 + L * 90, 0, Math.PI * 2); ctx.fill();

    // rotating golden ray spokes on the reactor
    ctx.save(); ctx.translate(RX, RY); ctx.rotate(t * 0.25);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const len = 60 + L * 80 + (i % 2 ? 14 : 0);
      ctx.strokeStyle = rgba(GOLD, 0.10 + L * 0.35);
      ctx.lineWidth = i % 2 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 34, Math.sin(a) * 34);
      ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
      ctx.stroke();
    }
    ctx.restore();

    // audio spectrum ring around the reactor
    const spec = window.audioSpectrum || null;
    if (spec && spec.length) {
      const n = 72;
      ctx.save(); ctx.translate(RX, RY);
      for (let i = 0; i < n; i++) {
        const idx = Math.floor((i / n) * spec.length);
        const mag = spec[idx] / 255;
        const a = (i / n) * Math.PI * 2;
        const inner = 96, outer = inner + mag * 56 + 3;
        const c = i % 5 === 0 ? CYAN : GOLD;
        ctx.strokeStyle = rgba(c, 0.35 + mag * 0.6); ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
        ctx.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
        ctx.stroke();
      }
      ctx.restore();
    }

    driveOverlays(L, t);
    requestAnimationFrame(draw);
  }

  function setGlow(el, opacity, sx, sy) {
    if (!el) return;
    el.style.opacity = opacity.toFixed(3);
    el.style.transform = `translate(-50%, -50%) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
  }

  function driveOverlays(L, t) {
    if (!eyeL) grab();
    const speaking = state.mode === "speaking";
    const listening = state.mode === "listening";

    // eyes: steady gold glow, breathing; brighter while active
    const eyeBase = speaking ? 0.9 : listening ? 0.7 : 0.55;
    const eyeO = eyeBase + L * 0.4 + Math.sin(t * 3) * 0.05;
    const eyeS = 1 + L * 0.25;
    setGlow(eyeL, Math.min(1, eyeO), eyeS, eyeS);
    setGlow(eyeR, Math.min(1, eyeO), eyeS, eyeS);

    // mouth: opens (grows in height) with the voice — the lip-sync
    if (speaking) {
      const flutter = 0.45 + 0.55 * Math.abs(Math.sin(t * 16) * Math.cos(t * 9));
      const openY = (0.5 + (0.6 + L * 3.2) * flutter);
      setGlow(mouth, Math.min(1, 0.6 + L * 0.5), 1 + L * 0.3, openY);
    } else {
      setGlow(mouth, 0.28, 1, 0.5);
    }

    // reactor overlay bloom
    const rO = 0.55 + L * 0.45 + Math.sin(t * 1.6) * 0.05;
    const rS = 1 + L * 0.35;
    setGlow(reactor, Math.min(1, rO), rS, rS);
  }
  draw();

  window.setReactorMode = function (mode) {
    state.mode = mode;
    const label = document.getElementById("reactor-label");
    if (label) label.textContent = MODE_LABEL[mode] || mode.toUpperCase();
  };
  window.setReactorLevel = function (v) {
    state.target = Math.max(0, Math.min(1, v));
  };
})();
