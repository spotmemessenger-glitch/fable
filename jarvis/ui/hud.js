/* Living holographic rig drawn over the premium Iron Man image.
   The image is the art; this is the life — all screen-blended light:
     - a segmented MOUTH EQUALIZER at the image's mouth that tracks the speech
       frequency bands, so the mouth articulates with the words
     - golden eyes that breathe and flare when active
     - an arc-reactor bloom with audio-ripple rings + a spectrum halo
     - drifting sparks and a holographic scan sweep
   Positions are fractions of the image, measured from core.jpg. No deps. */

(function () {
  "use strict";

  const canvas = document.getElementById("reactor");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;

  // image-fraction anchors (core.jpg is the 1280x720 blue/gold blueprint)
  const EYE_L = [0.422 * W, 0.465 * H];
  const EYE_R = [0.570 * W, 0.465 * H];
  const MOUTH = [0.50 * W, 0.595 * H];
  // energy focal point = the concentric HUD rings behind the head
  const RX = 0.50 * W, RY = 0.335 * H;

  const state = { level: 0, target: 0, mode: "idle", t: 0 };
  window.reactorState = state;

  const GOLD = [255, 213, 74], CYAN = [25, 181, 255], RED = [255, 70, 70];
  const MODE_LABEL = { idle: "ONLINE", listening: "LISTENING", thinking: "PROCESSING", speaking: "SPEAKING" };

  const lerp = (a, b, k) => a + (b - a) * k;
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // drifting sparks
  const sparks = [];
  for (let i = 0; i < 40; i++) sparks.push(makeSpark(true));
  function makeSpark(init) {
    return {
      x: W * (0.28 + Math.random() * 0.44), y: init ? H * Math.random() : H * 0.96,
      vx: (Math.random() - 0.5) * 0.25, vy: -(0.12 + Math.random() * 0.5),
      life: 0.4 + Math.random() * 0.6, tw: Math.random() * 6.28,
    };
  }
  const ripples = [];
  let rippleTimer = 0, scanY = -50;

  function glow(x, y, r, inner, edge, ci, ce) {
    const g = ctx.createRadialGradient(x, y, 1, x, y, r);
    g.addColorStop(0, rgba(ci, inner));
    g.addColorStop(0.5, rgba(ce, edge));
    g.addColorStop(1, rgba(ce, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
  }

  function draw() {
    state.t += 0.016;
    state.level = lerp(state.level, state.target, 0.28);
    const L = state.level, t = state.t;
    const spec = window.audioSpectrum || null;
    const speaking = state.mode === "speaking";

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";

    // --- sparks ---
    for (const s of sparks) {
      s.x += s.vx; s.y += s.vy; s.life -= 0.006;
      if (s.life <= 0 || s.y < H * 0.05) Object.assign(s, makeSpark(false));
      const a = Math.max(0, s.life) * (0.35 + 0.5 * Math.sin(t * 3 + s.tw));
      ctx.fillStyle = rgba(GOLD, a * 0.6);
      ctx.beginPath(); ctx.arc(s.x, s.y, 1.2, 0, 6.2832); ctx.fill();
    }

    // --- audio-ripple rings: a pulsing halo behind the head ---
    rippleTimer -= 1;
    if (rippleTimer <= 0) {
      const active = L > 0.05 || state.mode !== "idle";
      ripples.push({ r: 108, life: active ? 1 : 0.45 });
      rippleTimer = active ? Math.max(8, 26 - L * 16) : 74;
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i]; rp.r += 1.6 + L * 3; rp.life -= 0.011;
      if (rp.life <= 0) { ripples.splice(i, 1); continue; }
      ctx.strokeStyle = rgba(CYAN, rp.life * 0.3); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(RX, RY, rp.r, 0, 6.2832); ctx.stroke();
    }

    // --- soft blue aura + an audio-reactive ring AROUND the head ---
    glow(RX, RY, 190 + L * 80, 0.13 + L * 0.14, 0.04, CYAN, CYAN);
    if (spec) {
      ctx.save(); ctx.translate(RX, RY);
      for (let i = 0; i < 64; i++) {
        const mag = spec[Math.floor((i / 64) * spec.length)] / 255;
        const a = (i / 64) * 6.2832, inn = 150, out = inn + mag * 44 + 2;
        ctx.strokeStyle = rgba(i % 6 ? CYAN : GOLD, 0.22 + mag * 0.55); ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * inn, Math.sin(a) * inn);
        ctx.lineTo(Math.cos(a) * out, Math.sin(a) * out);
        ctx.stroke();
      }
      ctx.restore();
    }

    // --- eyes ---
    const eyeA = (speaking ? 0.55 : state.mode === "listening" ? 0.4 : 0.32) + L * 0.4 + Math.sin(t * 3) * 0.05;
    for (const [ex, ey] of [EYE_L, EYE_R]) {
      glow(ex, ey, 20 + L * 10, Math.min(1, eyeA + 0.3), eyeA * 0.5, [255, 240, 200], GOLD);
      // horizontal lens-flare streak
      const fw = 60 + L * 40;
      const fg = ctx.createLinearGradient(ex - fw, ey, ex + fw, ey);
      fg.addColorStop(0, rgba(GOLD, 0)); fg.addColorStop(0.5, rgba([255, 235, 190], eyeA * 0.7)); fg.addColorStop(1, rgba(GOLD, 0));
      ctx.fillStyle = fg; ctx.fillRect(ex - fw, ey - 1.5, fw * 2, 3);
    }

    // --- MOUTH EQUALIZER (frequency bands => articulation) ---
    drawMouth(spec, speaking, t, L);

    // --- holographic scan sweep ---
    scanY += 2.2; if (scanY > H + 30) scanY = -30;
    const band = ctx.createLinearGradient(0, scanY - 28, 0, scanY + 28);
    band.addColorStop(0, rgba(CYAN, 0)); band.addColorStop(0.5, rgba(CYAN, 0.09)); band.addColorStop(1, rgba(CYAN, 0));
    ctx.fillStyle = band; ctx.fillRect(W * 0.14, scanY - 28, W * 0.72, 56);

    ctx.globalCompositeOperation = "source-over";
    requestAnimationFrame(draw);
  }

  const NBARS = 13, MOUTH_W = 0.10 * W;
  function drawMouth(spec, speaking, t, L) {
    const x0 = MOUTH[0] - MOUTH_W / 2, y = MOUTH[1], bw = MOUTH_W / NBARS;
    const half = (NBARS - 1) / 2;
    for (let i = 0; i < NBARS; i++) {
      let h;
      if (speaking && spec) {
        const bi = i <= half ? i : NBARS - 1 - i;           // symmetric around centre
        const idx = 3 + Math.floor((bi / half) * 42);        // spread over voice bins
        h = 1.5 + (spec[idx] / 255) * 20;
      } else if (speaking) {
        h = 1.5 + Math.abs(Math.sin(t * 13 + i)) * 6;
      } else {
        h = 1 + Math.abs(Math.sin(t * 2 + i * 0.5)) * 1.4;   // idle shimmer
      }
      const cx = x0 + i * bw + bw / 2;
      const g = ctx.createLinearGradient(cx, y - h, cx, y + h);
      g.addColorStop(0, rgba([255, 240, 200], 0.9)); g.addColorStop(0.5, rgba(GOLD, 0.95)); g.addColorStop(1, rgba([200, 120, 30], 0.7));
      ctx.fillStyle = g;
      ctx.fillRect(cx - bw * 0.32, y - h, bw * 0.64, h * 2);
    }
  }

  draw();

  window.setReactorMode = function (mode) {
    state.mode = mode;
    const label = document.getElementById("reactor-label");
    if (label) label.textContent = MODE_LABEL[mode] || mode.toUpperCase();
    if (mode === "speaking") for (let k = 0; k < 3; k++) ripples.push({ r: 108 + k * 16, life: 1 });
  };
  window.setReactorLevel = function (v) { state.target = Math.max(0, Math.min(1, v)); };
})();

/* Page-wide background: large slow perspective rings behind every panel,
   independent of the reactor's own local canvas above. Purely decorative —
   gives the whole page a sense of machinery turning, not just the bust. */
(function () {
  "use strict";
  const canvas = document.getElementById("bg-rings");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener("resize", resize);
  resize();

  function ring(cx, cy, rx, ry, angle, color, dash) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.scale(1, ry / rx);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(dash);
    ctx.shadowBlur = 10;
    ctx.shadowColor = color;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  let a1 = 0, a2 = 0, a3 = 0;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cx = canvas.width / 2, cy = canvas.height / 2;
    ring(cx, cy, Math.min(canvas.width, canvas.height) * 0.62, 90, a1, "rgba(255,215,0,0.16)", [16, 10]);
    ring(cx, cy, Math.min(canvas.width, canvas.height) * 0.5, 70, -a2, "rgba(211,47,47,0.14)", [8, 14]);
    ring(cx, cy, Math.min(canvas.width, canvas.height) * 0.38, 50, a3, "rgba(255,69,0,0.12)", [4, 8]);
    a1 += 0.0018; a2 += 0.0028; a3 += 0.004;
    requestAnimationFrame(draw);
  }
  draw();
})();
