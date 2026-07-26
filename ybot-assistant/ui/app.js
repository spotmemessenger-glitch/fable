// Ybot Assistant — text + voice (auto-listen VAD), window controls, permission modes, attachments.

// Apply saved theme immediately (before paint) to avoid a flash of the wrong theme.
(function () {
  try {
    document.documentElement.setAttribute("data-theme", localStorage.getItem("ybotTheme") || "dark");
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();

let ttsPlaying = false;

window.ybot = {
  on(kind, text) {
    const log = document.getElementById("log");
    const line = document.createElement("div");
    line.className = "line " + kind;
    const mark = kind === "done" ? "✓ " : kind === "error" ? "✗ " : kind === "you" ? "" : "· ";
    const msg = document.createElement("span");
    msg.className = "msg";
    msg.textContent = mark + text;
    const copy = document.createElement("button");
    copy.className = "copy";
    copy.title = "Copy this message";
    copy.textContent = "⧉";
    copy.addEventListener("click", (e) => {
      e.stopPropagation();
      copyText(text, copy);
    });
    line.appendChild(msg);
    line.appendChild(copy);
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    if (kind === "done" || kind === "error") {
      setBusy(false);
      resumeMicIfNeeded(); // bring auto-listen back after the task ends
      resumeWakeIfNeeded(); // and re-arm the "hey bot" wake word
    }
    if (kind === "done") speak(text);
  },
  askApproval(reason) {
    document.getElementById("approval-reason").textContent = reason;
    document.getElementById("approval").classList.remove("hidden");
  },
  say(text) {
    this.on("status", text); // show in the log…
    speak(text); // …and say it out loud
  },
};

async function copyText(text, btn) {
  let ok = false;
  try {
    if (window.pywebview) ok = await window.pywebview.api.copy_text(text);
  } catch (e) {}
  if (!ok) {
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {}
  }
  if (btn) {
    const prev = btn.textContent;
    btn.textContent = ok ? "✓" : "✗";
    setTimeout(() => (btn.textContent = prev), 1000);
  }
}

function resolveApproval(allow) {
  document.getElementById("approval").classList.add("hidden");
  if (window.pywebview) window.pywebview.api.resolve_approval(allow);
}
function currentMode() {
  const m = document.getElementById("mode");
  return m ? m.value : "bypass";
}
function currentSpeed() {
  const s = document.getElementById("speed");
  return s ? s.value : "fast";
}
function setState(s) {
  document.getElementById("state").textContent = s;
}
function isBusy() {
  return document.getElementById("send").disabled;
}

function setBusy(b) {
  document.getElementById("send").disabled = b;
  document.getElementById("input").disabled = b;
  const stop = document.getElementById("stop");
  if (stop) stop.classList.toggle("hidden", !b); // stop button only while a task runs
  setState(b ? "working…" : listening ? "listening…" : "ready");
  if (window.ybotAvatar) window.ybotAvatar.setSpeaking(b);
  if (!b) document.getElementById("input").focus();
}

async function stopTask() {
  if (!window.pywebview) return;
  try {
    await window.pywebview.api.stop();
  } catch (e) {}
}

async function refreshApp() {
  // Genuine refresh: hard-reset the Python side (abort + clear busy) so a wedged
  // task can never leave the UI stuck on "busy", then reload the page.
  try {
    if (window.pywebview) await window.pywebview.api.reset();
  } catch (e) {}
  window.location.reload();
}

let micWasListening = false; // remember mic state across a task so we can resume it

// While a task runs, fully stop the mic (prevents it capturing anything, or its loop
// freezing when the window minimises). resumeMicIfNeeded() turns it back on when done.
function pauseMicForTask() {
  if (listening) {
    micWasListening = true;
    listening = false;
    document.getElementById("mic").classList.remove("listening");
    stopMic();
  }
}
function resumeMicIfNeeded() {
  if (micWasListening && !listening) {
    micWasListening = false;
    setTimeout(() => { if (!listening && !isBusy()) toggleAuto(); }, 1200);
  }
}

async function send() {
  const el = document.getElementById("input");
  const text = el.value.trim();
  if (!text) return;
  window.ybot.on("you", text);
  el.value = "";
  el.style.height = "auto"; // collapse the grown textarea back to one line
  pauseMicForTask();
  setBusy(true);
  try {
    const r = await window.pywebview.api.command(text, currentMode(), currentSpeed());
    if (r === "busy") {
      window.ybot.on("status", "still finishing the previous task…");
      setBusy(false);
    }
  } catch (e) {
    window.ybot.on("error", String(e));
  }
}

// --- voice output (ElevenLabs TTS) — pausable/resumable, with a mute toggle ---
let currentAudio = null; // the clip currently playing/paused
let muted = false;       // when true, Ybot won't speak

function playB64(b64) {
  if (muted) return;
  if (currentAudio) {
    try { currentAudio.pause(); } catch (e) {}
    currentAudio = null;
  }
  const a = new Audio("data:audio/mpeg;base64," + b64);
  currentAudio = a;
  a.addEventListener("play", () => {
    ttsPlaying = true;
    if (window.ybotAvatar) window.ybotAvatar.setSpeaking(true);
    updateVoiceBtn();
  });
  a.addEventListener("pause", updateVoiceBtn);
  const done = () => {
    ttsPlaying = false;
    if (currentAudio === a) currentAudio = null;
    if (window.ybotAvatar) window.ybotAvatar.setSpeaking(false);
    updateVoiceBtn();
  };
  a.addEventListener("ended", done);
  a.addEventListener("error", done);
  a.play().catch(done);
}
async function speak(text) {
  if (muted || !text || !window.pywebview) return;
  try {
    const b64 = await window.pywebview.api.tts(text);
    if (b64) playB64(b64);
  } catch (e) {
    /* voice optional */
  }
}

// Play/pause the current clip; when nothing is playing, toggle mute for future replies.
function toggleVoice() {
  if (currentAudio && !currentAudio.paused) {
    try { currentAudio.pause(); } catch (e) {}   // pause mid-sentence
    ttsPlaying = false;
    if (window.ybotAvatar) window.ybotAvatar.setSpeaking(false);
  } else if (currentAudio && currentAudio.paused) {
    currentAudio.play().catch(() => {});          // resume
  } else {
    muted = !muted;                               // idle -> mute/unmute
  }
  updateVoiceBtn();
}

function updateVoiceBtn() {
  const b = document.getElementById("voice");
  if (!b) return;
  if (currentAudio && !currentAudio.paused) {
    b.textContent = "⏸"; b.title = "Pause Ybot's voice";
  } else if (currentAudio && currentAudio.paused) {
    b.textContent = "▶"; b.title = "Resume Ybot's voice";
  } else if (muted) {
    b.textContent = "🔇"; b.title = "Voice muted — click to unmute";
  } else {
    b.textContent = "🔊"; b.title = "Voice on — click to mute";
  }
  b.classList.toggle("muted", muted);
}

// --- auto-listen mic (voice-activity detection) ---
let listening = false;
let micStream = null;
let audioCtx = null;
let analyser = null;
let rafId = null;
let recording = false;
let vadRec = null;
let vadChunks = [];
let speechStart = 0;
let silenceStart = 0;
const VAD_START = 0.03; // energy that counts as "you're speaking"
const VAD_STOP = 0.018; // below this counts as silence
const SILENCE_MS = 1800; // finalize a phrase only after this much trailing silence (forgiving of pauses)
const MIN_MS = 400; // ignore blips shorter than this (filters coughs/clicks)
const INTERIM_MS = 1300; // how often to update the live caption while you're speaking
let heardSpeech = false; // did the current continuous recording contain real speech?
let lastInterim = 0;
let interimBusy = false;

function showCaption(text) {
  const c = document.getElementById("caption");
  if (!c) return;
  if (text) {
    c.textContent = text;
    c.classList.remove("hidden");
  } else {
    c.textContent = "";
    c.classList.add("hidden");
  }
}

// Live transcription: transcribe the utterance-so-far and show it in the caption, so you
// see your words appear as you speak (not only after you pause).
async function interimTranscribe() {
  if (interimBusy || !vadChunks.length) return;
  interimBusy = true;
  try {
    const blob = new Blob(vadChunks.slice(), { type: "audio/webm" });
    const b64 = await blobToB64(blob);
    let t = "";
    try { t = await window.pywebview.api.stt(b64, "audio/webm"); } catch (e) {}
    t = (t || "").replace(/\[[^\]]*\]/g, "").trim();
    if (t && heardSpeech) showCaption(t + " …");
  } finally {
    interimBusy = false;
  }
}

function blobToB64(blob) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onloadend = () => res(String(r.result).split(",")[1]);
    r.readAsDataURL(blob);
  });
}

async function startListening() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    window.ybot.on("error", "mic unavailable: " + e);
    return false;
  }
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);

  // Record CONTINUOUSLY (timeslice keeps chunks flowing) so word onsets are never clipped;
  // the VAD only decides WHEN to finalize a phrase, it doesn't gate the recorder.
  startContinuousRec();

  const loop = () => {
    analyser.getByteTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      s += v * v;
    }
    const rms = Math.sqrt(s / buf.length);
    const now = performance.now();
    const blocked = isBusy() || ttsPlaying; // ignore audio while working or while Ybot is speaking

    if (blocked) {
      vadChunks.length = 0; // drop buffered audio so Ybot's own voice is never transcribed
      heardSpeech = false;
      silenceStart = 0;
    } else if (rms > VAD_START) {
      if (!heardSpeech) { speechStart = now; lastInterim = now; }
      heardSpeech = true;
      silenceStart = 0;
      // live caption: refresh every INTERIM_MS while you keep talking
      if (now - lastInterim > INTERIM_MS) {
        lastInterim = now;
        interimTranscribe();
      }
    } else if (heardSpeech) {
      if (!silenceStart) silenceStart = now;
      // finalize only after a good pause — brief mid-sentence pauses don't cut you off
      if (now - silenceStart > SILENCE_MS) {
        flushUtterance();
      }
    }
    rafId = requestAnimationFrame(loop);
  };
  loop();
  return true;
}

function startContinuousRec() {
  if (!micStream) return;
  vadChunks = [];
  heardSpeech = false;
  silenceStart = 0;
  try {
    vadRec = new MediaRecorder(micStream);
    vadRec.ondataavailable = (e) => e.data.size && vadChunks.push(e.data);
    vadRec.start(250); // emit a chunk every 250ms so the buffer is always current
  } catch (e) {
    window.ybot.on("error", "recorder failed: " + e);
  }
}

// Stop the current recording, transcribe it, and immediately start a fresh one.
function flushUtterance() {
  const rec = vadRec;
  const chunks = vadChunks;
  const spoke = heardSpeech && performance.now() - speechStart > MIN_MS;
  vadRec = null;
  heardSpeech = false;
  silenceStart = 0;
  if (rec) {
    rec.onstop = () => {
      if (spoke) onUtterance(chunks);
      if (listening) startContinuousRec(); // keep listening seamlessly
    };
    try { rec.stop(); } catch (e) { if (listening) startContinuousRec(); }
  }
}

async function onUtterance(chunks) {
  if (!chunks || !chunks.length) {
    setState(listening ? "listening…" : "ready");
    return;
  }
  setState("transcribing…");
  const blob = new Blob(chunks, { type: "audio/webm" });
  const b64 = await blobToB64(blob);
  let text = "";
  try {
    text = await window.pywebview.api.stt(b64, "audio/webm");
  } catch (e) {}
  let clean = (text || "").trim();
  // Drop non-speech annotations Gemini emits, e.g. "[background noise]", "[clicking]".
  clean = clean.replace(/\[[^\]]*\]/g, "").trim();
  showCaption(""); // hide the live caption; the final text goes into the box
  if (!clean) {
    setState(listening ? "listening…" : "ready");
    return;
  }
  // DICTATION: never auto-run. Put the words in the box and let the user review and press Go.
  // This prevents stray phrases/answers from launching tasks (and the surprise minimise).
  appendDictation(clean);
}

function stopListening() {
  showCaption("");
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  const rec = vadRec;
  vadRec = null;
  heardSpeech = false;
  if (rec) {
    rec.onstop = null; // don't restart or transcribe on manual stop
    try { if (rec.state === "recording") rec.stop(); } catch (e) {}
  }
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  micStream = null;
  audioCtx = null;
}

// grow the textarea to fit its content (up to the CSS max-height), then it scrolls
function autoGrow() {
  const el = document.getElementById("input");
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 220) + "px";
}
function appendDictation(text) {
  const el = document.getElementById("input");
  el.value = el.value ? el.value.trim() + " " + text : text;
  autoGrow();
  el.focus();
  setState("dictated — press Go (or keep speaking), then send");
}

// --- true live transcription via the browser's Web Speech API (words appear instantly) ---
let recognition = null;
let webSpeechFailed = false;

function startWebSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return false;
  try {
    recognition = new SR();
  } catch (e) {
    return false;
  }
  recognition.continuous = true;
  recognition.interimResults = true; // <-- the key: fires words as you speak
  recognition.lang = "en-US";
  recognition.onresult = (e) => {
    let interim = "", final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t + " ";
      else interim += t;
    }
    if (interim) showCaption(interim + " …");   // live, word-by-word
    if (final.trim()) { appendDictation(final.trim()); showCaption(""); }
  };
  recognition.onerror = (e) => {
    if (["not-allowed", "service-not-allowed", "network", "audio-capture"].includes(e.error)) {
      webSpeechFailed = true; // browser can't run it -> fall back to Gemini pipeline
    }
  };
  recognition.onend = () => {
    if (!listening) return;
    if (webSpeechFailed) { startListening(); return; }
    try { recognition.start(); } catch (e) {}  // continuous mode can stop; restart it
  };
  try {
    recognition.start();
    return true;
  } catch (e) {
    return false;
  }
}

function stopWebSpeech() {
  if (recognition) {
    recognition.onend = null;
    recognition.onresult = null;
    recognition.onerror = null;
    try { recognition.stop(); } catch (e) {}
    recognition = null;
  }
  showCaption("");
}

function stopMic() {
  stopWebSpeech();
  stopListening();
}

async function toggleAuto() {
  const btn = document.getElementById("mic");
  if (listening) {
    listening = false;
    btn.classList.remove("listening");
    stopMic();
    setState("ready");
    return;
  }
  if (wakeOn) setWake(false); // single mic — manual listen and wake word can't share it
  listening = true;
  btn.classList.add("listening");
  setState("listening…");
  webSpeechFailed = false;
  // Prefer real-time Web Speech; fall back to the VAD + Gemini pipeline if unavailable.
  if (!startWebSpeech()) {
    const ok = await startListening();
    if (!ok) {
      listening = false;
      btn.classList.remove("listening");
      setState("ready");
    }
  }
}

// --- Hey Bot wake word (hands-free) --------------------------------------
// A background Web Speech recognizer scans for "hey bot"; whatever you say after
// it is run as a command and Ybot speaks the answer — no mic click needed. This
// is the ONLY path allowed to auto-run: a stray phrase can never launch a task
// unless it's prefixed with the wake word.
let wakeOn = false;
let wakeRec = null;
let wakeCapturing = false;      // heard "hey bot", now waiting for the command
let wakeCaptureTimer = null;
let wakePausedForTask = false;  // recognizer intentionally stopped while a task runs
const WAKE_WORDS = ["hey bot", "hey ybot", "hey y bot", "hi bot", "ok bot", "okay bot", "hey boss"];

function updateWakeBtn() {
  const b = document.getElementById("wake");
  if (!b) return;
  b.classList.toggle("on", wakeOn);
  b.title = wakeOn
    ? "Hey Bot: ON — say “hey bot …” (click to turn off)"
    : "Hey Bot — hands-free wake word (say “hey bot”)";
}

function setWake(on) {
  if (on === wakeOn) return;
  if (on) {
    if (listening) { // single mic — stop manual auto-listen first
      listening = false;
      document.getElementById("mic").classList.remove("listening");
      stopMic();
    }
    wakeOn = true;
    wakePausedForTask = false;
    if (!startWakeRec()) return; // wakeUnavailable() already reset state + button
    updateWakeBtn();
    setState("say “hey bot …”");
    window.ybot.on("status", "Hey Bot is on — just say “hey bot” followed by your command.");
  } else {
    wakeOn = false;
    wakeCapturing = false;
    wakePausedForTask = false;
    clearTimeout(wakeCaptureTimer);
    stopWakeRec();
    showCaption("");
    updateWakeBtn();
    if (!isBusy()) setState(listening ? "listening…" : "ready");
  }
}
function toggleWake() { setWake(!wakeOn); }

function startWakeRec() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { wakeUnavailable("no speech API"); return false; }
  try { wakeRec = new SR(); } catch (e) { wakeUnavailable("init failed"); return false; }
  wakeRec.continuous = true;
  wakeRec.interimResults = true;
  wakeRec.lang = "en-US";
  wakeRec.onresult = onWakeResult;
  wakeRec.onerror = (e) => {
    if (["not-allowed", "service-not-allowed", "network", "audio-capture"].includes(e.error)) {
      wakeUnavailable(e.error);
    }
  };
  wakeRec.onend = () => {
    // keep listening as long as wake mode is on and we didn't stop for a task
    if (wakeOn && !wakePausedForTask && wakeRec) { try { wakeRec.start(); } catch (e) {} }
  };
  try { wakeRec.start(); return true; } catch (e) { wakeUnavailable("start failed"); return false; }
}

function stopWakeRec() {
  if (wakeRec) {
    wakeRec.onend = null;
    wakeRec.onresult = null;
    wakeRec.onerror = null;
    try { wakeRec.stop(); } catch (e) {}
    wakeRec = null;
  }
}

function wakeUnavailable(reason) {
  wakeOn = false;
  wakePausedForTask = false;
  stopWakeRec();
  updateWakeBtn();
  window.ybot.on(
    "status",
    "Hey Bot couldn’t start the speech service (" + reason + "). This embedded browser may not " +
      "support it — I can wire an offline wake word (Picovoice) instead."
  );
  if (!isBusy()) setState(listening ? "listening…" : "ready");
}

// A short two-tone blip so you know Ybot heard the wake word (no server round-trip,
// and it's a tone not words, so the recognizer won't mistake it for a command).
function wakeBeep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(660, ac.currentTime);
    o.frequency.setValueAtTime(880, ac.currentTime + 0.09);
    g.gain.setValueAtTime(0.05, ac.currentTime);
    o.connect(g);
    g.connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + 0.17);
    o.onended = () => { try { ac.close(); } catch (e) {} };
  } catch (e) {}
}

function onWakeResult(e) {
  if (isBusy() || ttsPlaying) return; // ignore while working, or while Ybot is speaking
  let interim = "", final = "";
  for (let i = e.resultIndex; i < e.results.length; i++) {
    const t = e.results[i][0].transcript;
    if (e.results[i].isFinal) final += t + " "; else interim += t;
  }
  if (interim) showCaption(interim + " …"); // live feedback as you speak

  if (wakeCapturing) {
    if (final.trim()) triggerWake(final.trim()); // the command spoken after "hey bot"
    return;
  }
  if (!final.trim()) return; // only match the wake word on a settled phrase
  const hay = final.toLowerCase();
  const hit = WAKE_WORDS.find((w) => hay.includes(w));
  if (!hit) { showCaption(""); return; }
  const after = final.slice(hay.lastIndexOf(hit) + hit.length).replace(/^[\s,.:!?-]+/, "").trim();
  if (after) {
    triggerWake(after); // "hey bot, what's the time" — wake + command in one breath
  } else {
    // just the wake word: acknowledge and capture the next utterance as the command
    wakeCapturing = true;
    wakeBeep();
    if (window.ybotAvatar) window.ybotAvatar.setSpeaking(true);
    setState("yes? — say your command");
    showCaption("Listening…");
    clearTimeout(wakeCaptureTimer);
    wakeCaptureTimer = setTimeout(() => {
      wakeCapturing = false;
      if (window.ybotAvatar) window.ybotAvatar.setSpeaking(false);
      showCaption("");
      if (!isBusy()) setState(wakeOn ? "say “hey bot …”" : "ready");
    }, 7000);
  }
}

function triggerWake(cmd) {
  wakeCapturing = false;
  clearTimeout(wakeCaptureTimer);
  cmd = (cmd || "").replace(/\[[^\]]*\]/g, "").trim(); // drop "[background noise]" etc.
  if (window.ybotAvatar) window.ybotAvatar.setSpeaking(false);
  showCaption("");
  if (!cmd) { if (!isBusy()) setState(wakeOn ? "say “hey bot …”" : "ready"); return; }
  pauseWakeForTask(); // stop the recognizer so it can't hear the spoken answer
  const el = document.getElementById("input");
  el.value = cmd;
  autoGrow();
  send(); // logs "you", runs the command, and speaks the reply on done
}

function pauseWakeForTask() {
  if (wakeOn && wakeRec) { wakePausedForTask = true; stopWakeRec(); }
}
function resumeWakeIfNeeded() {
  if (wakeOn && wakePausedForTask) {
    wakePausedForTask = false;
    setTimeout(() => { if (wakeOn && !wakeRec && !isBusy()) startWakeRec(); }, 1200);
  }
}

// --- plus menu + attachments ---
function togglePlus() {
  document.getElementById("plusmenu").classList.toggle("hidden");
}
function renderAttachments(paths) {
  const box = document.getElementById("attachments");
  box.innerHTML = "";
  (paths || []).forEach((p, i) => {
    const c = document.createElement("span");
    c.className = "chip";
    const name = document.createElement("span");
    name.textContent = "📎 " + p.split(/[\\/]/).pop();
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    x.title = "Remove";
    x.addEventListener("click", () => removeAttachment(i));
    c.appendChild(name);
    c.appendChild(x);
    box.appendChild(c);
  });
}

async function removeAttachment(index) {
  if (!window.pywebview) return;
  try {
    const paths = await window.pywebview.api.remove_attachment(index);
    renderAttachments(paths);
  } catch (e) {}
}
async function plusAction(act) {
  document.getElementById("plusmenu").classList.add("hidden");
  if (act === "files") {
    const paths = await window.pywebview.api.attach_files();
    renderAttachments(paths);
    if (paths && paths.length) window.ybot.on("status", paths.length + " file(s) attached");
  } else if (act === "connectors") {
    const info = await window.pywebview.api.connectors();
    window.ybot.on("status", info);
  }
}

// --- drag the frameless window by its titlebar ---
function setupDrag() {
  const bar = document.getElementById("titlebar");
  if (!bar) return;
  let drag = null;
  bar.addEventListener("pointerdown", async (e) => {
    if (e.button !== 0 || e.target.closest("button")) return; // don't drag on control clicks
    let pos = { x: 0, y: 0 };
    try {
      if (window.pywebview) pos = await window.pywebview.api.get_position();
    } catch (err) {}
    drag = { sx: e.screenX, sy: e.screenY, wx: pos.x, wy: pos.y };
    bar.setPointerCapture(e.pointerId); // keep receiving moves even off-element
    e.preventDefault();
  });
  bar.addEventListener("pointermove", (e) => {
    if (!drag || !window.pywebview) return;
    const nx = drag.wx + (e.screenX - drag.sx);
    const ny = drag.wy + (e.screenY - drag.sy);
    window.pywebview.api.move_to(nx, ny);
  });
  const end = (e) => {
    if (!drag) return;
    drag = null;
    try {
      bar.releasePointerCapture(e.pointerId);
    } catch (err) {}
  };
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", end);
}

// --- top menu, theme, models ---
function toggleMenu(force) {
  const m = document.getElementById("mainmenu");
  if (force === false) m.classList.add("hidden");
  else m.classList.toggle("hidden");
}
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("ybotTheme", theme); } catch (e) {}
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(cur === "dark" ? "light" : "dark");
}
function newChat() {
  document.getElementById("log").innerHTML = "";
  setState("ready");
}
function buildModelsMenu() {
  const sub = document.getElementById("modelsub");
  if (!sub || !window.ybotModels) return;
  sub.innerHTML = "";
  const { list, current } = window.ybotModels;
  Object.keys(list).forEach((key) => {
    const row = document.createElement("div");
    row.className = "mrow" + (key === current ? " active" : "");
    row.textContent = list[key].name;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (key !== current) {
        try { localStorage.setItem("ybotModel", key); } catch (err) {}
        window.location.reload(); // re-init the avatar with the chosen model
      } else {
        toggleMenu(false);
      }
    });
    sub.appendChild(row);
  });
}

// --- window controls ---
let onTop = true;
function togglePin() {
  onTop = !onTop;
  const b = document.getElementById("pin");
  b.classList.toggle("on", onTop);
  b.title = "Always on top: " + (onTop ? "ON" : "OFF");
  window.ybot.on("status", "pin clicked → requesting always-on-top " + (onTop ? "ON" : "OFF"));
  if (window.pywebview) window.pywebview.api.set_on_top(onTop);
}

window.addEventListener("pywebviewready", () => {
  setBusy(false);
  const g = document.getElementById("greeting");
  if (g) speak(g.textContent); // greet out loud
});

async function pasteFromClipboard() {
  const el = document.getElementById("input");
  if (!el || !window.pywebview) return;
  let text = "";
  try {
    text = await window.pywebview.api.paste_text();
  } catch (e) {}
  if (!text) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const pos = start + text.length;
  el.selectionStart = el.selectionEnd = pos;
  el.focus();
  autoGrow();
}

function setupContextMenu() {
  const input = document.getElementById("input");
  const ctx = document.getElementById("ctxmenu");
  if (!input || !ctx) return;
  input.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    ctx.classList.remove("hidden");
    const mw = ctx.offsetWidth || 140;
    const mh = ctx.offsetHeight || 120;
    ctx.style.left = Math.max(6, Math.min(e.clientX, window.innerWidth - mw - 6)) + "px";
    ctx.style.top = Math.max(6, Math.min(e.clientY, window.innerHeight - mh - 6)) + "px";
  });
  ctx.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const act = b.dataset.act;
      ctx.classList.add("hidden");
      if (act === "paste") {
        pasteFromClipboard();
      } else if (act === "copy") {
        const s = input.value.substring(input.selectionStart, input.selectionEnd);
        if (s && window.pywebview) window.pywebview.api.copy_text(s);
      } else if (act === "selectall") {
        input.focus();
        input.select();
      }
    })
  );
  document.addEventListener("click", () => ctx.classList.add("hidden"));
  window.addEventListener("blur", () => ctx.classList.add("hidden"));
}

document.addEventListener("DOMContentLoaded", () => {
  setupDrag();
  document.getElementById("send").addEventListener("click", send);
  document.getElementById("input").addEventListener("keydown", (e) => {
    // Ctrl+V / Cmd+V / Shift+Insert: WebView2's native paste is unreliable in this
    // frameless window, so route it through the Python bridge (pyperclip) instead.
    if (((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) ||
        (e.shiftKey && e.key === "Insert")) {
      e.preventDefault();
      pasteFromClipboard();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  document.getElementById("input").addEventListener("input", autoGrow);
  setupContextMenu();
  document.getElementById("mic").addEventListener("click", toggleAuto);
  document.getElementById("wake").addEventListener("click", toggleWake);
  document.getElementById("voice").addEventListener("click", toggleVoice);
  document.getElementById("plus").addEventListener("click", togglePlus);
  document.querySelectorAll("#plusmenu button").forEach((b) =>
    b.addEventListener("click", () => plusAction(b.dataset.act))
  );
  document.getElementById("close").addEventListener("click", () => {
    if (window.pywebview) window.pywebview.api.close();
  });
  document.getElementById("min").addEventListener("click", () => {
    if (window.pywebview) window.pywebview.api.minimize();
  });
  document.getElementById("pin").addEventListener("click", togglePin);
  document.getElementById("stop").addEventListener("click", stopTask);
  document.getElementById("refresh").addEventListener("click", refreshApp);
  document.getElementById("allow").addEventListener("click", () => resolveApproval(true));
  document.getElementById("deny").addEventListener("click", () => resolveApproval(false));

  // top menu
  buildModelsMenu();
  document.getElementById("menubtn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  document.getElementById("themetoggle").addEventListener("click", (e) => {
    e.stopPropagation(); // keep menu open so the change is visible
    toggleTheme();
  });
  document.querySelectorAll("#mainmenu .mrow[data-act]").forEach((r) => {
    r.addEventListener("click", () => {
      const act = r.dataset.act;
      toggleMenu(false);
      if (act === "new") newChat();
      else if (act === "refresh") refreshApp();
      else if (act === "exit") { if (window.pywebview) window.pywebview.api.close(); }
    });
  });
  // click outside closes the menu
  document.addEventListener("click", (e) => {
    const m = document.getElementById("mainmenu");
    if (!m.classList.contains("hidden") &&
        !e.target.closest("#mainmenu") && !e.target.closest("#menubtn")) {
      m.classList.add("hidden");
    }
  });
});
