/* The HUD rig around the Iron Man bust: red/gold framing rings, corner gauges,
   a red radar sweep, orbiting nodes, and an audio-reactive spectrum halo.
   Also drives the glowing eyes, the chest arc reactor, and the lip-sync mouth.
   Pure canvas + a little DOM. No dependencies. */

(function () {
  "use strict";

  const canvas = document.getElementById("reactor");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const CX = W / 2, CY = H / 2;
  const REACTOR_X = CX, REACTOR_Y = H * 0.775;  // matches the SVG chest reactor

  const state = { level: 0, target: 0, mode: "idle", t: 0 };
  window.reactorState = state;

  const GOLD = [245, 187, 71];
  const RED = [255, 47, 47];
  const CYAN = [79, 216, 255];
  // Mode tints the eyes + reactor only; the armour stays red/gold.
  const MODE_COLOR = {
    idle: CYAN,
    listening: [77, 255, 166],
    thinking: [255, 179, 64],
    speaking: CYAN,
  };

  let eyeL = null, eyeR = null, core = null, mouth = null;
  function grabSvg() {
    eyeL = document.getElementById("eye-l");
    eyeR = document.getElementById("eye-r");
    core = document.getElementById("reactor-core");
    mouth = document.getElementById("mouth-glow");
  }
  grabSvg();

  const lerp = (a, b, k) => a + (b - a) * k;
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  function ring(cx, cy, r, w, a, c) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = w; ctx.strokeStyle = rgba(c, a); ctx.stroke();
  }
  function arc(cx, cy, r, w, start, sweep, a, c) {
    ctx.beginPath(); ctx.arc(cx, cy, r, start, start + sweep);
    ctx.lineWidth = w; ctx.strokeStyle = rgba(c, a); ctx.stroke();
  }
  function ticks(cx, cy, r, count, len, rot, a, c, wide) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot);
    ctx.strokeStyle = rgba(c, a); ctx.lineWidth = wide || 2;
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * r, Math.sin(ang) * r);
      ctx.lineTo(Math.cos(ang) * (r + len), Math.sin(ang) * (r + len));
      ctx.stroke();
    }
    ctx.restore();
  }
  function dial(cx, cy, r, spin, c) {
    ring(cx, cy, r, 1.5, 0.5, c);
    ring(cx, cy, r * 0.6, 1, 0.4, c);
    ticks(cx, cy, r * 0.62, 12, r * 0.32, spin, 0.55, c, 1.5);
    arc(cx, cy, r, 2, spin * 2, Math.PI * 0.55, 0.8, c);
    arc(cx, cy, r * 0.6, 2, -spin * 2.4, Math.PI * 0.7, 0.7, c);
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = rgba(c, 0.7 + 0.3 * Math.sin(spin * 3)); ctx.fill();
  }

  function draw() {
    state.t += 0.016;
    state.level = lerp(state.level, state.target, 0.25);
    const L = state.level;
    const tint = MODE_COLOR[state.mode] || CYAN;
    const t = state.t;

    ctx.clearRect(0, 0, W, H);

    // warm glow behind the whole bust
    const bustGlow = ctx.createRadialGradient(CX, CY, 20, CX, CY, 300);
    bustGlow.addColorStop(0, rgba(RED, 0.10 + L * 0.10));
    bustGlow.addColorStop(0.5, rgba(GOLD, 0.05));
    bustGlow.addColorStop(1, rgba(GOLD, 0));
    ctx.fillStyle = bustGlow; ctx.fillRect(0, 0, W, H);

    // outermost RED framing ring + segments
    ring(CX, CY, 300, 1, 0.4, RED);
    arc(CX, CY, 300, 3, t * 0.5, Math.PI * 0.4, 0.75, RED);
    arc(CX, CY, 300, 3, t * 0.5 + Math.PI, Math.PI * 0.3, 0.75, RED);
    ticks(CX, CY, 285, 90, 8, t * 0.1, 0.3, GOLD, 1);

    // gold structure rings
    ring(CX, CY, 272, 1, 0.45, GOLD);
    ticks(CX, CY, 250, 60, 12, -t * 0.14, 0.4, GOLD, 1.5);
    ticks(CX, CY, 250, 12, 20, t * 0.14, 0.6, GOLD, 2);
    arc(CX, CY, 236, 3, -t * 0.7, Math.PI * 0.6, 0.6, GOLD);
    arc(CX, CY, 236, 3, -t * 0.7 + Math.PI, Math.PI * 0.45, 0.6, GOLD);

    // red inner accent ring
    arc(CX, CY, 214, 2.5, t * 0.9, Math.PI * 0.5, 0.7, RED);
    arc(CX, CY, 214, 2.5, t * 0.9 + Math.PI * 0.9, Math.PI * 0.25, 0.6, RED);

    // radar sweep (red)
    ctx.save(); ctx.translate(CX, CY); ctx.rotate(t * 0.8);
    const sweep = ctx.createLinearGradient(0, 0, 220, 0);
    sweep.addColorStop(0, rgba(RED, 0.32)); sweep.addColorStop(1, rgba(RED, 0));
    ctx.strokeStyle = sweep; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(216, 0); ctx.stroke();
    ctx.restore();

    // audio spectrum halo (gold with red accents)
    const spectrum = window.audioSpectrum || null;
    if (spectrum && spectrum.length) {
      const n = 90;
      ctx.save(); ctx.translate(CX, CY);
      for (let i = 0; i < n; i++) {
        const idx = Math.floor((i / n) * spectrum.length);
        const mag = spectrum[idx] / 255;
        const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
        const inner = 254, outer = inner + mag * 40 + 3;
        const c = (i % 6 === 0) ? RED : GOLD;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * inner, Math.sin(ang) * inner);
        ctx.lineTo(Math.cos(ang) * outer, Math.sin(ang) * outer);
        ctx.lineWidth = 3; ctx.strokeStyle = rgba(c, 0.35 + mag * 0.6); ctx.stroke();
      }
      ctx.restore();
    }

    // orbiting nodes (red + gold)
    for (let i = 0; i < 5; i++) {
      const ang = t * 0.6 + (i / 5) * Math.PI * 2;
      const x = CX + Math.cos(ang) * 272, y = CY + Math.sin(ang) * 272;
      const c = i % 2 ? RED : GOLD;
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fillStyle = rgba(c, 0.18); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fillStyle = rgba(c, 0.95); ctx.fill();
    }

    // four corner gauges
    const d = 70, off = 90;
    dial(off, off, d, t, GOLD);
    dial(W - off, off, d, -t * 1.2, RED);
    dial(off, H - off, d, -t * 0.9, RED);
    dial(W - off, H - off, d, t * 1.1, GOLD);

    // cyan bloom behind the chest arc reactor
    const rg = ctx.createRadialGradient(REACTOR_X, REACTOR_Y, 4, REACTOR_X, REACTOR_Y, 60 + L * 30);
    rg.addColorStop(0, rgba(CYAN, 0.5 + L * 0.4));
    rg.addColorStop(0.5, rgba(CYAN, 0.16));
    rg.addColorStop(1, rgba(CYAN, 0));
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(REACTOR_X, REACTOR_Y, 60 + L * 30, 0, Math.PI * 2); ctx.fill();

    driveBust(L, tint, t);
    requestAnimationFrame(draw);
  }

  function driveBust(L, tint, t) {
    if (!eyeL) grabSvg();
    // eyes: breathe with audio
    if (eyeL && eyeR) {
      const g = 0.6 + (0.3 + L * 0.7) * 0.4 + Math.sin(t * 3) * 0.05;
      eyeL.style.opacity = g; eyeR.style.opacity = g;
    }
    // chest reactor: pulse with audio
    if (core) {
      core.setAttribute("r", (11 + L * 7 + Math.sin(t * 2.4) * 0.6).toFixed(1));
      core.style.opacity = 0.8 + L * 0.2;
    }
    // lip-sync: the mouth aperture opens with JARVIS's voice only
    if (mouth) {
      let open = 3;
      if (state.mode === "speaking") {
        // articulation: base amplitude + fast flutter so it reads as speech
        const flutter = 0.5 + 0.5 * Math.abs(Math.sin(t * 17) * Math.cos(t * 11));
        open = 3 + (2 + L * 26) * flutter;
      }
      const cy = 213.5;
      mouth.setAttribute("height", open.toFixed(1));
      mouth.setAttribute("y", (cy - open / 2).toFixed(1));
      mouth.style.opacity = state.mode === "speaking" ? 0.9 : 0.35;
    }
  }
  draw();

  window.setReactorMode = function (mode) {
    state.mode = mode;
    const label = document.getElementById("reactor-label");
    if (label) label.textContent = mode.toUpperCase();
    const c = MODE_COLOR[mode] || CYAN;
    const stop = document.querySelector("#eyeglow stop:last-child");
    if (stop) stop.setAttribute("stop-color", `rgb(${c[0]},${c[1]},${c[2]})`);
    if (!eyeL) grabSvg();
    if (eyeL && eyeR) {
      const f = `drop-shadow(0 0 10px rgb(${c[0]},${c[1]},${c[2]})) drop-shadow(0 0 3px #fff)`;
      eyeL.style.filter = f; eyeR.style.filter = f;
    }
  };
  window.setReactorLevel = function (v) {
    state.target = Math.max(0, Math.min(1, v));
  };
})();
