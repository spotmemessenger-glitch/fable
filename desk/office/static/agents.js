// agents.js — the staff: fifteen distinct rigged people who walk the office.
//
// Three gotchas this file exists to absorb:
//   * Each FBX was converted in its own Blender session, so every rig came out
//     with a different bone-name prefix (mixamorig / mixamorig4 / mixamorig7).
//     A clip naming bones the model lacks binds to nothing and the character
//     just stands in its T-pose — so clips are retargeted onto each character's
//     own prefix before any action is built.
//   * Mixamo bakes root translation in centimetres, which against a metre-scaled
//     rig hurls the body ~90 units off its desk. Position tracks are stripped so
//     everything plays in place; the desk decides where an agent stands.
//   * There is no walk clip. Rather than wait for one, walking is procedural:
//     a standing idle plays through the mixer and the legs/arms are overwritten
//     AFTER mixer.update() each frame. The swing axis is derived per bone from
//     the bind pose (the local axis that maps to world X), so it is correct no
//     matter how Mixamo happened to orient that skeleton.
import * as THREE from 'three';
import { GLTFLoader } from './vendor/GLTFLoader.js?v=10';
import { clone as skeletonClone } from './vendor/SkeletonUtils.js?v=10';
import { planPath, SEATS, CONF_SEATS, LOUNGE_SPOTS, COFFEE_SPOT } from './room.js?v=10';

const STANCE_COLOUR = {
  long: 0x2fd66b, short: 0xff4d61, flat: 0x6b7688,
  'lean long': 0x8fd66b, 'lean short': 0xff8a7a,
};
const TARGET_HEIGHT = 1.75;        // metres — normalise whatever the rig ships as
const WALK_SPEED = 1.5;            // m/s, the pace of someone crossing an office
const TURN_SPEED = 4.0;            // rad/s-ish easing when turning to a speaker
const NOTE_EVERY = 5.5;            // seconds between glances down to write

// A real trading floor is mostly people sitting still. The first cut fired an
// ambient event every 12-52s per agent — across 15 seats that is someone
// standing up every two seconds, which reads as a crowd milling about rather
// than a desk working. These numbers make stillness the default: a given seat
// leaves roughly twice an hour, and at most two people are away at once.
const AMBIENT_MIN = 240;           // seconds before a seat considers moving
const AMBIENT_SPREAD = 360;        // ...plus up to this much, so they desync
const MAX_ROAMING = 2;             // hard cap on simultaneous wanderers
const SETTLE_IN = 45;              // grace period after arriving before moving again

// Heads down by default: everyone stays at their desk facing their screen, and
// the only reason to leave it is being called to the table. Coffee runs and
// corridor chat are still implemented — flip manager.roaming = true to get an
// office that mills about. Meetings are unaffected either way.
const ROAMING_DEFAULT = false;
const ASSET_V = 9;                 // bump after re-exporting any GLB (browsers cache hard)

// One entry per distinct person. Each file's own animation becomes that
// character's desk pose, which gives the room natural variety.
const CAST = [
  { file: 'agent.glb', who: 'Ch22' },
  { file: 'anim_idle.glb', who: 'Boss' },
  { file: 'anim_sit.glb', who: 'Ch08' },
  { file: 'anim_work.glb', who: 'Ch12' },
  { file: 'anim_salute.glb', who: 'Beta' },
  { file: 'char_clap.glb', who: 'Ch02' },
  // Peasant Girl, flipping switches — a console-operator idle that suits a desk
  // far better than the dance clip this replaces. Same character mesh as the
  // old char_dance.glb, so that file is retired rather than kept alongside it;
  // two identical-looking people would break the all-distinct cast.
  { file: 'char_cassandra.glb', who: 'Peasant' },
  { file: 'char_fax2.glb', who: 'Ch41' },
  { file: 'char_angry.glb', who: 'Stylised' },
  { file: 'char_files.glb', who: 'Ch06' },
  { file: 'char_beckon.glb', who: 'Ch42' },
  { file: 'char_vesta.glb', who: 'Sitting2' },
  // Original in-house character — built from scratch in Blender (saree, jhumkas,
  // butterfly clip), fully owned, no third-party asset. Ships its own Idle clip.
  { file: 'char_saree.glb', who: 'Saree' },
  // char_point.glb is the Boss character again (different animation only), so
  // it is left out — the cast stays all-distinct.
];
// Seats that must have a specific character, by operator request. Everything
// else is handed a person in order.
const PINNED = { VESTA: 'char_vesta.glb', CASSANDRA: 'char_cassandra.glb' };

const SWING_BONES = ['LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftArm', 'RightArm'];

export async function loadAssets() {
  const loader = new GLTFLoader();
  const v = '?v=' + ASSET_V;
  const [talkGltf, standGltf, ...castGltf] = await Promise.all([
    loader.loadAsync('/static/models/anim_talk.glb' + v),
    loader.loadAsync('/static/models/anim_idle.glb' + v),
    ...CAST.map((c) => loader.loadAsync('/static/models/' + c.file + v)),
  ]);
  const rawTalk = (talkGltf.animations && talkGltf.animations[0]) || null;
  const rawStand = (standGltf.animations && standGltf.animations[0]) || null;

  const cast = castGltf.map((g, i) => {
    const prefix = bonePrefix(g.scene);
    const own = (g.animations && g.animations[0]) || null;
    const pose = retarget(own, prefix);
    // A non-Mixamo rig can't take the shared clips; fall back to its own.
    const talk = prefix ? (retarget(rawTalk, prefix) || pose) : pose;
    const stand = prefix ? (retarget(rawStand, prefix) || pose) : pose;
    return { file: CAST[i].file, who: CAST[i].who, scene: g.scene, clips: { pose, talk, stand } };
  });
  return { cast };
}

function bonePrefix(root) {
  let prefix = null;
  root.traverse((o) => {
    if (!prefix && o.isBone) {
      const m = o.name.match(/^(mixamorig\d*)/);
      if (m) prefix = m[1];
    }
  });
  return prefix;
}

function retarget(clip, prefix) {
  if (!clip) return null;
  const c = clip.clone();
  if (prefix) for (const t of c.tracks) t.name = t.name.replace(/^mixamorig\d*/, prefix);
  c.tracks = c.tracks.filter((t) => !t.name.endsWith('.position'));
  return c;
}

export class Agent {
  constructor(seat, character) {
    this.seat = seat;                       // the roster card (name, role, colour…)
    this.name = seat.name;
    this.who = character.who;
    this.colour = seat.colour;
    this.spot = SEATS[seat.name] || SEATS.HELM;
    this.usable = false;
    this.facts = [];
    this.log = [];
    this.state = 'typing';
    this.statusTxt = 'at desk';
    this.speaking = false;
    this.walk = null;
    this.hold = 0;
    // Spread the first move across the whole window so the room doesn't all
    // stand up together a few minutes after load.
    this.nextEvent = AMBIENT_MIN + Math.random() * AMBIENT_SPREAD;
    this.partner = null;
    this.phase = Math.random() * 6;
    this.busy = false;                      // held by the desk during a report

    this.group = new THREE.Group();

    const model = skeletonClone(character.scene);
    // Measure only after world matrices exist, or the box comes back degenerate
    // and the derived scale explodes the character to fill the room.
    model.updateMatrixWorld(true);
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(model).getSize(size);
    let s = 1;
    if (Number.isFinite(size.y) && size.y > 1e-4) s = TARGET_HEIGHT / size.y;
    s = Math.min(Math.max(s, 0.0005), 20);
    model.scale.setScalar(s);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    model.position.y = -box.min.y;                 // feet on the floor
    model.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    this.model = model;
    this.group.add(model);

    // Per-bone swing axis, in that bone's own local space. Derived from the
    // bind pose so it holds for every rig regardless of its orientation.
    this.swing = {};
    model.traverse((o) => {
      if (!o.isBone) return;
      const short = SWING_BONES.find((b) => o.name.endsWith(b));
      if (!short || this.swing[short]) return;
      const wq = new THREE.Quaternion();
      o.getWorldQuaternion(wq);
      this.swing[short] = { bone: o, axis: new THREE.Vector3(1, 0, 0).applyQuaternion(wq.invert()).normalize() };
    });

    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    for (const [key, clip] of Object.entries(character.clips)) {
      if (!clip) continue;
      const act = this.mixer.clipAction(clip);
      act.loop = THREE.LoopRepeat;
      this.actions[key] = act;
    }
    this.deskPose = this.actions.pose ? 'pose' : 'stand';
    this.current = this.actions[this.deskPose];
    if (this.current) { this.current.reset().play(); this.current.time = Math.random() * 2; }

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.46, 28),
      new THREE.MeshBasicMaterial({ color: STANCE_COLOUR.flat, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.02;
    this.group.add(this.ring);

    this.group.position.copy(this.spot.pos);
    this.group.rotation.y = this.spot.rot;
  }

  pushLog(text) {
    const d = new Date();
    const stamp = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    this.log.unshift([stamp, text]);
    if (this.log.length > 6) this.log.pop();
    if (this.onLog) this.onLog(this);
  }

  _play(key) {
    const next = this.actions[key];
    if (!next || next === this.current) return;
    next.reset().play();
    if (this.current) this.current.crossFadeTo(next, 0.3, false);
    this.current = next;
  }

  setSpeaking(on) {
    this.speaking = on;
    if (on) { this._play('talk'); this.statusTxt = 'reporting'; }
    else { this._play(this.state === 'walking' ? 'stand' : this.deskPose); this.statusTxt = this.state === 'typing' ? 'at desk' : this.statusTxt; }
  }

  faceTowards(point) {
    const look = point.clone().sub(this.group.position);
    this.group.rotation.y = Math.atan2(look.x, look.z);
    this.turnTarget = null;         // an explicit snap cancels any easing
  }

  /** Turn to face a point over time rather than snapping. */
  lookAt(point) {
    const look = point.clone().sub(this.group.position);
    this.turnTarget = Math.atan2(look.x, look.z);
  }

  /**
   * A small writing motion on the arms, applied AFTER mixer.update() so it
   * overrides the seated clip rather than being overwritten by it — the same
   * ordering _applyWalk depends on.
   */
  _applyNotes(dt) {
    this.notePhase = (this.notePhase || 0) + dt * (this.writing ? 6.5 : 0);
    const amp = this.writing ? 0.16 : 0;
    if (!amp && !this._notesDirty) return;
    const s = this.swing.RightArm;
    if (s) s.bone.rotateOnAxis(s.axis, Math.sin(this.notePhase) * amp);
    this._notesDirty = amp > 0;
  }

  /** Ease toward turnTarget along the shortest arc. */
  _applyTurn(dt) {
    if (this.turnTarget === null || this.turnTarget === undefined) return;
    let delta = this.turnTarget - this.group.rotation.y;
    // Wrap into [-PI, PI] so nobody spins the long way round to look left.
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    if (Math.abs(delta) < 0.02) {
      this.group.rotation.y = this.turnTarget;
      this.turnTarget = null;
      return;
    }
    this.group.rotation.y += delta * Math.min(1, dt * TURN_SPEED);
  }

  /** Walk to a destination, routing around the cabin glass. */
  goTo(dest, onArrive = null) {
    this.state = 'walking';
    this.statusTxt = 'walking';
    this.walk = { pts: planPath(this.group.position, dest), seg: 0, arrive: onArrive };
    this._play('stand');
  }

  sitAt(spot, statusTxt, state) {
    this.group.position.set(spot.pos.x, 0, spot.pos.z);
    this.group.rotation.y = spot.rot;
    this.state = state;
    this.statusTxt = statusTxt;
    this.walk = null;
    this._play(this.deskPose);
  }

  goHome(onArrive = null) {
    this.goTo(this.spot.pos, () => {
      this.sitAt(this.spot, 'at desk', 'typing');
      this.nextEvent = SETTLE_IN + AMBIENT_MIN + Math.random() * AMBIENT_SPREAD;
      if (onArrive) onArrive();
    });
  }

  bind(reading) {
    this.usable = !!(reading && reading.state !== 'no-data' && reading.state !== 'error' && reading.confidence > 0);
    const stance = reading ? reading.stance : 'flat';
    this.stance = stance;
    this.signal = reading ? reading.signal : null;
    this.confidence = reading ? reading.confidence : null;
    this.readState = reading ? reading.state : 'no-data';
    this.ring.material.color.setHex(STANCE_COLOUR[stance] ?? STANCE_COLOUR.flat);
    this.ring.material.opacity = this.usable ? 0.85 : 0.18;
    this.facts = (reading && reading.facts) ? reading.facts : [];
    // The activity line is the seat's OWN finding, or an honest blank.
    this.pushLog(this.facts[0] || 'no usable data');
  }

  /** Overwrite the limb bones after the mixer has run, to fake a walk cycle. */
  _applyWalk(dt) {
    this.phase += dt * 7.5;
    const swing = (name, angle) => {
      const s = this.swing[name];
      if (!s) return;
      s.bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(s.axis, angle));
    };
    const a = Math.sin(this.phase);
    swing('LeftUpLeg', a * 0.55);
    swing('RightUpLeg', -a * 0.55);
    swing('LeftLeg', Math.max(0, -a) * 0.5);
    swing('RightLeg', Math.max(0, a) * 0.5);
    swing('LeftArm', -a * 0.35);
    swing('RightArm', a * 0.35);
    this.group.position.y = Math.abs(Math.sin(this.phase)) * 0.03;
  }

  update(dt) {
    this.mixer.update(dt);

    // Walking steers itself below; easing only applies when seated or standing.
    if (this.state !== 'walking') this._applyTurn(dt);

    if (this.state === 'walking' && this.walk) {
      const target = this.walk.pts[this.walk.seg];
      const dir = target.clone().sub(this.group.position); dir.y = 0;
      const dist = dir.length();
      if (dist < 0.12) {
        this.walk.seg += 1;
        if (this.walk.seg >= this.walk.pts.length) {
          const cb = this.walk.arrive;
          this.walk = null;
          this.group.position.y = 0;
          if (cb) cb();
          return;
        }
      } else {
        dir.normalize();
        this.group.position.addScaledVector(dir, Math.min(WALK_SPEED * dt, dist));
        const want = Math.atan2(dir.x, dir.z);
        let diff = ((want - this.group.rotation.y + Math.PI) % (Math.PI * 2)) - Math.PI;
        if (diff < -Math.PI) diff += Math.PI * 2;
        this.group.rotation.y += diff * Math.min(1, dt * 10);
      }
      this._applyWalk(dt);
      return;
    }

    if (this.state === 'coffee' || this.state === 'lounging' || this.state === 'chatting') {
      this.hold -= dt;
    }
  }
}

export class AgentManager {
  constructor(scene, assets) {
    this.scene = scene;
    this.assets = assets;
    this.agents = new Map();
    this.state = 'idle';          // 'idle' | 'standup'
    this._queue = [];
    this._timer = 0;
    this._prev = null;
    this.ambient = true;          // office life runs unless the desk is reporting
    this.roaming = ROAMING_DEFAULT;   // whether anyone ever leaves their desk
    this.onSpeak = null;
    this.onMeetingEnd = null;
    this.onLog = null;
    this._nextAssign = 0;
  }

  add(seat) {
    const cast = this.assets.cast;
    let character = null;
    if (PINNED[seat.name]) character = cast.find((c) => c.file === PINNED[seat.name]) || null;
    if (!character) {
      // Skip anyone pinned elsewhere so the rotation stays all-distinct.
      const pinnedFiles = new Set(Object.values(PINNED));
      const pool = cast.filter((c) => !pinnedFiles.has(c.file));
      character = pool[this._nextAssign % pool.length];
      this._nextAssign += 1;
    }
    const a = new Agent(seat, character);
    a.onLog = (agent) => { if (this.onLog) this.onLog(agent); };
    this.scene.add(a.group);
    this.agents.set(seat.name, a);
    return a;
  }

  bindReadings(readings) {
    for (const [name, a] of this.agents) a.bind(readings[name] || null);
  }

  /** Everyone stops what they're doing and walks to the conference table. */
  startMeeting(participants) {
    const present = participants.filter((n) => this.agents.has(n));
    if (!present.length) return;
    this.ambient = false;
    this.state = 'standup';
    this._queue = present.slice();
    present.forEach((name, i) => {
      const a = this.agents.get(name);
      const cs = CONF_SEATS[i % CONF_SEATS.length];
      a.busy = true;
      a.goTo(cs.pos, () => { a.sitAt(cs, 'in standup', 'meeting'); });
    });
    this._timer = 0;
    this._next();
  }

  _next() {
    if (this._prev) { this._prev.setSpeaking(false); this._prev = null; }
    if (!this._queue.length) { this._adjourn(); return; }

    const entry = this._queue.shift();
    // A queue item is either a bare seat name (the old standup) or a turn from
    // the Meeting Manager carrying the line, who it answers, and how long it
    // takes to say.
    const name = typeof entry === 'string' ? entry : entry.seat;
    const a = this.agents.get(name);
    if (!a) { this._next(); return; }

    a.setSpeaking(true);
    this._prev = a;
    this._timer = (entry && entry.seconds) || 2.4;

    // Everyone else turns to look at whoever has the floor. A rebuttal aims at
    // the seat being answered instead, so a disagreement reads as one.
    const focus = (entry && entry.addressed_to && this.agents.get(entry.addressed_to)) || null;
    if (focus) a.lookAt(focus.group.position);
    for (const [, other] of this.agents) {
      if (other === a || other.state !== 'meeting') continue;
      other.lookAt(a.group.position);
      other.noteTimer = NOTE_EVERY * Math.random();   // stagger the note-taking
    }

    if (this.onSpeak) this.onSpeak(a, entry);
  }

  /**
   * Seat everyone for a Meeting Manager agenda.
   *
   * Unlike startMeeting(), this does NOT run a timer. The caller advances the
   * meeting with focusOn() as each line finishes speaking, so the room follows
   * the audio instead of guessing how long a sentence takes.
   */
  startAgenda(turns) {
    const names = [...new Set(turns.map((t) => t.seat))].filter((n) => this.agents.has(n));
    if (!names.length) return;
    this.startMeeting(names);
    this._queue = [];            // externally driven — stop the internal timer
    this.state = 'agenda';
  }

  /** Give the floor to one turn's speaker and aim every other head at them. */
  focusOn(turn) {
    if (this._prev) { this._prev.setSpeaking(false); this._prev = null; }
    const a = this.agents.get(turn.seat);
    if (!a) return;
    a.setSpeaking(true);
    this._prev = a;

    const focus = turn.addressed_to && this.agents.get(turn.addressed_to);
    if (focus) a.lookAt(focus.group.position);
    for (const [, other] of this.agents) {
      if (other === a || other.state !== 'meeting') continue;
      other.lookAt(a.group.position);
    }
    if (this.onSpeak) this.onSpeak(a, turn);
  }

  /** End the meeting and send everyone back to their desks. */
  adjourn() {
    if (this._prev) { this._prev.setSpeaking(false); this._prev = null; }
    this._adjourn();
  }

  _adjourn() {
    for (const [, a] of this.agents) { a.busy = false; if (a.state !== 'typing') a.goHome(); }
    this.state = 'idle';
    this.ambient = true;
    if (this.onMeetingEnd) this.onMeetingEnd();
  }

  /** How many people are currently away from their desk. */
  _roaming() {
    let n = 0;
    for (const [, a] of this.agents) {
      if (a.state !== 'typing' && a.state !== 'chatted' && a.state !== 'meeting') n += 1;
    }
    return n;
  }

  /** Ambient office life — coffee, the sofa, a word with a colleague. */
  _event(a) {
    const r = Math.random();
    if (r < 0.4) {
      const dest = COFFEE_SPOT.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.4, 0, 0));
      a.goTo(dest, () => {
        a.state = 'coffee'; a.statusTxt = 'coffee'; a.hold = 6 + Math.random() * 5;
        a.group.rotation.y = Math.PI * 0.15;
        a.pushLog('stepped away for coffee');
      });
    } else if (r < 0.62) {
      const spot = LOUNGE_SPOTS[Math.floor(Math.random() * LOUNGE_SPOTS.length)];
      a.goTo(spot.pos, () => {
        a.sitAt(spot, 'on a break', 'lounging');
        a.hold = 8 + Math.random() * 7;
        a.pushLog('taking a breather');
      });
    } else {
      const others = [...this.agents.values()].filter((o) => o !== a && o.state === 'typing' && !o.busy);
      if (!others.length) { a.nextEvent = 10; return; }
      const buddy = others[Math.floor(Math.random() * others.length)];
      const side = new THREE.Vector3(0.95, 0, 0.25).applyAxisAngle(new THREE.Vector3(0, 1, 0), buddy.spot.rot);
      a.goTo(buddy.spot.pos.clone().add(side), () => {
        a.state = 'chatting'; a.statusTxt = `with ${buddy.name}`; a.hold = 7 + Math.random() * 5;
        a.partner = buddy;
        a.faceTowards(buddy.group.position);
        if (buddy.state === 'typing') { buddy.state = 'chatted'; buddy.statusTxt = `with ${a.name}`; }
        a.pushLog(`comparing notes with ${buddy.name}`);
        buddy.pushLog(`comparing notes with ${a.name}`);
      });
    }
  }

  update(dt) {
    if (this.state === 'standup') {
      this._timer -= dt;
      if (this._timer <= 0) this._next();
    }
    for (const [, a] of this.agents) {
      a.update(dt);

      // Listeners write things down. There is no writing CLIP — the rigs ship
      // only pose/talk/stand — so this drives the forearm bones directly, the
      // same trick _applyWalk uses for legs. Small and periodic: the room
      // shouldn't be fourteen statues while one person talks, but nobody
      // should look like they're conducting either.
      if (a.state === 'meeting' && !a.speaking) {
        a.noteTimer = (a.noteTimer || 0) - dt;
        if (a.noteTimer <= 0) {
          a.writing = !a.writing;
          a.noteTimer = a.writing ? 1.8 + Math.random() : NOTE_EVERY + Math.random() * 3;
        }
        a._applyNotes(dt);
      }

      if (!this.ambient || a.busy || a.speaking) continue;
      if (a.state === 'typing') {
        a.nextEvent -= dt;
        // Only let a couple of people be away at once. Without this the cap is
        // "everyone", and fifteen simultaneous coffee runs is not an office.
        if (a.nextEvent <= 0) {
          if (this.roaming && this._roaming() < MAX_ROAMING) this._event(a);
          else a.nextEvent = 60 + Math.random() * 120;   // try again later
        }
      } else if ((a.state === 'coffee' || a.state === 'lounging') && a.hold <= 0) {
        a.goHome();
      } else if (a.state === 'chatting' && a.hold <= 0) {
        const b = a.partner;
        if (b && b.state === 'chatted') { b.state = 'typing'; b.statusTxt = 'at desk'; b.nextEvent = 12 + Math.random() * 30; }
        a.partner = null;
        a.goHome();
      }
    }
  }
}
