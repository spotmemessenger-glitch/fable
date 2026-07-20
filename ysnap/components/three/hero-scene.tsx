"use client";

import { Suspense, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { ContactShadows, Environment, Lightformer, RoundedBox } from "@react-three/drei";

/* ------------------------------------------------------------------ palette */

const BLUE = "#4c7dff";
const VIOLET = "#6e6ef7";
const TEAL = "#10b3a3";
const CORAL = "#ff6b5e";
const AMBER = "#f59e0b";
const GREEN = "#34b871";

/* ------------------------------------------------------------------ screen */

const SCREEN_W = 512;
const SCREEN_H = 1112;

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/* --- screen animation state machine ---------------------------------------
 * Loop: typing (2.2s) -> translating (1.8s) -> transliterating (2.6s)
 *       -> hold (1.2s) -> clear & repeat. Driven by elapsed time only.
 */

const FONT_STACK = "'Inter', 'Segoe UI', system-ui, sans-serif";
/* Tamil + Devanagari coverage per platform: Nirmala UI (Windows),
   Tamil/Devanagari Sangam MN (macOS/iOS), Noto Sans (Android/Linux). */
const SCRIPT_FONT_STACK =
  '"Segoe UI", "Nirmala UI", "Tamil Sangam MN", "Devanagari Sangam MN", "Noto Sans Tamil", "Noto Sans Devanagari", Inter, sans-serif';

const TYPING_DUR = 2.2;
const TRANSLATING_DUR = 1.8;
const DOTS_DUR = 0.5;
const TRANSLIT_DUR = 2.6;
const TRANSLIT_STEP = 0.85;
const HOLD_DUR = 1.2;
const CYCLE_DUR = TYPING_DUR + TRANSLATING_DUR + TRANSLIT_DUR + HOLD_DUR;

const TYPED_LINES = ["Where is the", "station?"];
const TYPED_TOTAL = TYPED_LINES.reduce((n, l) => n + l.length, 0);
const TRANSLATED_LINES = ["¿Dónde está", "la estación?"];
const GREETINGS = ["Vanakkam", "வணக்கம்", "नमस्ते"];

/** Static chrome shared by every frame: bg, status pill, dividers, lines. */
function drawChrome(ctx: CanvasRenderingContext2D) {
  /* background */
  ctx.fillStyle = "#fbfbfc";
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

  /* status bar pill (dynamic-island style) */
  ctx.fillStyle = "#16181d";
  roundedRect(ctx, SCREEN_W / 2 - 70, 26, 140, 36, 18);
  ctx.fill();

  /* divider */
  ctx.fillStyle = "#e9eaef";
  ctx.fillRect(32, 646, 448, 2);

  /* subtle gray placeholder lines */
  ctx.fillStyle = "#e5e6eb";
  roundedRect(ctx, 32, 776, 300, 12, 6);
  ctx.fill();
  roundedRect(ctx, 32, 804, 220, 12, 6);
  ctx.fill();

  /* second divider */
  ctx.fillStyle = "#e9eaef";
  ctx.fillRect(32, 846, 448, 2);
}

/** Idle teal chip row (shown before the transliteration phase). */
function drawChipRow(ctx: CanvasRenderingContext2D) {
  const chipWidths = [128, 156, 108];
  let chipX = 32;
  for (const chipW of chipWidths) {
    ctx.fillStyle = "rgba(16, 179, 163, 0.12)";
    roundedRect(ctx, chipX, 680, chipW, 56, 28);
    ctx.fill();
    ctx.fillStyle = TEAL;
    roundedRect(ctx, chipX + 24, 702, chipW - 48, 12, 6);
    ctx.fill();
    chipX += chipW + 16;
  }
}

/** Coral mic orb; outer rings pulse gently with elapsed time. */
function drawMicOrb(ctx: CanvasRenderingContext2D, elapsed: number, animate: boolean) {
  const cx = SCREEN_W / 2;
  const cy = 972;
  const rings: Array<[number, number]> = [
    [132, 0.06],
    [104, 0.1],
    [78, 0.16],
  ];
  rings.forEach(([radius, alpha], i) => {
    const pulse = animate ? Math.sin(elapsed * 2.2 + i * 0.9) * 5 : 0;
    ctx.strokeStyle = `rgba(255, 107, 94, ${alpha})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + pulse, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.fillStyle = CORAL;
  ctx.beginPath();
  ctx.arc(cx, cy, 54, 0, Math.PI * 2);
  ctx.fill();

  /* white mic glyph */
  ctx.fillStyle = "#ffffff";
  roundedRect(ctx, cx - 11, cy - 34, 22, 38, 11);
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy + 2, 20, 0.1, Math.PI - 0.1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy + 22);
  ctx.lineTo(cx, cy + 32);
  ctx.stroke();
}

/**
 * Draws one frame of the animated translation UI.
 * `elapsed` is total animation time; `staticFrame` renders the completed
 * state once (reduced motion) with no caret, dots, or pulsing.
 */
function drawScreenFrame(
  ctx: CanvasRenderingContext2D,
  elapsed: number,
  staticFrame: boolean,
) {
  const t = staticFrame ? CYCLE_DUR : elapsed % CYCLE_DUR;

  drawChrome(ctx);

  /* source card — blue, 'YOU TYPE' */
  ctx.fillStyle = BLUE;
  roundedRect(ctx, 32, 118, 448, 232, 32);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.62)";
  ctx.font = `600 24px ${FONT_STACK}`;
  ctx.fillText("YOU TYPE", 68, 182);

  const typedChars = staticFrame || t >= TYPING_DUR
    ? TYPED_TOTAL
    : Math.min(TYPED_TOTAL, Math.floor((t / TYPING_DUR) * (TYPED_TOTAL + 1)));
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 46px ${FONT_STACK}`;
  const typedYs = [248, 308];
  let remaining = typedChars;
  let caretLine = 0;
  let caretText = "";
  for (let i = 0; i < TYPED_LINES.length; i++) {
    const shown = TYPED_LINES[i].slice(0, Math.max(0, remaining));
    if (shown) ctx.fillText(shown, 66, typedYs[i]);
    if (remaining > 0 || i === 0) {
      caretLine = i;
      caretText = shown;
    }
    remaining -= TYPED_LINES[i].length;
  }
  /* blinking caret while typing */
  const caretVisible =
    !staticFrame && t < TYPING_DUR && Math.floor(elapsed / 0.45) % 2 === 0;
  if (caretVisible) {
    const caretX = 66 + ctx.measureText(caretText).width + 6;
    ctx.fillRect(caretX, typedYs[caretLine] - 38, 4, 46);
  }

  /* target card — violet, 'ESPAÑOL' */
  ctx.fillStyle = VIOLET;
  roundedRect(ctx, 32, 374, 448, 232, 32);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.62)";
  ctx.font = `600 24px ${FONT_STACK}`;
  ctx.fillText("ESPAÑOL", 68, 438);

  const translateLocal = t - TYPING_DUR;
  if (staticFrame || translateLocal >= DOTS_DUR) {
    /* revealed translation */
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 46px ${FONT_STACK}`;
    ctx.fillText(TRANSLATED_LINES[0], 66, 504);
    ctx.fillText(TRANSLATED_LINES[1], 66, 564);
  } else if (translateLocal >= 0) {
    /* three loading dots */
    for (let i = 0; i < 3; i++) {
      const alpha = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(elapsed * 8 - i * 0.9));
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.beginPath();
      ctx.arc(220 + i * 36, 512, 9, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* teal row — chips idle, transliteration strip during phase 3 + hold */
  const stripStart = TYPING_DUR + TRANSLATING_DUR;
  if (!staticFrame && t < stripStart) {
    drawChipRow(ctx);
  } else {
    ctx.fillStyle = "rgba(16, 179, 163, 0.1)";
    roundedRect(ctx, 32, 668, 448, 80, 32);
    ctx.fill();
    ctx.textAlign = "center";
    if (staticFrame) {
      /* reduced motion: all greetings shown side by side */
      ctx.fillStyle = TEAL;
      ctx.font = `700 30px ${SCRIPT_FONT_STACK}`;
      const thirds = [32 + 448 / 6, 32 + 448 / 2, 32 + (5 * 448) / 6];
      GREETINGS.forEach((g, i) => ctx.fillText(g, thirds[i], 720));
    } else {
      /* cycle one greeting through scripts with a short crossfade */
      const lt = Math.min(t - stripStart, TRANSLIT_DUR);
      const step = Math.min(Math.floor(lt / TRANSLIT_STEP), GREETINGS.length);
      const inStep = lt - step * TRANSLIT_STEP;
      const fade = Math.min(1, Math.max(0, inStep) / 0.3);
      ctx.font = `700 40px ${SCRIPT_FONT_STACK}`;
      if (step > 0 && fade < 1) {
        ctx.fillStyle = `rgba(16, 179, 163, ${(1 - fade) * 0.9})`;
        ctx.fillText(GREETINGS[(step + GREETINGS.length - 1) % GREETINGS.length], SCREEN_W / 2, 722);
      }
      ctx.fillStyle = `rgba(16, 179, 163, ${step === 0 ? 0.9 : fade * 0.9})`;
      ctx.fillText(GREETINGS[step % GREETINGS.length], SCREEN_W / 2, 722);
    }
    ctx.textAlign = "left";
  }

  drawMicOrb(ctx, elapsed, !staticFrame);
}

type AnimatedScreen = {
  ctx: CanvasRenderingContext2D | null;
  texture: THREE.CanvasTexture;
  reducedMotion: boolean;
};

/** One canvas/ctx/texture created once; first frame drawn immediately. */
function useAnimatedScreen(): AnimatedScreen {
  return useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = SCREEN_W;
    canvas.height = SCREEN_H;
    const ctx = canvas.getContext("2d");
    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    /* reduced motion: one completed static frame, never animated again */
    if (ctx) drawScreenFrame(ctx, 0, reducedMotion);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    return { ctx, texture, reducedMotion };
  }, []);
}

/* ------------------------------------------------------------------ device */

/** Pro Max chassis: flat-sided rounded-rect (0.18 corner radius) with a crisp, tight edge bevel. */
function useChassisGeometry(): THREE.ExtrudeGeometry {
  return useMemo(() => {
    const w = 3.1;
    const h = 6.55;
    const r = 0.18;
    const bevel = 0.02;
    const depth = 0.16 - bevel * 2;
    const x = -w / 2;
    const y = -h / 2;

    const shape = new THREE.Shape();
    shape.moveTo(x + r, y);
    shape.lineTo(x + w - r, y);
    shape.quadraticCurveTo(x + w, y, x + w, y + r);
    shape.lineTo(x + w, y + h - r);
    shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    shape.lineTo(x + r, y + h);
    shape.quadraticCurveTo(x, y + h, x, y + h - r);
    shape.lineTo(x, y + r);
    shape.quadraticCurveTo(x, y, x + r, y);

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth,
      steps: 1,
      bevelEnabled: true,
      bevelSegments: 3,
      bevelSize: bevel,
      bevelThickness: bevel,
      curveSegments: 24,
    });
    geometry.center();
    return geometry;
  }, []);
}

/** Flat rounded-rect ShapeGeometry (used for the thin dark bezel frame behind the screen). */
function useRoundedPlaneGeometry(w: number, h: number, r: number): THREE.ShapeGeometry {
  return useMemo(() => {
    const x = -w / 2;
    const y = -h / 2;
    const shape = new THREE.Shape();
    shape.moveTo(x + r, y);
    shape.lineTo(x + w - r, y);
    shape.quadraticCurveTo(x + w, y, x + w, y + r);
    shape.lineTo(x + w, y + h - r);
    shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    shape.lineTo(x + r, y + h);
    shape.quadraticCurveTo(x, y + h, x, y + h - r);
    shape.lineTo(x, y + r);
    shape.quadraticCurveTo(x, y, x + r, y);
    return new THREE.ShapeGeometry(shape, 16);
  }, [w, h, r]);
}

/* iPhone-Pro-style rear camera plateau: rounded-square plate, 3 lenses, flash dot. */
const CAMERA_LENSES: Array<[number, number]> = [
  [-0.3, 0.3],
  [-0.3, -0.3],
  [0.3, 0],
];

function CameraPlateau() {
  return (
    <group position={[0.72, 2.35, 0]}>
      {/* plateau plate — protrudes from the back face (z = -0.08) */}
      <RoundedBox args={[1.35, 1.35, 0.045]} radius={0.16} smoothness={4} position={[0, 0, -0.1025]}>
        <meshStandardMaterial color="#e8752e" metalness={0.75} roughness={0.38} envMapIntensity={1.1} />
      </RoundedBox>
      {/* three dark lens cylinders */}
      {CAMERA_LENSES.map(([lx, ly]) => (
        <mesh key={`${lx},${ly}`} position={[lx, ly, -0.14]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.17, 0.17, 0.04, 28]} />
          <meshStandardMaterial color="#101114" metalness={0.4} roughness={0.25} />
        </mesh>
      ))}
      {/* tiny flash dot */}
      <mesh position={[0.3, 0.34, -0.129]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.055, 0.055, 0.012, 20]} />
        <meshStandardMaterial color="#f5efdf" emissive="#fff6dd" emissiveIntensity={0.25} roughness={0.4} />
      </mesh>
    </group>
  );
}

const IDLE_ROT_SPEED = (Math.PI * 2) / 14;

/* Screen sized so the dark bezel reads thin and even (~0.078 all round) on the 3.1 x 6.55 face. */
const SCREEN_PLANE_W = 2.944;
const SCREEN_PLANE_H = 6.394;

/** Flagship device — cosmic-orange anodized Pro Max chassis, bright canvas-drawn screen, damped parallax. */
function PhoneDevice() {
  const group = useRef<THREE.Group>(null);
  const chassisGeometry = useChassisGeometry();
  const bezelGeometry = useRoundedPlaneGeometry(3.02, 6.47, 0.16);
  const screen = useAnimatedScreen();
  const screenTime = useRef(0);
  const frameCount = useRef(0);

  useFrame((state, delta) => {
    const g = group.current;
    if (!g) return;
    const t = state.clock.elapsedTime;
    /* resting three-quarter pose: the device sits turned so its depth — orange
       rails, flat edges, back camera plateau — always reads as a 3D object;
       idle rotation and pointer parallax sweep AROUND that pose. */
    const POSE_Y = -0.42;
    const POSE_X = 0.1;
    const POSE_Z = -0.04;
    const targetY = POSE_Y + Math.sin(t * IDLE_ROT_SPEED) * 0.3 + state.pointer.x * 0.14;
    const targetX = POSE_X + Math.sin(t * 0.14) * 0.04 - state.pointer.y * 0.1;
    g.rotation.y = THREE.MathUtils.damp(g.rotation.y, targetY, 2.4, delta);
    g.rotation.x = THREE.MathUtils.damp(g.rotation.x, targetX, 2.4, delta);
    g.rotation.z = THREE.MathUtils.damp(g.rotation.z, POSE_Z, 2.4, delta);
    g.position.y = -0.15 + Math.sin(t * 0.5) * 0.09;

    /* animated screen: advance only while running; reduced motion stays static.
       Redraw the 512x1112 canvas at most every 4th frame (~15fps). */
    if (screen.reducedMotion || !screen.ctx) return;
    screenTime.current += delta;
    frameCount.current = (frameCount.current + 1) % 4;
    if (frameCount.current !== 0) return;
    drawScreenFrame(screen.ctx, screenTime.current, false);
    screen.texture.needsUpdate = true;
  });

  return (
    <group ref={group} position={[0, -0.15, 0]} scale={0.9}>
      {/* chassis — cosmic orange anodized aluminum */}
      <mesh geometry={chassisGeometry}>
        <meshStandardMaterial
          color="#e8752e"
          metalness={0.75}
          roughness={0.32}
          envMapIntensity={1.3}
        />
      </mesh>
      {/* deeper-orange side-rail band: thin scaled shell hugging the flat rails */}
      <mesh geometry={chassisGeometry} scale={[1.006, 1.004, 0.45]}>
        <meshStandardMaterial
          color="#c95f1f"
          metalness={0.8}
          roughness={0.28}
          envMapIntensity={1.3}
        />
      </mesh>
      {/* side buttons */}
      <mesh position={[1.56, 0.9, 0]}>
        <boxGeometry args={[0.03, 0.52, 0.06]} />
        <meshStandardMaterial color="#c95f1f" metalness={0.8} roughness={0.3} />
      </mesh>
      <mesh position={[-1.56, 1.1, 0]}>
        <boxGeometry args={[0.03, 0.34, 0.06]} />
        <meshStandardMaterial color="#c95f1f" metalness={0.8} roughness={0.3} />
      </mesh>
      {/* rear camera plateau */}
      <CameraPlateau />
      {/* thin, even dark bezel frame inset around the screen */}
      <mesh geometry={bezelGeometry} position={[0, 0, 0.0825]}>
        <meshStandardMaterial color="#17181a" metalness={0.2} roughness={0.6} />
      </mesh>
      {/* bright screen — the centerpiece */}
      <mesh position={[0, 0, 0.085]}>
        <planeGeometry args={[SCREEN_PLANE_W, SCREEN_PLANE_H]} />
        <meshBasicMaterial map={screen.texture} toneMapped={false} />
      </mesh>
      {/* clearcoat glass sheen just above the screen */}
      <mesh position={[0, 0, 0.092]}>
        <planeGeometry args={[SCREEN_PLANE_W, SCREEN_PLANE_H]} />
        <meshPhysicalMaterial
          color="#ffffff"
          transparent
          opacity={0.06}
          roughness={0}
          metalness={0}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ satellites */

type SatelliteSpec = {
  kind: "torus" | "sphere" | "cube" | "ico" | "capsule";
  color: string;
  orbitRadius: number;
  scale: number;
  speed: number;
  phase: number;
  yBase: number;
  yAmp: number;
  zBase: number;
  zAmp: number;
  spin: number;
};

/** Tight ring behind/beside the phone — orbit x amplitude <= 3.4, z stays in [-1.5, -0.2]. */
const SATELLITES: SatelliteSpec[] = [
  { kind: "torus", color: TEAL, orbitRadius: 3.2, scale: 0.24, speed: 0.14, phase: 0.4, yBase: 1.5, yAmp: 0.25, zBase: -0.9, zAmp: 0.45, spin: 0.5 },
  { kind: "sphere", color: CORAL, orbitRadius: 2.8, scale: 0.2, speed: 0.11, phase: 2.2, yBase: -1.1, yAmp: 0.3, zBase: -0.7, zAmp: 0.4, spin: 0.3 },
  { kind: "cube", color: AMBER, orbitRadius: 3.4, scale: 0.22, speed: 0.09, phase: 3.9, yBase: 2.1, yAmp: 0.2, zBase: -1.0, zAmp: 0.4, spin: 0.6 },
  { kind: "ico", color: VIOLET, orbitRadius: 3.0, scale: 0.26, speed: 0.12, phase: 5.1, yBase: -2.0, yAmp: 0.25, zBase: -0.85, zAmp: 0.5, spin: 0.45 },
  { kind: "capsule", color: GREEN, orbitRadius: 2.6, scale: 0.18, speed: 0.16, phase: 1.3, yBase: 0.4, yAmp: 0.35, zBase: -1.05, zAmp: 0.4, spin: 0.55 },
];

function Satellite({ spec }: { spec: SatelliteSpec }) {
  const group = useRef<THREE.Group>(null);
  const mesh = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    const t = state.clock.elapsedTime;
    const a = t * spec.speed + spec.phase;
    g.position.set(
      THREE.MathUtils.clamp(Math.cos(a) * spec.orbitRadius, -3.6, 3.6),
      spec.yBase + Math.sin(a * 0.7) * spec.yAmp,
      spec.zBase + Math.sin(a) * spec.zAmp,
    );
    const m = mesh.current;
    if (m) {
      m.rotation.x = t * spec.spin;
      m.rotation.y = t * spec.spin * 0.8;
    }
  });

  const material = (
    <meshStandardMaterial color={spec.color} metalness={0.4} roughness={0.35} />
  );

  return (
    <group ref={group} scale={spec.scale}>
      {spec.kind === "torus" && (
        <mesh ref={mesh}>
          <torusGeometry args={[0.7, 0.28, 20, 40]} />
          {material}
        </mesh>
      )}
      {spec.kind === "sphere" && (
        <mesh ref={mesh}>
          <sphereGeometry args={[0.8, 28, 28]} />
          {material}
        </mesh>
      )}
      {spec.kind === "cube" && (
        <RoundedBox ref={mesh} args={[1.1, 1.1, 1.1]} radius={0.22} smoothness={4}>
          {material}
        </RoundedBox>
      )}
      {spec.kind === "ico" && (
        <mesh ref={mesh}>
          <icosahedronGeometry args={[0.85, 0]} />
          {material}
        </mesh>
      )}
      {spec.kind === "capsule" && (
        <mesh ref={mesh}>
          <capsuleGeometry args={[0.35, 0.8, 6, 14]} />
          {material}
        </mesh>
      )}
    </group>
  );
}

/* ------------------------------------------------------------------ ambience */

const PARTICLE_COUNT = 180;

/** ~180 tiny spectrum-tinted points drifting slowly at 30% opacity. */
function ParticleField() {
  const points = useRef<THREE.Points>(null);

  const { positions, colors } = useMemo(() => {
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const colors = new Float32Array(PARTICLE_COUNT * 3);
    const palette = [BLUE, VIOLET, TEAL, CORAL, AMBER, GREEN].map(
      (c) => new THREE.Color(c),
    );
    const white = new THREE.Color("#ffffff");
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 11;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 7.5;
      positions[i * 3 + 2] = -2.6 + Math.random() * 2.4;
      const color = palette[i % palette.length]
        .clone()
        .lerp(white, Math.random() * 0.4);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    return { positions, colors };
  }, []);

  useFrame((state) => {
    const p = points.current;
    if (!p) return;
    const t = state.clock.elapsedTime;
    p.rotation.y = t * 0.018;
    p.position.y = Math.sin(t * 0.22) * 0.16;
  });

  return (
    <points ref={points}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.04}
        sizeAttenuation
        vertexColors
        transparent
        opacity={0.3}
        depthWrite={false}
      />
    </points>
  );
}

/* ------------------------------------------------------------------ scene */

export default function HeroScene({ active = true }: { active?: boolean }) {
  return (
    <div className="h-full w-full" aria-hidden>
      <Canvas
        frameloop={active ? "always" : "never"}
        dpr={[1, 1.75]}
        camera={{ position: [0, 0, 8], fov: 42 }}
        gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
        style={{ background: "transparent" }}
      >
        <ambientLight intensity={0.55} />
        <directionalLight position={[4, 6, 5]} intensity={0.9} />
        <Suspense fallback={null}>
          <Environment resolution={256} frames={1}>
            <Lightformer
              intensity={1.6}
              position={[0, 4, 6]}
              rotation={[-0.5, 0, 0]}
              scale={[12, 5, 1]}
              color="#ffffff"
            />
            <Lightformer
              intensity={0.8}
              position={[-6, 1, 3]}
              rotation={[0, 1.05, 0]}
              scale={[4, 9, 1]}
              color="#eef2ff"
            />
            <Lightformer
              intensity={0.9}
              position={[6, -1, 2]}
              rotation={[0, -1.05, 0]}
              scale={[4, 9, 1]}
              color="#ffffff"
            />
            <Lightformer
              intensity={0.4}
              position={[0, -5, 3]}
              rotation={[0.6, 0, 0]}
              scale={[10, 3, 1]}
              color="#f4f5f8"
            />
          </Environment>
        </Suspense>
        <PhoneDevice />
        {SATELLITES.map((spec) => (
          <Satellite key={spec.kind} spec={spec} />
        ))}
        <ParticleField />
        <ContactShadows
          position={[0, -3.3, 0]}
          opacity={0.28}
          blur={2.6}
          far={6}
          scale={9}
          resolution={256}
        />
      </Canvas>
    </div>
  );
}
