// voice.js — the office's ears and mouth.
//
// Mouth: /api/say returns that seat's own ElevenLabs voice as mp3. If no key is
// configured the server answers 204 and we fall back to the browser's built-in
// speech — and even then each seat gets a different system voice, so fifteen
// agents never sound like one.
//
// Ears: the browser's SpeechRecognition, which keeps listening WHILE the desk
// talks. That is what makes barge-in possible: say "stop" or "hey helm" over a
// roll call and it cuts off mid-sentence instead of finishing all fifteen.
//
// say() resolves when the audio finishes OR when it is cut off, so a caller
// sequencing a roll call is never left awaiting a promise that can't settle.

let current = null;      // { stop() } for whatever is in flight
let generation = 0;      // bumped on every cancel; invalidates in-flight fetches

/** Short phrases that cut the desk off mid-sentence. */
const INTERRUPT = /^(stop|wait|quiet|enough|hold on|shut up|silence|cancel|hey desk|hey helm|helm)\b/;

export function isSpeaking() { return current !== null; }

function playUrl(url) {
  return new Promise((resolve) => {
    const a = new Audio(url);
    let done = false;
    const finish = () => { if (done) return; done = true; current = null; resolve(); };
    a.onended = a.onerror = finish;
    // pause() fires no event, so the canceller resolves the promise itself.
    current = { stop() { try { a.pause(); } catch (e) { /* already gone */ } finish(); } };
    a.play().catch(finish);
  });
}

// -- fallback voices ----------------------------------------------------------
// getVoices() is empty until the engine populates it, hence the event.
let systemVoices = [];
function refreshVoices() {
  if (!window.speechSynthesis) return;
  const all = speechSynthesis.getVoices();
  systemVoices = all.filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
  if (!systemVoices.length) systemVoices = all;
}
if (window.speechSynthesis) {
  refreshVoices();
  speechSynthesis.addEventListener('voiceschanged', refreshVoices);
}

function seatHash(seat) {
  let h = 0;
  for (const c of seat) h = (h * 31 + c.charCodeAt(0)) % 100000;
  return h;
}

/** A distinct system voice per seat — the fallback's answer to "all the same". */
function seatVoice(seat) {
  if (!systemVoices.length) refreshVoices();
  if (!systemVoices.length) return null;
  return systemVoices[seatHash(seat) % systemVoices.length];
}

function browserSay(seat, text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) { resolve(); return; }
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true; current = null;
      if (timer) clearTimeout(timer);
      resolve();
    };
    const u = new SpeechSynthesisUtterance(text);
    const v = seatVoice(seat);
    if (v) u.voice = v;
    // Pitch and rate still vary, so seats sharing a system voice stay apart.
    const h = seatHash(seat);
    u.pitch = 0.75 + (h % 60) / 100;
    u.rate = 0.95 + (h % 25) / 100;
    u.onend = u.onerror = finish;
    current = { stop() { try { speechSynthesis.cancel(); } catch (e) { /* noop */ } finish(); } };
    // With no audio device onend never fires, which would stall a roll call
    // forever. Cap the wait at a generous estimate of the utterance length.
    timer = setTimeout(finish, Math.min(15000, 1200 + text.length * 70));
    speechSynthesis.speak(u);
  });
}

/**
 * Speak one line as one seat.
 * Returns 'elevenlabs' | 'browser' | 'cancelled' | 'empty' so the caller can
 * tell a finished line from an interrupted one.
 */
export async function say(seat, text) {
  if (!text) return 'empty';
  const gen = generation;
  try {
    const r = await fetch(`/api/say?seat=${encodeURIComponent(seat)}&text=${encodeURIComponent(text)}`);
    if (generation !== gen) return 'cancelled';       // cut off while fetching
    if (r.status === 200) {
      const url = URL.createObjectURL(await r.blob());
      if (generation !== gen) { URL.revokeObjectURL(url); return 'cancelled'; }
      await playUrl(url);
      URL.revokeObjectURL(url);
      return generation !== gen ? 'cancelled' : 'elevenlabs';
    }
  } catch (e) { /* fall through to the browser voice */ }
  if (generation !== gen) return 'cancelled';
  await browserSay(seat, text);
  return generation !== gen ? 'cancelled' : 'browser';
}

/** Cut the desk off now. Any in-flight say() resolves as 'cancelled'. */
export function stopSpeaking() {
  generation += 1;
  if (current) current.stop();
  if (window.speechSynthesis) speechSynthesis.cancel();
}

/**
 * @param onCommand  (lowercased, raw) — a command heard while the desk is idle
 * @param onInterrupt (lowercased, raw) — a barge-in heard while the desk talks
 */
export function createEars({ onCommand, onInterrupt, onHeard, onState }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = false;
  rec.lang = 'en-US';

  let want = false;       // the operator wants the mic on

  rec.onresult = (e) => {
    const raw = e.results[e.results.length - 1][0].transcript.trim();
    const said = raw.toLowerCase();
    if (!said) return;
    if (onHeard) onHeard(raw);
    // While the desk is talking the speakers feed the mic, so only a short
    // explicit interrupt counts. Anything longer is almost certainly the desk
    // hearing itself, and is dropped.
    if (isSpeaking()) {
      if (INTERRUPT.test(said) && said.split(/\s+/).length <= 6) {
        if (onInterrupt) onInterrupt(said, raw);
      }
      return;
    }
    if (onCommand) onCommand(said, raw);
  };
  rec.onerror = (e) => { if (e.error === 'not-allowed' && onState) onState('denied'); };
  rec.onend = () => { if (want) { try { rec.start(); } catch (err) { /* already starting */ } } };

  return {
    start() {
      want = true;
      try { rec.start(); } catch (e) { /* already running */ }
      if (onState) onState('listening');
    },
    stop() {
      want = false;
      try { rec.stop(); } catch (e) { /* not running */ }
      if (onState) onState('off');
    },
    get listening() { return want; },
  };
}
