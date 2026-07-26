// room.js — the office itself: palette, furniture, layout, and the walking map.
//
// Geometry only. Not one number displayed in this room is invented here: the
// wall screen is handed HELM's consensus by office.js and says "NO READ" until
// there is one. The desk's whole thesis is that Python computes and the view
// only renders, and that holds for the pixels on the far wall too.
import * as THREE from 'three';

// 26x18 read as a warehouse: the desks sat against the walls and the entire
// middle was bare floor. LAYOUT pulls every desk and furniture coordinate below
// toward the centre so the room looks occupied, while keeping walking lanes.
// The walls scale by the same factor — moving them alone would have put desks
// through them, since the rows already reached x -11.9 to +10.8.
const LAYOUT = 0.8;
export const ROOM = { W: 26 * LAYOUT, D: 18 * LAYOUT, WALL_H: 3.1 };

// The manager's glass cabin. Agents route through its door rather than through
// the glass, which is what makes the movement read as deliberate.
export const CABIN = { minX: 1.4 * LAYOUT, maxX: 6.4 * LAYOUT, minZ: 5.8 * LAYOUT };
export const DOOR_OUT = new THREE.Vector3(1.9 * LAYOUT, 0, 5.0 * LAYOUT);
export const DOOR_IN = new THREE.Vector3(2.0 * LAYOUT, 0, 6.4 * LAYOUT);
const CENTER = new THREE.Vector3(0, 0, 0.4);

export const M = {
  floor:   new THREE.MeshStandardMaterial({ color: 0xd8b78e, roughness: 0.95 }),
  floor2:  new THREE.MeshStandardMaterial({ color: 0xcaa87c, roughness: 0.95 }),
  wall:    new THREE.MeshStandardMaterial({ color: 0xf0c75c, roughness: 0.9, side: THREE.FrontSide }),
  wood:    new THREE.MeshStandardMaterial({ color: 0xe4c99a, roughness: 0.7 }),
  woodDark: new THREE.MeshStandardMaterial({ color: 0xc9a878, roughness: 0.7 }),
  white:   new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.6 }),
  ink:     new THREE.MeshStandardMaterial({ color: 0x201e1d, roughness: 0.55 }),
  gray:    new THREE.MeshStandardMaterial({ color: 0x8a8683, roughness: 0.7 }),
  grayLt:  new THREE.MeshStandardMaterial({ color: 0xb9b5b1, roughness: 0.8 }),
  accent:  new THREE.MeshStandardMaterial({ color: 0xec3013, roughness: 0.5 }),
  screen:  new THREE.MeshStandardMaterial({ color: 0x11304a, roughness: 0.3, emissive: 0x1b4d74, emissiveIntensity: 0.8 }),
  plant:   new THREE.MeshStandardMaterial({ color: 0x4a6b3a, roughness: 0.9 }),
  pot:     new THREE.MeshStandardMaterial({ color: 0x35322f, roughness: 0.8 }),
  yellow:  new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.6 }),
  glass:   new THREE.MeshStandardMaterial({ color: 0xbfd2da, roughness: 0.1, transparent: true,
                                            opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
};

const box = (w, h, d, mat) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = m.receiveShadow = true;
  return m;
};
const cyl = (rt, rb, h, mat, seg = 20) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.castShadow = m.receiveShadow = true;
  return m;
};

// -- seating chart ------------------------------------------------------------
// Each seat is where the AGENT stands (behind its desk), plus the way it faces.
// Wings are kept together so the room reads like the org chart it is.
const SEAT_ORDER = [
  'TIDE', 'KRAKEN', 'COIL', 'CHARTIST', 'SIGMA', 'VESTA',   // north row
  'CASSANDRA', 'HOUND', 'GEIGER', 'BALLAST', 'VIPER',        // west row
  'SENTINEL', 'PILOT', 'LEDGER',                             // east pod (guard)
  'HELM',                                                     // the glass cabin
];
export const SEATS = {};
const deskPlan = [];

function seat(name, x, z, ry) {
  // The chair sits 0.62 behind the desk; that is where the agent lives.
  const back = new THREE.Vector3(0, 0, 0.62).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
  SEATS[name] = { name, pos: new THREE.Vector3(x + back.x, 0, z + back.z), rot: ry };
  deskPlan.push({ x, z, ry });
}

const L = LAYOUT;
for (let i = 0; i < 6; i++) seat(SEAT_ORDER[i], (-9.5 + i * 2.6) * L, -7.8 * L, Math.PI);
for (let i = 0; i < 5; i++) seat(SEAT_ORDER[6 + i], -11.9 * L, (-4.2 + i * 2.5) * L, Math.PI / 2);
seat(SEAT_ORDER[11], 9.0 * L, -5.4 * L, -Math.PI / 2);
seat(SEAT_ORDER[12], 9.0 * L, -2.9 * L, -Math.PI / 2);
seat(SEAT_ORDER[13], 10.8 * L, -4.2 * L, Math.PI / 2);
seat('HELM', 3.9 * L, 7.6 * L, 0);                          // manager's cabin

export const CONF_SEATS = [];
export const LOUNGE_SPOTS = [
  { pos: new THREE.Vector3(-8.1 * LAYOUT, 0, 6.05 * LAYOUT), rot: Math.PI, sofa: true },
  { pos: new THREE.Vector3(-6.9 * LAYOUT, 0, 6.05 * LAYOUT), rot: Math.PI, sofa: true },
];
export const COFFEE_SPOT = new THREE.Vector3(10.4 * LAYOUT, 0, 5.4 * LAYOUT);
export const TABLE_CENTER = new THREE.Vector3(2.5 * LAYOUT, 0, 2.6 * LAYOUT);

/** Route around the cabin glass and across the open floor. */
export function planPath(from, to) {
  const inCabin = (p) => p.x > CABIN.minX && p.x < CABIN.maxX && p.z > CABIN.minZ;
  const pts = [];
  if (inCabin(from) && !inCabin(to)) pts.push(DOOR_IN.clone(), DOOR_OUT.clone());
  if (from.distanceTo(to) > 8) {
    pts.push(CENTER.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 2.5)));
  }
  if (!inCabin(from) && inCabin(to)) pts.push(DOOR_OUT.clone(), DOOR_IN.clone());
  pts.push(to.clone());
  return pts;
}

// -- furniture ----------------------------------------------------------------
function makeDesk() {
  const g = new THREE.Group();
  const top = box(1.5, 0.05, 0.75, M.wood); top.position.y = 0.73; g.add(top);
  [[-0.68, -0.3], [0.68, -0.3], [-0.68, 0.3], [0.68, 0.3]].forEach(([x, z]) => {
    const l = box(0.05, 0.71, 0.05, M.gray); l.position.set(x, 0.355, z); g.add(l);
  });
  const arm = box(0.04, 0.16, 0.04, M.ink); arm.position.set(0, 0.84, -0.22); g.add(arm);
  const scr = box(0.62, 0.36, 0.03, M.ink); scr.position.set(0, 1.07, -0.22); g.add(scr);
  const glow = box(0.56, 0.30, 0.012, M.screen); glow.position.set(0, 1.07, -0.20); g.add(glow);
  const kb = box(0.4, 0.02, 0.14, M.grayLt); kb.position.set(0, 0.765, 0.12); g.add(kb);
  const f = box(0.22, 0.06, 0.3, Math.random() < 0.5 ? M.accent : M.yellow);
  f.position.set(0.55, 0.785, -0.1); f.rotation.y = 0.15; g.add(f);
  return g;
}

function makeChair() {
  const g = new THREE.Group();
  const s = box(0.44, 0.06, 0.44, M.ink); s.position.y = 0.45; g.add(s);
  const b = box(0.44, 0.5, 0.06, M.ink); b.position.set(0, 0.75, 0.21); g.add(b);
  const p = cyl(0.03, 0.03, 0.2, M.gray); p.position.y = 0.34; g.add(p);
  const base = cyl(0.24, 0.26, 0.04, M.gray); base.position.y = 0.22; g.add(base);
  return g;
}

function makePlant(scene, x, z) {
  const g = new THREE.Group();
  const p = cyl(0.18, 0.14, 0.3, M.pot); p.position.y = 0.15; g.add(p);
  const s = cyl(0.02, 0.03, 0.5, M.plant); s.position.y = 0.5; g.add(s);
  for (let i = 0; i < 5; i++) {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), M.plant);
    leaf.castShadow = true;
    const a = i / 5 * Math.PI * 2;
    leaf.position.set(Math.cos(a) * 0.14, 0.78 + (i % 2) * 0.1, Math.sin(a) * 0.14);
    leaf.scale.set(1, 0.7, 1); g.add(leaf);
  }
  g.position.set(x, 0, z); scene.add(g);
}

function makeShelf(scene, x, z, ry) {
  const g = new THREE.Group();
  const body = box(1.2, 1.5, 0.35, M.white); body.position.y = 0.75; g.add(body);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const cell = box(0.3, 0.34, 0.06, [M.accent, M.ink, M.yellow, M.grayLt][(r * 3 + c) % 4]);
    cell.position.set(-0.38 + c * 0.38, 0.32 + r * 0.44, 0.16); g.add(cell);
  }
  g.position.set(x, 0, z); g.rotation.y = ry; scene.add(g);
}

function makeVase(scene, x, y, z, colour) {
  const g = new THREE.Group();
  const v = cyl(0.05, 0.07, 0.16, M.white); v.position.y = 0.08; g.add(v);
  const fM = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.6 });
  for (let i = 0; i < 4; i++) {
    const ox = (Math.random() - 0.5) * 0.05, oz = (Math.random() - 0.5) * 0.05;
    const st = cyl(0.006, 0.006, 0.15, M.plant);
    st.position.set(ox, 0.22, oz); st.rotation.z = (Math.random() - 0.5) * 0.35; g.add(st);
    const fl = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 6), fM);
    fl.castShadow = true; fl.position.set(ox * 2, 0.3, oz * 2); g.add(fl);
  }
  g.position.set(x, y, z); scene.add(g);
}

/** The painted city outside — a texture, not geometry, so orbiting stays cheap. */
function skylineTexture() {
  const c = document.createElement('canvas'); c.width = 1536; c.height = 512;
  const x = c.getContext('2d');
  const grd = x.createLinearGradient(0, 0, 0, 512);
  grd.addColorStop(0, '#aecbdd'); grd.addColorStop(0.65, '#dfe9ef'); grd.addColorStop(1, '#efe9dd');
  x.fillStyle = grd; x.fillRect(0, 0, 1536, 512);
  x.fillStyle = 'rgba(255,246,220,.55)';
  x.beginPath(); x.arc(1180, 120, 70, 0, 7); x.fill();
  const band = (colour, horizon, hMin, hMax, lit) => {
    let px = -10;
    while (px < 1546) {
      const w = 40 + Math.random() * 90, h = hMin + Math.random() * (hMax - hMin);
      x.fillStyle = colour; x.fillRect(px, horizon - h, w, h + (512 - horizon));
      if (Math.random() < 0.25) x.fillRect(px + w * 0.35, horizon - h - 26, w * 0.12, 26);
      if (lit) {
        x.fillStyle = `rgba(240,235,220,${lit})`;
        for (let wy = horizon - h + 10; wy < horizon - 14; wy += 16)
          for (let wx = px + 6; wx < px + w - 8; wx += 14)
            if (Math.random() < 0.5) x.fillRect(wx, wy, 7, 9);
      }
      px += w + 6 + Math.random() * 14;
    }
  };
  band('#b3c3cf', 330, 60, 210, 0);
  band('#7e939f', 380, 90, 260, 0.18);
  band('#4d5f6b', 470, 120, 330, 0.28);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * The wall screen. Returns a draw(state) the office calls with HELM's own
 * figures — it renders "NO READ" until a real one arrives, and never invents.
 */
export function marketPanel(scene) {
  const c = document.createElement('canvas'); c.width = 640; c.height = 360;
  const x = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;

  const frame = box(2.9, 1.72, 0.08, M.ink);
  frame.position.set(3.25 * LAYOUT, 1.85, -ROOM.D / 2 + 0.05); scene.add(frame);
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 1.52), new THREE.MeshBasicMaterial({ map: tex }));
  scr.position.set(3.25 * LAYOUT, 1.85, -ROOM.D / 2 + 0.1); scene.add(scr);

  function draw(s) {
    x.fillStyle = '#101315'; x.fillRect(0, 0, 640, 360);
    x.fillStyle = '#ec3013'; x.fillRect(0, 0, 640, 8);
    x.fillStyle = '#f3f2f2'; x.font = '700 28px Archivo, sans-serif';
    x.fillText(s.symbol ? `${s.symbol} — DESK READ` : 'THE DESK', 24, 52);
    x.fillStyle = '#f2b705'; x.font = '600 18px Archivo, sans-serif';
    x.fillText(s.mode ? s.mode.toUpperCase() : 'PAPER', 520, 52);
    x.strokeStyle = '#2a2e31'; x.lineWidth = 1;
    for (let y = 90; y <= 290; y += 50) { x.beginPath(); x.moveTo(24, y); x.lineTo(616, y); x.stroke(); }

    if (s.consensus == null) {
      x.fillStyle = '#8a8683'; x.font = '700 34px Archivo, sans-serif';
      x.fillText('NO READ YET', 24, 200);
      x.font = '500 18px Archivo, sans-serif';
      x.fillText('ask the desk for a report', 24, 232);
      tex.needsUpdate = true; return;
    }
    // A bar per seat, height from that seat's real signal. No synthetic series.
    const seats = s.seats || [];
    const bw = 560 / Math.max(seats.length, 1);
    seats.forEach((r, i) => {
      const h = Math.max(2, Math.abs(r.signal) * 90);
      x.fillStyle = r.usable ? (r.signal >= 0 ? '#4caf6d' : '#ec3013') : '#3a3e41';
      const y = r.signal >= 0 ? 190 - h : 190;
      x.fillRect(28 + i * bw, y, bw - 4, h);
    });
    x.strokeStyle = '#5a5e61'; x.beginPath(); x.moveTo(24, 190); x.lineTo(616, 190); x.stroke();
    x.fillStyle = '#f3f2f2'; x.font = '700 40px Archivo, sans-serif';
    x.fillText((s.consensus >= 0 ? '+' : '') + s.consensus.toFixed(2), 24, 300);
    x.fillStyle = s.approved ? '#4caf6d' : '#ec3013';
    x.font = '600 20px Archivo, sans-serif';
    x.fillText(s.approved ? 'SENTINEL: APPROVED' : 'SENTINEL: NO TRADE', 200, 300);
    x.fillStyle = '#8a8683'; x.font = '500 16px Archivo, sans-serif';
    x.fillText('consensus of ' + seats.length + ' seats', 24, 334);
    tex.needsUpdate = true;
  }
  draw({});
  return draw;
}

/** Build the whole room. Returns nothing — everything is added to `scene`. */
export function buildRoom(scene) {
  const { W, D, WALL_H } = ROOM;

  const floorG = new THREE.Group();
  for (let i = 0; i < W; i++) for (let j = 0; j < D; j++) {
    const t = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), ((i + j) % 2) ? M.floor : M.floor2);
    t.rotation.x = -Math.PI / 2;
    t.position.set(-W / 2 + 0.5 + i, 0, -D / 2 + 0.5 + j);
    t.receiveShadow = true; floorG.add(t);
  }
  scene.add(floorG);
  const base = box(W + 0.6, 0.3, D + 0.6, M.white); base.position.y = -0.16; scene.add(base);

  // Single-sided and facing inward, so orbiting never looks through a wall.
  const wall = (w, x, z, ry) => {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(w, WALL_H), M.wall);
    g.position.set(x, WALL_H / 2, z); g.rotation.y = ry; g.receiveShadow = true; scene.add(g);
  };
  wall(W, 0, -D / 2, 0);
  wall(D, -W / 2, 0, Math.PI / 2);
  wall(W, 0, D / 2, Math.PI);
  wall(D, W / 2, 0, -Math.PI / 2);
  [[0, -D / 2 + 0.02], [0, D / 2 - 0.02]].forEach(([x, z]) => {
    const b = box(W, 0.12, 0.03, M.ink); b.position.set(x, 0.06, z); scene.add(b);
  });
  [[-W / 2 + 0.02], [W / 2 - 0.02]].forEach(([x]) => {
    const b = box(0.03, 0.12, D, M.ink); b.position.set(x, 0.06, 0); scene.add(b);
  });

  const sky = skylineTexture();
  for (let i = 0; i < 3; i++) {
    const wx = (-8.5 + i * 6.5) * L;
    const frame = box(3.2, 2.0, 0.06, M.ink);
    frame.position.set(wx, 1.75, -D / 2 + 0.04); scene.add(frame);
    const t = sky.clone(); t.needsUpdate = true;
    t.repeat.set(1 / 3, 1); t.offset.set(i / 3, 0);
    const view = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.8), new THREE.MeshBasicMaterial({ map: t }));
    view.position.set(wx, 1.75, -D / 2 + 0.07); scene.add(view);
    const mull = box(0.05, 1.8, 0.03, M.ink); mull.position.set(wx, 1.75, -D / 2 + 0.09); scene.add(mull);
  }

  const poster = box(0.06, 1.6, 1.1, M.accent); poster.position.set(-W / 2 + 0.05, 1.7, -2); scene.add(poster);
  [[2.1, 0.7, -2.1], [1.92, 0.5, -2.2]].forEach(([y, len, z]) => {
    const t = box(0.07, 0.1, len, M.white); t.position.set(-W / 2 + 0.06, y, z); scene.add(t);
  });

  for (const d of deskPlan) {
    const desk = makeDesk(); desk.position.set(d.x, 0, d.z); desk.rotation.y = d.ry; scene.add(desk);
    const back = new THREE.Vector3(0, 0, 0.62).applyAxisAngle(new THREE.Vector3(0, 1, 0), d.ry);
    const ch = makeChair(); ch.position.set(d.x + back.x, 0, d.z + back.z); ch.rotation.y = d.ry; scene.add(ch);
  }

  // conference table + chairs
  const conf = new THREE.Group();
  const top = box(3.6, 0.06, 1.5, M.woodDark); top.position.y = 0.73; conf.add(top);
  [[-1.5], [1.5]].forEach(([x]) => {
    const l = cyl(0.09, 0.11, 0.71, M.gray); l.position.set(x, 0.355, 0); conf.add(l);
  });
  conf.position.copy(TABLE_CENTER); scene.add(conf);
  for (let i = 0; i < 4; i++) {
    for (const side of [-1, 1]) {
      const cx = TABLE_CENTER.x - 1.35 + i * 0.9, cz = TABLE_CENTER.z + side * 1.15;
      const ch = makeChair(); ch.position.set(cx, 0, cz);
      ch.rotation.y = side > 0 ? Math.PI : 0; scene.add(ch);
      CONF_SEATS.push({ pos: new THREE.Vector3(cx, 0, cz), rot: side > 0 ? Math.PI : 0 });
    }
  }

  // lounge
  const sofa = new THREE.Group();
  const sb = box(2.2, 0.4, 0.85, M.grayLt); sb.position.y = 0.3; sofa.add(sb);
  const sBack = box(2.2, 0.55, 0.22, M.grayLt); sBack.position.set(0, 0.72, -0.32); sofa.add(sBack);
  [[-1], [1]].forEach(([s]) => {
    const a = box(0.22, 0.55, 0.85, M.grayLt); a.position.set(s * 1.0, 0.5, 0); sofa.add(a);
  });
  const c1 = box(0.5, 0.12, 0.5, M.accent); c1.position.set(-0.6, 0.56, -0.1); c1.rotation.y = 0.3; sofa.add(c1);
  const c2 = box(0.5, 0.12, 0.5, M.yellow); c2.position.set(0.55, 0.56, -0.05); c2.rotation.y = -0.25; sofa.add(c2);
  // From here on, world placements go through L so furniture moves inward with
  // the walls. Only x/z are scaled — heights and object sizes stay real, or the
  // chairs would shrink along with the floor plan.
  sofa.position.set(-7.5 * L, 0, 6.2 * L); sofa.rotation.y = Math.PI; scene.add(sofa);
  const lowT = box(0.9, 0.34, 0.5, M.wood); lowT.position.set(-7.5 * L, 0.17, 4.9 * L); scene.add(lowT);
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.4),
    new THREE.MeshStandardMaterial({ color: 0xe8b418, roughness: 0.95 }));
  rug.rotation.x = -Math.PI / 2; rug.position.set(-7.5 * L, 0.012, 5.5 * L); rug.receiveShadow = true; scene.add(rug);

  // water cooler + coffee corner
  const disp = new THREE.Group();
  const dBody = box(0.36, 1.0, 0.36, M.white); dBody.position.y = 0.5; disp.add(dBody);
  const dTap = box(0.3, 0.12, 0.06, M.ink); dTap.position.set(0, 0.82, 0.19); disp.add(dTap);
  const dBottle = cyl(0.15, 0.17, 0.42,
    new THREE.MeshStandardMaterial({ color: 0x7fb8d8, transparent: true, opacity: 0.55, roughness: 0.15 }));
  dBottle.position.y = 1.23; disp.add(dBottle);
  const dCap = cyl(0.05, 0.05, 0.06, M.grayLt); dCap.position.y = 1.47; disp.add(dCap);
  disp.position.set(8.4 * L, 0, 7.8 * L); scene.add(disp);

  const counter = box(2.4, 0.95, 0.7, M.white); counter.position.set(10.6 * L, 0.475, 6.4 * L); scene.add(counter);
  const cTop = box(2.5, 0.05, 0.78, M.ink); cTop.position.set(10.6 * L, 0.97, 6.4 * L); scene.add(cTop);
  const machine = box(0.45, 0.55, 0.4, M.accent); machine.position.set(11.1 * L, 1.27, 6.4 * L); scene.add(machine);
  const spout = box(0.12, 0.12, 0.14, M.ink); spout.position.set(11.1 * L, 1.12, 6.22 * L); scene.add(spout);

  // manager's cabin — HELM's glass office
  const glassPanel = (w, x, z, ry) => {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, 2.2), M.glass);
    p.position.set(x, 1.1, z); p.rotation.y = ry; scene.add(p);
    for (const y of [2.2, 0.04]) {
      const rail = ry ? box(0.06, 0.08, w, M.ink) : box(w, 0.08, 0.06, M.ink);
      rail.position.set(x, y, z); scene.add(rail);
    }
  };
  // Panel widths scale too — the cabin has to keep enclosing HELM's desk, which
  // moved inward with everything else.
  glassPanel(3.6 * L, 4.6 * L, 5.8 * L, 0);
  glassPanel(2.6 * L, 1.4 * L, 7.1 * L, Math.PI / 2);
  glassPanel(2.6 * L, 6.4 * L, 7.1 * L, Math.PI / 2);
  [[2.4, 5.8], [6.4, 5.8], [1.4, 5.8], [1.4, 8.4], [6.4, 8.4]].forEach(([x, z]) => {
    const post = box(0.08, 2.24, 0.08, M.ink); post.position.set(x * L, 1.12, z * L); scene.add(post);
  });
  const sign = box(0.9, 0.22, 0.05, M.accent); sign.position.set(3.0 * L, 2.42, 5.8 * L); scene.add(sign);

  // whiteboard, shelves, plants, flowers
  // Wall-mounted items key off W/D, which are already scaled — only their
  // along-the-wall offsets need L.
  const wb = box(0.06, 1.3, 2.6, M.white); wb.position.set(-W / 2 + 0.06, 1.7, 2.4 * L); scene.add(wb);
  const wbF = box(0.04, 1.4, 2.7, M.ink); wbF.position.set(-W / 2 + 0.03, 1.7, 2.4 * L); scene.add(wbF);
  [[2.0, 0.8], [1.75, 1.2], [1.5, 0.6]].forEach(([y, len]) => {
    const l = box(0.02, 0.05, len, M.accent); l.position.set(-W / 2 + 0.1, y, (1.6 + len / 2) * L); scene.add(l);
  });
  makeShelf(scene, -3.25 * L, -8.6 * L, 0);
  makeShelf(scene, -2 * L, 8.6 * L, Math.PI);
  makePlant(scene, -12.2 * L, 7.6 * L); makePlant(scene, 12.2 * L, -7.8 * L);
  makePlant(scene, 0.5 * L, -8.4 * L); makePlant(scene, -12.2 * L, -7.8 * L);
  makeVase(scene, TABLE_CENTER.x, 0.76, TABLE_CENTER.z, 0xf2b705);
  makeVase(scene, 9.7 * L, 1.0, 6.4 * L, 0xec3013);
  makeVase(scene, -7.5 * L, 0.34, 4.9 * L, 0xf2b705);
  makeVase(scene, 4.4, 0.755, 7.35, 0xec3013);
}
