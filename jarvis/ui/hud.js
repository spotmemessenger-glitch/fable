/* The arc reactor: concentric rings, rotating ticks, and an audio-reactive
   core that swells with whoever is speaking. Pure canvas, no dependencies. */

(function () {
  "use strict";

  const canvas = document.getElementById("reactor");
  const ctx = canvas.getContext("2d");
  const CX = canvas.width / 2;
  const CY = canvas.height / 2;

  // Drive level (0..1) and hue come from the audio layer in app.js.
  const state = {
    level: 0, // current audio amplitude
    target: 0, // smoothed toward this
    mode: "idle", // idle | listening | thinking | speaking
    t: 0,
  };
  window.reactorState = state;

  const MODE_COLOR = {
    idle: [55, 208, 255],
    listening: [77, 255, 166],
    thinking: [255, 179, 64],
    speaking: [55, 208, 255],
  };

  function lerp(a, b, k) { return a + (b - a) * k; }

  function ring(radius, width, alpha, color) {
    ctx.beginPath();
    ctx.arc(CX, CY, radius, 0, Math.PI * 2);
    ctx.lineWidth = width;
    ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
    ctx.stroke();
  }

  function ticks(radius, count, len, rot, alpha, color) {
    ctx.save();
    ctx.translate(CX, CY);
    ctx.rotate(rot);
    ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
    ctx.lineWidth = 2;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const x1 = Math.cos(a) * radius;
      const y1 = Math.sin(a) * radius;
      const x2 = Math.cos(a) * (radius + len);
      const y2 = Math.sin(a) * (radius + len);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function arcSegment(radius, width, start, sweep, alpha, color) {
    ctx.beginPath();
    ctx.arc(CX, CY, radius, start, start + sweep);
    ctx.lineWidth = width;
    ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
    ctx.stroke();
  }

  function draw() {
    state.t += 0.016;
    state.level = lerp(state.level, state.target, 0.25);
    const L = state.level;
    const color = MODE_COLOR[state.mode] || MODE_COLOR.idle;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // outer faint frame + rotating ticks
    ring(255, 1, 0.25, color);
    ticks(232, 60, 10, state.t * 0.15, 0.35, color);
    ticks(232, 12, 18, -state.t * 0.15, 0.5, color);

    // decorative rotating arc segments (like the reference's HUD rings)
    arcSegment(210, 3, state.t * 0.6, Math.PI * 0.5, 0.55, color);
    arcSegment(210, 3, state.t * 0.6 + Math.PI, Math.PI * 0.35, 0.55, color);
    arcSegment(190, 2, -state.t * 0.9, Math.PI * 0.7, 0.4, color);
    arcSegment(190, 2, -state.t * 0.9 + Math.PI, Math.PI * 0.5, 0.4, color);

    // audio-reactive frequency petals
    const spectrum = window.audioSpectrum || null;
    if (spectrum && spectrum.length) {
      const n = 72;
      ctx.save();
      ctx.translate(CX, CY);
      for (let i = 0; i < n; i++) {
        const idx = Math.floor((i / n) * spectrum.length);
        const mag = spectrum[idx] / 255;
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        const inner = 150;
        const outer = inner + mag * 55 + 4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
        ctx.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
        ctx.lineWidth = 3;
        ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${0.35 + mag * 0.6})`;
        ctx.stroke();
      }
      ctx.restore();
    }

    // inner triple ring
    ring(150, 2, 0.6, color);
    ring(120, 6, 0.5 + L * 0.5, color);
    ticks(96, 36, 8, -state.t * 0.4, 0.4, color);

    // glowing core
    const coreR = 62 + L * 26 + Math.sin(state.t * 2) * 2;
    const grad = ctx.createRadialGradient(CX, CY, 4, CX, CY, coreR);
    grad.addColorStop(0, `rgba(240,252,255,${0.9})`);
    grad.addColorStop(0.35, `rgba(${color[0]},${color[1]},${color[2]},${0.85})`);
    grad.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},0)`);
    ctx.beginPath();
    ctx.arc(CX, CY, coreR, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // core inner triangle (reactor motif)
    ctx.save();
    ctx.translate(CX, CY);
    ctx.rotate(state.t * 0.2);
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
      const r = 34;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(240,252,255,${0.7 + L * 0.3})`;
    ctx.stroke();
    ctx.restore();

    requestAnimationFrame(draw);
  }

  draw();

  // Public API for app.js
  window.setReactorMode = function (mode) {
    state.mode = mode;
    const label = document.getElementById("reactor-label");
    if (label) label.textContent = mode.toUpperCase();
  };
  window.setReactorLevel = function (v) {
    state.target = Math.max(0, Math.min(1, v));
  };
})();
