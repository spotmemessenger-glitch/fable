/**
 * Ybot's face: viseme lip sync and task-driven expression.
 *
 * The model carries the 15 Oculus visemes plus the ARKit expression set, so
 * both halves are real morph targets — the mouth makes actual shapes rather
 * than opening to the volume of the audio, which reads as a puppet because
 * "oo" and "ee" are equally loud and nothing like each other.
 *
 * Two clocks drive the face and they are deliberately separate:
 *   - the VISEME track, whose timings come from the same synthesis call as the
 *     audio, so speech and mouth cannot drift apart;
 *   - the STATE, which is what ybot is doing (listening, thinking, working),
 *     expressed through brows, eyes and posture.
 * They compose: ybot can look focused while speaking.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const VISEMES = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR',
                 'aa', 'E', 'ih', 'oh', 'ou']

/**
 * What each state does with the face.
 *
 * Values are target weights for ARKit shape keys. Kept low on purpose: a face
 * at full blendshape weight looks like a cartoon, and this one has to be
 * watchable in the corner of a screen for hours.
 */
const STATES = {
  idle:      { browInnerUp: 0.05, mouthSmileLeft: 0.08, mouthSmileRight: 0.08 },
  listening: { browInnerUp: 0.28, eyeWideLeft: 0.16, eyeWideRight: 0.16,
               mouthSmileLeft: 0.10, mouthSmileRight: 0.10 },
  thinking:  { browDownLeft: 0.22, browDownRight: 0.22, eyeLookUpLeft: 0.35,
               eyeLookUpRight: 0.35, mouthPucker: 0.12 },
  speaking:  { browInnerUp: 0.10, mouthSmileLeft: 0.05, mouthSmileRight: 0.05 },
  working:   { browDownLeft: 0.14, browDownRight: 0.14, eyeSquintLeft: 0.18,
               eyeSquintRight: 0.18 },
  error:     { browInnerUp: 0.45, mouthFrownLeft: 0.25, mouthFrownRight: 0.25 },
}

const els = {
  state: document.getElementById('state'),
  detail: document.getElementById('detail'),
  err: document.getElementById('err'),
}

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100)
const renderer = new THREE.WebGLRenderer({
  canvas: document.getElementById('stage'), antialias: true, alpha: true,
})
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace

// Three-point-ish lighting. A single light makes skin look flat and dead;
// the rim is what keeps the silhouette readable against a dark desktop.
scene.add(new THREE.HemisphereLight(0xf4f4ff, 0x30303a, 1.6))
const key = new THREE.DirectionalLight(0xfff2e6, 2.1)
key.position.set(1.2, 2.4, 2.0)
scene.add(key)
const rim = new THREE.DirectionalLight(0x9fd7ff, 1.0)
rim.position.set(-1.6, 1.4, -1.8)
scene.add(rim)

function resize () {
  const w = innerWidth, h = innerHeight
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h, false)
}
addEventListener('resize', resize)
resize()

/** Every mesh that carries morph targets, indexed by shape-key name. */
const morphs = []
function setMorph (name, weight) {
  for (const m of morphs) {
    const i = m.dict[name]
    if (i !== undefined) m.mesh.morphTargetInfluences[i] = weight
  }
}
function hasMorph (name) {
  return morphs.some((m) => m.dict[name] !== undefined)
}

const base = { y: 0 }
const focus = { eyeY: 1.6 }

const face = {
  state: 'idle',
  track: null,          // [{t, v}] viseme frames
  startedAt: 0,         // performance.now() when the audio began
  current: {},          // smoothed weights actually applied
  blinkAt: 0,
}

/** Weights the current state wants, before viseme and blink are layered on. */
function stateTargets () {
  return STATES[face.state] || STATES.idle
}

/** The viseme that should be showing right now, or 'sil'. */
function activeViseme (now) {
  if (!face.track || !face.track.length) return 'sil'
  const t = (now - face.startedAt) / 1000
  let v = 'sil'
  for (const f of face.track) {
    if (f.t <= t) v = f.v
    else break
  }
  const last = face.track[face.track.length - 1]
  if (t > last.t + 0.4) { face.track = null; return 'sil' }
  return v
}

const clock = new THREE.Clock()
let mixer = null
let model = null

function animate () {
  requestAnimationFrame(animate)
  const dt = clock.getDelta()
  const now = performance.now()
  if (mixer) mixer.update(dt)

  // --- what the face should be, this frame -------------------------------
  const wanted = Object.assign({}, stateTargets())

  const vis = activeViseme(now)
  for (const name of VISEMES) wanted[name] = name === vis ? 1 : 0

  // Blink: irregular on purpose. A metronome blink is uncanny.
  if (now > face.blinkAt) {
    face.blinkAt = now + 1800 + Math.random() * 4200
    face._blinkUntil = now + 110
  }
  if (now < (face._blinkUntil || 0)) {
    wanted.eyeBlinkLeft = 1
    wanted.eyeBlinkRight = 1
  }

  // --- ease toward it -----------------------------------------------------
  // Visemes need to snap or speech looks slurred; expressions need to drift or
  // the face twitches between states.
  const names = new Set([...Object.keys(wanted), ...Object.keys(face.current)])
  for (const name of names) {
    const target = wanted[name] || 0
    const prev = face.current[name] || 0
    const fast = VISEMES.includes(name) || name.startsWith('eyeBlink')
    const rate = fast ? 0.45 : 0.12
    const next = prev + (target - prev) * rate
    face.current[name] = Math.abs(next - target) < 0.002 ? target : next
    setMorph(name, face.current[name])
  }

  // Breathing only. The bundled clip is a CATWALK idle — it turns the body
  // through a runway pose, which is fine for a fashion render and wrong for
  // someone you are talking to, so nothing is added on top of its rotation.
  // A forward-facing conversational idle is a different Mixamo clip, not a
  // tweak to this one.
  if (model) {
    model.position.y = base.y + Math.sin(now / 1000 * 0.8) * 0.004
  }

  renderer.render(scene, camera)
}

function setState (name) {
  face.state = STATES[name] ? name : 'idle'
  els.state.textContent = face.state
}

/**
 * Follow ybot's voice service through the relay.
 *
 * EventSource reconnects on its own, which is the behaviour wanted here: the
 * voice service starts and stops independently of this window, and a face that
 * froze permanently the first time it did would be worse than useless.
 */
function connectEvents () {
  let source
  try {
    source = new EventSource('/events')
  } catch {
    els.detail.textContent += ' · offline'
    return                       // opened as a file:// URL; harness use only
  }

  source.onmessage = (msg) => {
    let ev
    try { ev = JSON.parse(msg.data) } catch { return }
    switch (ev.type) {
      case 'speak':
        // The track and the audio came from one synthesis call, so starting
        // the clock here keeps the lips on the words.
        if (ev.visemes && ev.visemes.length) window.__avatar.say(ev.visemes)
        else setState('speaking')
        break
      case 'interrupted':
      case 'barge_in':
        window.__avatar.stop()          // mouth shuts the moment you cut in
        setState('listening')
        break
      case 'transcript':
        setState('thinking')            // heard you; working out the answer
        break
      case 'reply':
        break                           // 'speak' drives the mouth, not this
      case 'state':
        setState(ev.text)
        break
      case 'error':
        setState('error')
        els.err.textContent = ev.text || ''
        break
      case 'link':
        els.detail.textContent = `${VISEMES.filter(hasMorph).length}/15 visemes · ${ev.text}`
        break
    }
  }
  source.onerror = () => { els.detail.textContent += '' }   // retries on its own
}

new GLTFLoader().load('./avatar.glb', (gltf) => {
  model = gltf.scene
  scene.add(model)

  model.traverse((o) => {
    if (o.isMesh) {
      o.frustumCulled = false          // morphed heads mis-cull at close range
      if (o.morphTargetDictionary) {
        morphs.push({ mesh: o, dict: o.morphTargetDictionary })
      }
    }
  })

  // Frame from the model's OWN bounds rather than hardcoded distances, so a
  // differently sized avatar still lands correctly — the source here measured
  // 2.7 units, not the 1.7 a "metres" assumption would predict.
  const box = new THREE.Box3().setFromObject(model)
  model.position.y = -box.min.y
  base.y = model.position.y

  const height = box.max.y - box.min.y
  // Eye line, roughly: faces read as present when the camera meets them there,
  // and as a surveillance feed when it looks down from above.
  const eyeY = height * 0.93
  // Close enough to hold a conversation with. FRAME controls how much of her
  // fills the view: at 0.42 it is head-and-shoulders, which is the framing
  // people actually talk to. Pull it up for more of the saree, down for a
  // tighter face.
  const FRAME = 0.42
  camera.position.set(0, eyeY, height * FRAME)
  camera.lookAt(0, eyeY * 0.985, 0)
  focus.eyeY = eyeY

  if (gltf.animations.length) {
    mixer = new THREE.AnimationMixer(model)
    mixer.clipAction(gltf.animations[0]).play()
  }

  const found = VISEMES.filter(hasMorph)
  els.detail.textContent = `${found.length}/15 visemes`
  if (found.length < 15) {
    els.err.textContent = `missing visemes: ${VISEMES.filter((v) => !hasMorph(v)).join(', ')}`
  }
  setState('idle')

  // Exposed for the harness and for ybot's bridge: this is the whole API.
  window.__avatar = {
    setState,
    say: (track) => { face.track = track; face.startedAt = performance.now(); setState('speaking') },
    stop: () => { face.track = null; setState('idle') },      // barge-in: mouth closes at once
    info: () => ({
      visemes: found.length,
      morphMeshes: morphs.length,
      animations: gltf.animations.map((a) => a.name),
      state: face.state,
      speaking: !!face.track,
    }),
  }
  connectEvents()
  animate()
}, undefined, (err) => {
  els.err.textContent = `could not load avatar.glb — ${err?.message || err}`
  els.state.textContent = 'error'
})
