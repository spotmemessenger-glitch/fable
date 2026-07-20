/* The reactor rig around the Iron Man face: framing rings, rotating ticks,
   red arc segments, corner dials, orbiting nodes, a red radar sweep, and an
   audio-reactive spectrum halo. Also drives the glow of the helmet's eyes.
   Pure canvas + a little DOM. No dependencies. */

(function () {
  "use strict";

  const canvas = document.getElementById("reactor");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const CX = W / 2, CY = H / 2;

  const state = { level: 0, target: 0, mode: "idle", t: 0 };
  window.reactorState = state;

  const CYAN = [55, 208, 255];
  const RED = [255, 47, 67];
  const MODE_COLOR = {
    idle: CYAN,
    listening: [77, 255, 166],
    thinking: [255, 179, 64],
    speaking: CYAN,
  };

  let eyeL = null, eyeR = null;
  function grabEyes() {
    eyeL = document.getElementById("eye-l");
    eyeR = document.getElementById("eye-r");
  }
  grabEyes();

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

  // a small decorative dial for the corners
  function dial(cx, cy, r, spin, c) {
    ring(cx, cy, r, 1.5, 0.5, c);
    ring(cx, cy, r * 0.6, 1, 0.4, c);
    ticks(cx, cy, r * 0.62, 12, r * 0.32, spin, 0.55, c, 1.5);
    arc(cx, cy, r, 2, spin * 2, Math.PI * 0.55, 0.8, c);
    arc(cx, cy, r * 0.6, 2, -spin * 2.4, Math.PI * 0.7, 0.7, c);
    // hub
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = rgba(c, 0.7 + 0.3 * Math.sin(spin * 3)); ctx.fill();
  }

  function draw() {
    state.t += 0.016;
    state.level = lerp(state.level, state.target, 0.25);
    const L = state.level;
    const c = MODE_COLOR[state.mode] || CYAN;
    const t = state.t;

    ctx.clearRect(0, 0, W, H);

    // ---- soft core halo behind the face ----
    const halo = ctx.createRadialGradient(CX, CY, 8, CX, CY, 210);
    halo.addColorStop(0, rgba(c, 0.16 + L * 0.22));
    halo.addColorStop(0.55, rgba(c, 0.05));
    halo.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, W, H);

    // ---- outermost RED framing ring + segments ----
    ring(CX, CY, 300, 1, 0.35, RED);
    arc(CX, CY, 300, 3, t * 0.5, Math.PI * 0.4, 0.7, RED);
    arc(CX, CY, 300, 3, t * 0.5 + Math.PI, Math.PI * 0.3, 0.7, RED);
    ticks(CX, CY, 285, 90, 8, t * 0.1, 0.3, RED, 1);

    // ---- cyan structure rings ----
    ring(CX, CY, 272, 1, 0.4, c);
    ticks(CX, CY, 250, 60, 12, -t * 0.14, 0.4, c, 1.5);
    ticks(CX, CY, 250, 12, 20, t * 0.14, 0.6, c, 2);
    arc(CX, CY, 236, 3, -t * 0.7, Math.PI * 0.6, 0.6, c);
    arc(CX, CY, 236, 3, -t * 0.7 + Math.PI, Math.PI * 0.45, 0.6, c);
    ring(CX, CY, 220, 2, 0.5, c);

    // ---- red inner accent ring with counter-rotating segment ----
    arc(CX, CY, 205, 2.5, t * 0.9, Math.PI * 0.5, 0.7, RED);
    arc(CX, CY, 205, 2.5, t * 0.9 + Math.PI * 0.9, Math.PI * 0.25, 0.6, RED);

    // ---- radar sweep (red) ----
    ctx.save();
    ctx.translate(CX, CY);
    ctx.rotate(t * 0.8);
    const sweep = ctx.createLinearGradient(0, 0, 200, 0);
    sweep.addColorStop(0, rgba(RED, 0.35));
    sweep.addColorStop(1, rgba(RED, 0));
    ctx.strokeStyle = sweep; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(198, 0); ctx.stroke();
    ctx.restore();

    // ---- audio spectrum halo around the face ----
    const spectrum = window.audioSpectrum || null;
    if (spectrum && spectrum.length) {
      const n = 90;
      ctx.save(); ctx.translate(CX, CY);
      for (let i = 0; i < n; i++) {
        const idx = Math.floor((i / n) * spectrum.length);
        const mag = spectrum[idx] / 255;
        const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
        const inner = 214;
        const outer = inner + mag * 44 + 3;
        const col = (i % 6 === 0) ? RED : c;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * inner, Math.sin(ang) * inner);
        ctx.lineTo(Math.cos(ang) * outer, Math.sin(ang) * outer);
        ctx.lineWidth = 3;
        ctx.strokeStyle = rgba(col, 0.35 + mag * 0.6);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ---- orbiting nodes (mix of cyan + red); glow via layered alpha, not
    //      shadowBlur, which is far too slow to run every frame ----
    const nodes = 5;
    for (let i = 0; i < nodes; i++) {
      const ang = t * 0.6 + (i / nodes) * Math.PI * 2;
      const r = 220;
      const x = CX + Math.cos(ang) * r, y = CY + Math.sin(ang) * r;
      const col = i % 2 ? RED : c;
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = rgba(col, 0.18); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = rgba(col, 0.95); ctx.fill();
    }

    // ---- four corner dials ----
    const d = 66, off = 92;
    dial(off, off, d, t, c);
    dial(W - off, off, d, -t * 1.2, RED);
    dial(off, H - off, d, -t * 0.9, RED);
    dial(W - off, H - off, d, t * 1.1, c);

    // ---- drive the helmet eyes with audio + mode ----
    // Only the (cheap) opacity is animated per-frame. The drop-shadow filter is
    // static in CSS — rewriting an SVG filter every frame pegs the compositor.
    if (!eyeL) grabEyes();
    if (eyeL && eyeR) {
      const g = 0.6 + (0.3 + L * 0.7) * 0.4 + Math.sin(t * 3) * 0.05;
      eyeL.style.opacity = g; eyeR.style.opacity = g;
    }

    requestAnimationFrame(draw);
  }
  draw();

  window.setReactorMode = function (mode) {
    state.mode = mode;
    const label = document.getElementById("reactor-label");
    if (label) label.textContent = mode.toUpperCase();
    const c = MODE_COLOR[mode] || CYAN;
    // Update eye glow colour + gradient ONCE per mode change (never per frame).
    const stop = document.querySelector("#eyeglow stop:last-child");
    if (stop) stop.setAttribute("stop-color", `rgb(${c[0]},${c[1]},${c[2]})`);
    if (!eyeL) grabEyes();
    if (eyeL && eyeR) {
      const f = `drop-shadow(0 0 12px rgb(${c[0]},${c[1]},${c[2]})) drop-shadow(0 0 4px #fff)`;
      eyeL.style.filter = f; eyeR.style.filter = f;
    }
  };
  window.setReactorLevel = function (v) {
    state.target = Math.max(0, Math.min(1, v));
  };
})();
