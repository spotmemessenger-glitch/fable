// office.js — the room, the live data, and the loop. A pure client of HELM:
// it renders /api/* and never computes a number itself. Every figure on screen
// and on the wall panel came from Python; when a read fails the office says so
// rather than showing a plausible one.
import * as THREE from 'three';
// Keep ?v= in step with index.html — a versioned entry point still pulls stale
// children if their own URLs never change.
import { OrbitControls } from './vendor/OrbitControls.js?v=10';
import { buildRoom, marketPanel, ROOM, TABLE_CENTER } from './room.js?v=10';
import { AgentManager, loadAssets } from './agents.js?v=10';
import { createEars, isSpeaking, say, stopSpeaking } from './voice.js?v=10';

const $ = (id) => document.getElementById(id);
let manager = null;
let roster = [];
let ears = null;
let busy = false;                 // one spoken routine at a time
let warnedFallback = false;
let selected = null;
let following = null;
let lastNarration = '';
let drawPanel = null;

// How often the wall panel re-reads the market. 90s against a 15m timeframe is
// three refreshes per candle — enough to look live, far short of the rate that
// got VESTA's CoinGecko feed 429'd during the paper loop.
const PANEL_REFRESH_MS = 90_000;

// -- scene --------------------------------------------------------------------
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd8e2e8);
scene.fog = new THREE.Fog(0xd8e2e8, 52, 125);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 220);
camera.position.set(18, 16, 21);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.6, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2 - 0.05;
controls.minDistance = 4;
controls.maxDistance = 72;   // tall/narrow windows need real pull-back to fit the floor

scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d4d0, 0.75));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(14, 24, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -18; sun.shadow.camera.right = 18;
sun.shadow.camera.top = 18; sun.shadow.camera.bottom = -18;
sun.shadow.bias = -0.0004;
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.3);
fill.position.set(-12, 12, -12);
scene.add(fill);

buildRoom(scene);
drawPanel = marketPanel(scene);

// The camera used to sit at a fixed (18,16,21) regardless of window shape, so
// the room overflowed on anything short or narrow. Instead, pull back to
// whatever distance actually fits the floor plan at the current aspect —
// vertical fov bounds the depth, horizontal fov bounds the width, and the
// larger of the two wins.
const FRAME_PAD = 1.12;            // a little air around the walls
let framed = false;                // stop re-framing once the user orbits

function frameRoom() {
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  // Half-extents of the floor plan, plus the wall height for headroom.
  const halfW = (ROOM.W / 2) * FRAME_PAD;
  const halfD = (ROOM.D / 2) * FRAME_PAD;
  const need = Math.max(halfD / Math.tan(vFov / 2), halfW / Math.tan(hFov / 2));
  const dist = THREE.MathUtils.clamp(need, controls.minDistance, controls.maxDistance);

  // Keep the operator's viewing angle; only change how far back they stand.
  const dir = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(controls.target).addScaledVector(dir, dist);
  controls.update();
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  if (!framed) frameRoom();
}
addEventListener('resize', resize);
resize();
// Once the operator moves the camera themselves, stop overriding their choice.
controls.addEventListener('start', () => { framed = true; });

// -- HUD ----------------------------------------------------------------------
function setStatus(t) { $('status').textContent = t; }
function showReport(on) { document.body.classList.toggle('reporting', on); }

function updateBook(b) {
  $('mode').textContent = b.mode.toUpperCase();
  $('mode').className = 'badge' + (b.mode === 'live' ? ' live' : '');
  $('cash').textContent = '$' + b.cash.toLocaleString();
  $('equity').textContent = '$' + b.equity.toLocaleString();
}
function updateWallet(w) {
  $('waddr').textContent = w.address ? w.address.slice(0, 4) + '…' + w.address.slice(-4) : '—';
  $('wsol').textContent = w.sol == null ? '?' : w.sol.toFixed(4);
  $('wusdc').textContent = w.usdc == null ? '?' : w.usdc.toLocaleString();
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' → ' + r.status);
  return r.json();
}

// -- name tags ----------------------------------------------------------------
const labelsRoot = $('labels');
let labels = [];
function buildLabels() {
  labelsRoot.innerHTML = '';
  labels = [...manager.agents.values()].map((a) => {
    const el = document.createElement('div');
    el.className = 'lbl';
    el.innerHTML = `<div class="n">${a.name}</div><div class="s"></div>`;
    el.addEventListener('click', () => select(a));
    labelsRoot.appendChild(el);
    return { el, agent: a };
  });
}
const v3 = new THREE.Vector3();
function updateLabels() {
  for (const { el, agent } of labels) {
    v3.copy(agent.group.position);
    v3.y += 1.95;
    v3.project(camera);
    if (v3.z > 1 || v3.z < -1) { el.style.display = 'none'; continue; }
    el.style.display = '';
    el.style.left = ((v3.x * 0.5 + 0.5) * innerWidth) + 'px';
    el.style.top = ((-v3.y * 0.5 + 0.5) * innerHeight) + 'px';
    const d = camera.position.distanceTo(agent.group.position);
    el.style.opacity = d > 34 ? 0.35 : 1;
    el.querySelector('.s').textContent = agent.statusTxt;
    el.classList.toggle('sel', selected === agent);
    el.classList.toggle('talking', agent.speaking);
  }
}

// -- the seat card ------------------------------------------------------------
function renderLog(a) {
  $('c-log').innerHTML = a.log.map(([t, x]) => `<li><em>${t}</em><span>${x}</span></li>`).join('')
    || '<li><span>nothing read yet</span></li>';
}
function select(a) {
  selected = a;
  $('card').classList.add('open');
  $('c-name').textContent = a.name;
  $('c-role').textContent = a.seat.role;
  $('c-follow').textContent = following === a ? 'Stop following' : 'Follow';
  renderLog(a);
  updateCard();
}
function updateCard() {
  const a = selected;
  if (!a) return;
  $('c-status').textContent = a.statusTxt;
  $('c-stance').textContent = a.stance || '—';
  $('c-signal').textContent = a.signal == null ? '—' : (a.signal >= 0 ? '+' : '') + a.signal.toFixed(2);
  $('c-conf').textContent = a.confidence == null ? '—'
    : a.readState === 'no-data' ? 'no data' : (a.confidence * 100).toFixed(0) + '%';
}
$('c-close').onclick = () => { $('card').classList.remove('open'); selected = null; };
$('c-follow').onclick = () => {
  following = following === selected ? null : selected;
  $('c-follow').textContent = following ? 'Stop following' : 'Follow';
};
$('c-ask').onclick = () => { if (selected) askSeat(selected); };

// click a body, not just a tag
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
let downXY = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downXY = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downXY || !manager) return;
  const dx = e.clientX - downXY[0], dy = e.clientY - downXY[1];
  if (dx * dx + dy * dy > 25) return;                    // that was an orbit drag
  mouse.x = (e.clientX / innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / innerHeight) * 2 + 1;
  ray.setFromCamera(mouse, camera);
  const all = [...manager.agents.values()];
  const hits = ray.intersectObjects(all.map((a) => a.group), true);
  if (!hits.length) return;
  const hit = all.find((a) => {
    let o = hits[0].object;
    while (o) { if (o === a.group) return true; o = o.parent; }
    return false;
  });
  if (hit) select(hit);
});

// -- live reads ---------------------------------------------------------------
async function runRead(symbol) {
  if (!manager) { setStatus('the office is still loading…'); return null; }
  setStatus(`reading ${symbol}…`);
  showReport(true);
  try {
    const rep = await getJSON('/api/look?symbol=' + encodeURIComponent(symbol));
    manager.bindReadings(rep.readings || {});
    $('consensus').textContent = (rep.consensus >= 0 ? '+' : '') + rep.consensus.toFixed(2);
    $('ruling').textContent = (rep.approved ? 'Approved — ' : 'No trade — ') + (rep.ruling[0] || '');
    $('ruling').className = rep.approved ? 'ok' : 'no';
    lastNarration = rep.narration || '';
    $('helmline').textContent = lastNarration;
    if (selected) { renderLog(selected); updateCard(); }
    // The wall panel gets HELM's own per-seat signals — never a synthetic series.
    drawPanel({
      symbol, consensus: rep.consensus, approved: rep.approved,
      mode: $('mode').textContent,
      seats: Object.entries(rep.readings || {}).map(([, r]) => ({
        signal: r.signal || 0, usable: r.state === 'ok' || r.state === 'thin',
      })),
    });
    setStatus(`${symbol}: the desk has convened`);
    return rep;
  } catch (e) {
    setStatus('read failed: ' + e.message);
    return null;
  }
}

// -- speaking -----------------------------------------------------------------
async function speakAs(name, text) {
  const a = manager && manager.agents.get(name);
  // Addressing the CEO directly means turning to camera — but not mid-meeting,
  // where focusOn() has already aimed the speaker at the room or at the seat
  // they're answering. Snapping to camera there would undo the debate staging.
  const inMeeting = manager && (manager.state === 'agenda' || manager.state === 'standup');
  if (a) {
    if (!inMeeting) a.faceTowards(camera.position);
    a.setSpeaking(true);
  }
  const how = await say(name, text);
  if (a) a.setSpeaking(false);
  if (how === 'browser' && !warnedFallback) {
    warnedFallback = true;
    console.warn('/api/say gave no audio — using system voices. Is ELEVENLABS_API_KEY set for the server?');
  }
  return how;
}

async function introduceAll() {
  if (busy) return;
  busy = true;
  setStatus('the desk is introducing itself — say “stop” to cut in');
  try {
    let how = await speakAs('HELM', `This is the desk. ${roster.length} of us. I'll have everyone introduce themselves.`);
    for (const seat of roster) {
      if (how === 'cancelled') break;
      if (seat.name === 'HELM') continue;
      how = await speakAs(seat.name, `I'm ${seat.name}. I'm the ${seat.role.toLowerCase()}. ${firstSentence(seat.brief)}`);
    }
    if (how !== 'cancelled') setStatus('introductions done');
  } finally { busy = false; }
}

function firstSentence(text) {
  if (!text) return '';
  const m = text.match(/^[^.]{0,180}\./);
  return m ? m[0] : text.slice(0, 150);
}

/** "hey helm" — run a read, gather the desk, and have HELM deliver it. */
async function reportAloud(symbol) {
  if (busy) return;
  busy = true;
  try {
    const rep = await runRead(symbol);
    if (rep) {
      const present = ['HELM', ...Object.keys(rep.readings || {})
        .filter((n) => rep.readings[n].state === 'ok' || rep.readings[n].state === 'thin')];
      manager.startMeeting(present.slice(0, 8));
    }
    await speakAs('HELM', lastNarration || `I have nothing on ${symbol} right now.`);
  } finally { busy = false; }
}

/**
 * "Everyone to conference room." — run a full standup.
 *
 * The agenda is generated server-side from live readings, so the room walks in
 * already knowing the running order. Each line is then spoken in that seat's
 * own voice, and the next turn only starts when the current one has finished
 * talking — the choreography follows the audio rather than a fixed timer.
 */
async function conferenceRoom(symbol) {
  if (busy) return;
  busy = true;
  try {
    setStatus(`gathering the desk on ${symbol}…`);
    const res = await fetch(`/api/meeting?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) { setStatus(`meeting failed (${res.status})`); return; }
    const data = await res.json();
    const turns = data.turns || [];
    if (!turns.length) { setStatus('nobody had anything to report'); return; }

    manager.startAgenda(turns);
    setStatus(`standup — ${data.symbol}, ${turns.length} turns`);
    for (const t of turns) {
      manager.focusOn(t);
      await speakAs(t.seat, t.text);      // resolves when the audio ends
    }
  } finally {
    manager.adjourn();
    busy = false;
  }
}

async function askSeat(a) {
  if (busy) return;
  busy = true;
  try {
    const line = a.facts[0] ? `${a.facts[0]}.`
      : `I'm ${a.name}, the ${a.seat.role.toLowerCase()}. I have no usable data yet.`;
    await speakAs(a.name, line);
  } finally { busy = false; }
}

// -- voice commands -----------------------------------------------------------
const SYMBOL_WORDS = { solana: 'SOL', sol: 'SOL', bitcoin: 'BTC', btc: 'BTC', ethereum: 'ETH', eth: 'ETH' };

function interrupt(said) {
  stopSpeaking();
  setStatus(`cut off — “${said}”`);
  if (/report|read|look|status|update|introduce|roll call|think/.test(said)) {
    setTimeout(() => { if (!busy) handleCommand(said); }, 120);
  }
}

function handleCommand(said) {
  if (isSpeaking()) stopSpeaking();
  setStatus(`heard: “${said}”`);
  if (/introduce|introduction|roll call|who are you|meet the team/.test(said)) { introduceAll(); return; }
  // Checked BEFORE the wake/report branch below — "everyone to conference
  // room" carries no wake word, but the report regex would still claim it.
  if (/conference room|everyone to|all hands|team meeting|assemble|gather|stand ?up/.test(said)) {
    let symbol = ($('sym').value || 'SOL').trim().toUpperCase();
    for (const [word, sym] of Object.entries(SYMBOL_WORDS)) {
      if (said.includes(word)) { symbol = sym; break; }
    }
    $('sym').value = symbol;
    conferenceRoom(symbol);
    return;
  }
  const wake = /\bhey\s+helm\b|\bhelm\b|\bdesk\b/.test(said);
  const wantsReport = /report|read|look at|what.*think|status|update/.test(said);
  if (wake || wantsReport) {
    let symbol = ($('sym').value || 'SOL').trim().toUpperCase();
    for (const [word, sym] of Object.entries(SYMBOL_WORDS)) {
      if (said.includes(word)) { symbol = sym; break; }
    }
    $('sym').value = symbol;
    reportAloud(symbol);
    return;
  }
  for (const seat of roster) {
    if (said.includes(seat.name.toLowerCase())) {
      const a = manager && manager.agents.get(seat.name);
      if (a) { select(a); askSeat(a); }
      return;
    }
  }
}

function setMic(on) {
  if (!ears) { setStatus('this browser has no speech recognition — use Chrome'); return; }
  if (on) ears.start(); else { ears.stop(); stopSpeaking(); }
  $('mic').classList.toggle('on', on);
  $('mic').textContent = on ? '● Listening' : '🎙 Talk';
}

// -- boot ---------------------------------------------------------------------
async function init() {
  setStatus('hiring the staff…');
  const [rosterData, assets] = await Promise.all([getJSON('/api/roster'), loadAssets()]);
  roster = rosterData;
  manager = new AgentManager(scene, assets);
  manager.onSpeak = (a) => { if (selected === a) renderLog(a); };
  manager.onMeetingEnd = () => setStatus('standup over — back to work');
  manager.onLog = (a) => { if (selected === a) renderLog(a); };
  for (const seat of roster) manager.add(seat);
  $('headcount').textContent = `${roster.length} agents`;
  buildLabels();

  try { updateBook(await getJSON('/api/book')); } catch (e) { /* keep going */ }
  try { updateWallet(await getJSON('/api/wallet')); } catch (e) { /* keep going */ }

  ears = createEars({
    onCommand: handleCommand,
    onInterrupt: interrupt,
    onState: (s) => { if (s === 'denied') setStatus('microphone blocked — allow it in the address bar'); },
  });
  setStatus('the desk is at work — say “hey HELM”, or ask it to introduce the agents');

  // Take a read immediately, then keep it fresh. Without this the wall panel
  // sits on "NO READ YET" until someone speaks to the room — three big black
  // rectangles as the visual centre of an office that is supposedly working.
  // The panel refuses to invent a series, so the only honest way to fill it is
  // to actually go and read the market.
  const first = ($('sym').value || 'SOL').trim().toUpperCase();
  runRead(first).catch(() => { /* status line already reports the failure */ });
  setInterval(() => {
    // Skip while the desk is mid-sentence or mid-meeting; a read rebinds every
    // seat's reading underneath whoever is currently speaking about it.
    if (busy || isSpeaking() || (manager && manager.state !== 'idle')) return;
    runRead(($('sym').value || 'SOL').trim().toUpperCase()).catch(() => {});
  }, PANEL_REFRESH_MS);
}

$('run').addEventListener('click', () => reportAloud(($('sym').value || 'SOL').trim().toUpperCase()));
$('sym').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('run').click(); });
$('meet').addEventListener('click', () => introduceAll());
$('mic').addEventListener('click', () => setMic(!(ears && ears.listening)));

// -- clock --------------------------------------------------------------------
const t0 = Date.now();
setInterval(() => {
  const s = Math.floor((Date.now() - t0) / 1000);
  $('clockbox').textContent = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, '0')).join(':');
  updateCard();
}, 1000);

// -- loop ---------------------------------------------------------------------
const clock = new THREE.Clock();
const followOffset = new THREE.Vector3();
let hadFollow = false;
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (manager) manager.update(dt);
  if (following) {
    const p = following.group.position;
    if (!hadFollow) { followOffset.copy(camera.position).sub(controls.target); hadFollow = true; }
    controls.target.lerp(new THREE.Vector3(p.x, 0.9, p.z), Math.min(1, dt * 4));
    camera.position.lerp(controls.target.clone().add(followOffset), Math.min(1, dt * 4));
  } else hadFollow = false;
  controls.update();
  renderer.render(scene, camera);
  updateLabels();
}

window.__desk = { scene, camera, controls, THREE, ROOM, TABLE_CENTER,
  get manager() { return manager; } };      // debug handle
tick();
init().catch((e) => { console.error('office init failed', e); setStatus('office failed: ' + e.message); });
