/**
 * Spot Me — place a REAL call through LiveKit and measure it. ADR-004.
 *
 * NOT part of `npm test`. It needs Docker, a browser and about a minute, and a
 * suite that cannot run on a laptop with no daemon is a suite people stop
 * running. Run it by hand when the call path changes:
 *
 *   docker run -d --rm --name spotme-livekit -p 7880:7880 -p 7881:7881 \
 *     -p 7882:7882/udp -e LIVEKIT_KEYS="devkey: <32+ char dev secret>" \
 *     livekit/livekit-server:latest --dev --bind 0.0.0.0
 *   node test/livekit-call.harness.mjs
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROVES, AND WHAT IT CANNOT
 *
 * PROVES: N independent browsers, each with its own camera and microphone, join
 * the same room through `src/lib/calls/livekit-media.js` — the real adapter, not
 * a reimplementation — publish audio and video, subscribe to EVERY other
 * participant, and DECODE FRAMES AND SAMPLES FROM ALL OF THEM. The assertion is
 * `framesDecoded > 0` and audio bytes received on each side, because "a track
 * object arrived" is not media; a track that never decodes a frame produces
 * exactly the black rectangle users report as "the call connected but I can't
 * see anything".
 *
 * Run with three participants (the default) and it is a GROUP call: each side
 * must end up with two remote streams, which is the claim `rooms.js` makes when
 * it keeps a Map instead of a single remote. Two participants is the 1:1 case
 * and the same code path.
 *
 *   node test/livekit-call.harness.mjs        # 3 participants (group)
 *   node test/livekit-call.harness.mjs 2      # 1:1
 *
 * CANNOT PROVE: behaviour on a real mobile network. Both browsers are on this
 * machine, so ICE resolves to host candidates and the path is local. Carrier
 * NAT, packet loss, handover between cells and the Metered relay are untested
 * here by construction — see the report for what remains unverified.
 *
 * Chromium's fake devices are real encoded media: a rolling test pattern and a
 * tone, captured, encoded, sent through the SFU, and decoded on the far side.
 * The pixels are synthetic; every step between them is not.
 */

import { chromium } from 'playwright'
import { createHmac } from 'node:crypto'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const LIVEKIT_URL = process.env.HARNESS_LIVEKIT_URL || 'ws://localhost:7880'
const LIVEKIT_KEY = process.env.HARNESS_LIVEKIT_KEY || 'devkey'
const LIVEKIT_SECRET = process.env.HARNESS_LIVEKIT_SECRET || 'secretdevsecretdevsecretdevsecret32'
const ROOM_ID = `harness-${Date.now()}`
const PARTICIPANTS = Number(process.argv[2]) || 3
const HARNESS_PORT = 5199
const HARNESS_ORIGIN = `http://localhost:${HARNESS_PORT}`

/**
 * The same claim shape `backend/src/calls/livekit.service.ts` mints.
 *
 * Duplicated here ON PURPOSE and only here: booting Nest and a Postgres just to
 * obtain a JWT would make this harness something nobody runs. The backend's
 * copy is the one that ships and is pinned by `test/livekit-calls.spec.ts`; if
 * these two ever disagree, this harness fails to connect — which is the loud
 * outcome, not the silent one.
 */
function mintToken (identity, roomName) {
  const now = Math.floor(Date.now() / 1000)
  const b64 = (s) => Buffer.from(s).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64(JSON.stringify({
    iss: LIVEKIT_KEY,
    sub: identity,
    nbf: now - 60,
    iat: now,
    exp: now + 600,
    video: {
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false
    }
  }))
  const sig = b64(createHmac('sha256', LIVEKIT_SECRET).update(`${header}.${payload}`).digest())
  return `${header}.${payload}.${sig}`
}

/**
 * Serve the app so the page can import the REAL adapter module.
 *
 * Reuses a dev server already listening on the port rather than starting a
 * second one. Two vite processes fighting over --strictPort is not a
 * hypothetical: the first version of this harness spawned its own every run,
 * the previous run's process outlived it (killing a shell does not kill the
 * child it spawned), and the resulting failure looked exactly like a broken
 * call — the browser simply had nothing to load.
 */
async function startDevServer (cwd) {
  try {
    const existing = await fetch(HARNESS_ORIGIN, { signal: AbortSignal.timeout(1500) })
    if (existing.ok) {
      console.log(`(reusing dev server already on ${HARNESS_ORIGIN})`)
      return null
    }
  } catch { /* nothing there; start one */ }

  const proc = spawn('npx', ['vite', '--port', String(HARNESS_PORT), '--strictPort'], {
    cwd,
    shell: true,
    stdio: 'pipe'
  })
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(HARNESS_ORIGIN)
      if (res.ok) return proc
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error('vite dev server did not start')
}

/**
 * One participant: a browser with its own fake camera and mic, running the real
 * adapter against stubbed backend endpoints.
 *
 * The stubs cover ONLY the three HTTP calls the adapter makes — config, token
 * and ICE. The LiveKit connection, publish, subscribe, decode and stats paths
 * are the shipping code, unmodified.
 */
async function joinAs (browser, identity) {
  const context = await browser.newContext({ permissions: ['microphone', 'camera'] })
  const page = await context.newPage()

  const token = mintToken(identity, `spotme-call-${ROOM_ID}`)
  await page.addInitScript(({ token, url }) => {
    const real = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const href = String(input?.url || input)
      if (href.includes('/api/v2/calls/config')) {
        return new Response(JSON.stringify({ available: true, url }), {
          headers: { 'content-type': 'application/json' }
        })
      }
      if (href.includes('/api/v2/calls/token')) {
        return new Response(JSON.stringify({ token, url, expiresIn: 600 }), {
          headers: { 'content-type': 'application/json' }
        })
      }
      if (href.includes('/api/turn')) {
        return new Response(JSON.stringify({ iceServers: [], relay: false, provider: 'none' }), {
          headers: { 'content-type': 'application/json' }
        })
      }
      return real(input, init)
    }
  }, { token, url: LIVEKIT_URL })

  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [${identity}] console error: ${m.text()}`)
  })

  await page.goto(HARNESS_ORIGIN)

  const result = await page.evaluate(async ({ roomId }) => {
    const { joinCallMedia } = await import('/src/lib/calls/livekit-media.js')
    const localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })

    const startedAt = performance.now()
    window.__remotes = new Map()
    window.__remote = null
    window.__connectedAt = null

    const handle = await joinCallMedia({
      roomId,
      localStream,
      onRemoteStream: (stream, who) => {
        // A Map, exactly as rooms.js keeps one: same stream object per person,
        // so a second track from someone already seen updates rather than adds.
        window.__remotes.set(who, { who, id: stream.id, tracks: stream.getTracks().map((t) => t.kind) })
        window.__remote = window.__remotes.get(who)
        if (window.__connectedAt === null) window.__connectedAt = performance.now() - startedAt
        // Attach to a real element: a track nobody plays may never be decoded,
        // and "framesDecoded" would then be measuring the harness, not the call.
        const video = document.createElement('video')
        video.autoplay = true
        video.muted = true
        video.playsInline = true
        video.srcObject = stream
        document.body.appendChild(video)
        video.play().catch(() => {})
      }
    })

    window.__handle = handle
    return { published: localStream.getTracks().map((t) => t.kind) }
  }, { roomId: ROOM_ID })

  return { context, page, result }
}

/**
 * Inbound media, measured at the decoder rather than at the event handler.
 *
 * Deliberately asks the SHIPPING `stats()` for the numbers rather than
 * reimplementing the walk here: if that function is wrong, this harness must
 * fail. An earlier version did reimplement it, reached into SDK internals that
 * 2.x renamed, and reported a call the server logs proved was working as a
 * total failure — a harness that lies in the safe direction is still a harness
 * that lies.
 */
async function inboundStats (page) {
  return page.evaluate(async () => ({
    remote: window.__remote,
    remotes: [...window.__remotes.values()],
    connectedMs: window.__connectedAt,
    timings: window.__handle.timings,
    path: await window.__handle.stats()
  }))
}

async function main () {
  console.log(`LiveKit call harness — room ${ROOM_ID}\n`)
  const webRoot = process.cwd()
  const server = await startDevServer(webRoot)

  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required'
    ]
  })

  let failed = false
  const expectedRemotes = PARTICIPANTS - 1
  try {
    const sides = []
    for (let i = 0; i < PARTICIPANTS; i++) {
      const name = `harness-${i + 1}`
      console.log(`${name} joining…`)
      const side = await joinAs(browser, name)
      console.log(`  published: ${side.result.published.join(', ')}`)
      sides.push({ name, ...side })
    }

    // Media needs a moment to flow — this measures a call in progress, not a
    // handshake. The later joiners also need time to be subscribed to by those
    // already in the room.
    await sleep(7000)

    for (const side of sides) {
      const stats = await inboundStats(side.page)
      const seen = stats.remotes ?? []
      console.log(`\n${side.name}:`)
      console.log(`  remote participants: ${seen.length} (${seen.map((r) => r.who).join(', ') || 'NONE'})`)
      console.log(`  tracks per remote  : ${seen.map((r) => `${r.who}=[${r.tracks.join('+')}]`).join('  ') || 'none'}`)
      console.log(`  time to media (ms) : ${Math.round(stats.connectedMs ?? -1)}  (from this side's join)`)
      console.log(`  breakdown (ms)     : sdk ${stats.timings?.sdkMs}  token+ice ${stats.timings?.tokenMs}  connect ${stats.timings?.connectMs}  publish ${stats.timings?.publishMs}`)
      console.log(`  frames decoded     : ${stats.path?.framesDecoded}`)
      console.log(`  audio bytes in     : ${stats.path?.audioBytes}`)
      console.log(`  video bytes in     : ${stats.path?.videoBytes}`)
      console.log(`  candidate pair     : ${stats.path?.localCandidateType} -> ${stats.path?.remoteCandidateType} over ${stats.path?.protocol}`)
      console.log(`  relayed (TURN)     : ${stats.path?.relay}`)

      // The assertions. Anything less and this is a connection test, not a call.
      if (seen.length !== expectedRemotes) {
        console.log(`  FAIL: ${side.name} sees ${seen.length} remotes, expected ${expectedRemotes}`)
        failed = true
      }
      // Every remote must carry BOTH kinds in ONE stream — the bug that shipped
      // audio and video as separate MediaStreams looked exactly like success
      // until you counted the tracks.
      for (const r of seen) {
        if (!(r.tracks.includes('audio') && r.tracks.includes('video'))) {
          console.log(`  FAIL: ${side.name} sees ${r.who} with tracks [${r.tracks.join('+')}], expected audio+video`)
          failed = true
        }
      }
      if (!(stats.path?.framesDecoded > 0)) { console.log(`  FAIL: ${side.name} decoded no video frames`); failed = true }
      if (!(stats.path?.audioBytes > 0)) { console.log(`  FAIL: ${side.name} received no audio bytes`); failed = true }
    }

    console.log('\nhanging up…')
    for (const side of sides) {
      await side.page.evaluate(() => window.__handle.disconnect())
      await side.context.close()
    }
  } finally {
    await browser.close()
    if (server) server.kill()
  }

  console.log(failed
    ? `\nRESULT: FAILED — ${PARTICIPANTS}-way call did not carry media to everyone`
    : `\nRESULT: PASSED — ${PARTICIPANTS} participants, audio and video decoded by all`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('harness error:', e)
  process.exit(1)
})
