/* J.A.R.V.I.S. HUD client.
   Talks to the Python bridge over WebSocket, drives the panels, handles voice
   input (Web Speech API) and audio-reactive output (Web Audio on TTS). */

(function () {
  "use strict";

  const WS_URL = "ws://localhost:8765";
  const $ = (id) => document.getElementById(id);

  let ws = null;
  let agents = [];
  let audioCtx = null;
  let analyser = null;
  let micAnalyser = null;
  let wantAudio = true;
  let speaking = false;
  let listeningMode = false;   // continuous "always-on" voice listening
  let suppressUntil = 0;       // ignore mic input until this timestamp (echo guard)
  const audioQueue = [];
  const now = () => (window.performance ? performance.now() : Date.now());

  // ------------------------------------------------------------ connection

  function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      setLink(true);
      status("ONLINE · AWAITING COMMAND");
      setReactorMode("idle");
    };
    ws.onclose = () => {
      setLink(false);
      status("LINK LOST · RECONNECTING…");
      setReactorMode("idle");
      setTimeout(connect, 2000);
    };
    ws.onerror = () => ws && ws.close();
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      route(msg);
    };
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function route(m) {
    switch (m.type) {
      case "hello": agents = m.agents; renderAgents(); break;
      case "vitals": updateVitals(m); break;
      case "crypto": renderCrypto(m.items); break;
      case "forex": renderForex(m.items); break;
      case "news": renderNews(m.items); break;
      case "memory": renderMemory(m); break;
      case "user_said": addMsg("you", m.text); break;
      case "say": handleSay(m); break;
      case "state": handleState(m.state); break;
      case "tool": handleTool(m); break;
      case "notice": addMsg("system", m.text); break;
      case "approval_request": showApproval(m); break;
      case "approval_resolved": hideApproval(); break;
    }
  }

  // --------------------------------------------------------------- panels

  function status(t) { $("status-line").textContent = t; }
  function setLink(on) {
    const el = $("link-state");
    el.textContent = on ? "LINK ▪ LIVE" : "LINK ▪ OFF";
    el.classList.toggle("on", on);
  }

  function updateVitals(v) {
    setBar("v-cpu", v.cpu); $("v-cpu-t").textContent = Math.round(v.cpu) + "%";
    setBar("v-ram", v.ram); $("v-ram-t").textContent = Math.round(v.ram) + "%";
    setBar("v-disk", v.disk); $("v-disk-t").textContent = Math.round(v.disk) + "%";
    $("v-up").textContent = v.net_sent_mb + " MB";
    $("v-down").textContent = v.net_recv_mb + " MB";
    $("v-uptime").textContent = v.uptime_h + " h";
    $("v-free").textContent = v.disk_free_gb + " GB";
    renderCores(v.cores || []);
  }

  function setBar(id, pct) {
    const el = $(id);
    el.style.width = Math.min(100, pct) + "%";
    el.classList.toggle("hot", pct > 80);
  }

  function renderCores(cores) {
    const wrap = $("cores");
    if (wrap.children.length !== cores.length) {
      wrap.innerHTML = "";
      cores.forEach(() => {
        const c = document.createElement("div");
        c.className = "core-cell";
        c.innerHTML = "<i></i>";
        wrap.appendChild(c);
      });
    }
    cores.forEach((v, i) => {
      const bar = wrap.children[i].firstChild;
      bar.style.height = v + "%";
    });
  }

  function renderAgents() {
    const list = $("agent-list");
    list.innerHTML = "";
    agents.forEach((a) => {
      const el = document.createElement("div");
      el.className = "agent " + (a.id === "ceo" ? "ready" : (a.tier === "on hold" ? "hold" : "ready"));
      el.id = "agent-" + a.id;
      el.innerHTML = `<span class="led"></span>
        <span><span class="nm">${a.name}</span><br><span class="rl">${a.role}</span></span>
        <span class="tier">${a.tier}</span>`;
      list.appendChild(el);
    });
  }

  let toolTimers = {};
  function handleTool(m) {
    const el = $("agent-" + m.agent);
    if (!el) return;
    if (m.phase === "start") {
      el.classList.remove("hold", "ready");
      el.classList.add("working");
    } else {
      el.classList.toggle("denied", !m.ok);
      clearTimeout(toolTimers[m.agent]);
      toolTimers[m.agent] = setTimeout(() => {
        el.classList.remove("working", "denied");
        el.classList.add(m.agent === "ceo" ? "ready" : "ready");
      }, 900);
    }
  }

  function renderCrypto(items) {
    $("crypto-dot").style.opacity = 1;
    $("crypto-rows").innerHTML = (items || []).map((c) => {
      const up = c.change_24h >= 0;
      const px = c.usd != null ? "$" + Number(c.usd).toLocaleString() : "—";
      return `<div class="mrow"><span class="sym">${c.symbol}</span>
        <span class="px">${px}</span>
        <span class="chg ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(c.change_24h)}%</span></div>`;
    }).join("");
  }

  function renderForex(items) {
    $("forex-rows").innerHTML = (items || []).map((f) =>
      `<div class="frow"><span>${f.pair}</span><b>${Number(f.rate).toFixed(2)}</b></div>`
    ).join("");
  }

  function renderNews(items) {
    $("news-list").innerHTML = (items || []).map((n) =>
      `<div class="nrow ${n.alert ? "alert" : ""}">${escapeHtml(n.title)}</div>`
    ).join("");
  }

  function renderMemory(m) {
    $("m-facts").textContent = m.stats.facts;
    $("m-turns").textContent = m.stats.episodes;
    $("m-list").innerHTML = (m.facts || []).map((f) =>
      `<div class="m-fact">${escapeHtml(f)}</div>`
    ).join("");
  }

  // ------------------------------------------------------------- console

  function addMsg(who, text) {
    const t = $("transcript");
    const el = document.createElement("div");
    el.className = "msg " + who;
    const label = who === "you" ? "YOU" : who === "jarvis" ? "J.A.R.V.I.S." : "";
    el.innerHTML = (label ? `<span class="who">${label}</span>` : "") + escapeHtml(text);
    t.appendChild(el);
    t.scrollTop = t.scrollHeight;
  }

  function handleState(s) {
    if (s === "idle" && listeningMode) {
      // Turn finished but we're still always-on listening.
      setReactorMode("listening");
      setReactorLevel(0);
      status("LISTENING · say a command any time");
      return;
    }
    setReactorMode(s);
    if (s === "thinking") status("PROCESSING…");
    else if (s === "speaking") status("RESPONDING");
    else if (s === "idle") { status("ONLINE · AWAITING COMMAND"); setReactorLevel(0); }
  }

  // --------------------------------------------------------- voice output

  function handleSay(m) {
    addMsg("jarvis", m.text);
    if (m.audio && wantAudio) {
      queueAudio(m.audio);
    } else if (wantAudio && "speechSynthesis" in window) {
      browserSpeak(m.text);
    }
  }

  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.connect(audioCtx.destination);
    }
  }

  function queueAudio(b64) {
    audioQueue.push(b64);
    if (!speaking) {
      // Pause the mic before we start speaking so recognition never hears
      // JARVIS's own voice and feeds it back as a command.
      pauseRecogForSpeech();
      playNext();
    }
  }

  function playNext() {
    if (!audioQueue.length) {
      speaking = false;
      window.audioSpectrum = null;
      // Ignore any trailing echo, then resume continuous listening.
      suppressUntil = now() + 900;
      resumeRecogAfterSpeech();
      return;
    }
    speaking = true;
    ensureAudio();
    const b64 = audioQueue.shift();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    audioCtx.decodeAudioData(bytes.buffer.slice(0), (buf) => {
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(analyser);
      src.onended = playNext;
      src.start();
      pumpSpectrum(analyser);
    }, () => playNext());
  }

  function browserSpeak(text) {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; u.pitch = 0.9;
    // Pause the mic during synthesized speech too, so it doesn't self-trigger.
    u.onstart = () => { speaking = true; pauseRecogForSpeech(); };
    u.onend = () => { speaking = false; suppressUntil = now() + 700; resumeRecogAfterSpeech(); };
    speechSynthesis.speak(u);
  }

  function pumpSpectrum(node) {
    const data = new Uint8Array(node.frequencyBinCount);
    function tick() {
      node.getByteFrequencyData(data);
      window.audioSpectrum = data;
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      setReactorLevel((sum / data.length) / 140);
      if (speaking || (micAnalyser && listeningMode)) requestAnimationFrame(tick);
      else { setReactorLevel(0); window.audioSpectrum = null; }
    }
    tick();
  }

  // ---------------------------------------------------------- voice input
  // Continuous ("always-on") listening. Once enabled it stays on: recognition
  // auto-restarts between utterances, survives the harmless no-speech/aborted
  // errors, and is paused only while JARVIS is speaking so it never hears
  // itself. The preference is remembered across reloads.

  let recog = null, micStream = null;
  let recogRunning = false;      // recognition object is actively running
  let pausedForSpeech = false;   // temporarily stopped because TTS is playing
  let lastSubmitted = "";        // dedupe identical back-to-back transcripts
  let lastSubmittedAt = 0;

  function initSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";

    r.onstart = () => { recogRunning = true; };

    r.onresult = (e) => {
      // Drop anything captured while speaking or in the post-speech echo window.
      if (speaking || now() < suppressUntil) return;
      let txt = "";
      for (let i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript;
      $("cmd").value = txt;
      const last = e.results[e.results.length - 1];
      if (last.isFinal) {
        const t = txt.trim();
        $("cmd").value = "";
        if (!t) return;
        if (t === lastSubmitted && now() - lastSubmittedAt < 4000) return; // echo/dupe
        lastSubmitted = t; lastSubmittedAt = now();
        submit(t);
      }
    };

    r.onend = () => {
      recogRunning = false;
      // Stay alive: restart unless the user turned listening off or we paused
      // for JARVIS's own speech (speech-end handler restarts in that case).
      if (listeningMode && !speaking && !pausedForSpeech) startRecog();
      else if (!listeningMode) $("mic-btn").classList.remove("listening");
    };

    r.onerror = (ev) => {
      recogRunning = false;
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        listeningMode = false;
        $("mic-btn").classList.remove("listening");
        status("MIC BLOCKED · click the mic to grant access");
      }
      // no-speech / aborted / network are transient; onend will restart us.
    };
    return r;
  }

  function startRecog() {
    if (!recog) recog = initSpeech();
    if (!recog || recogRunning || speaking) return;
    try { recog.start(); } catch (e) { /* already starting */ }
  }

  function pauseRecogForSpeech() {
    if (!recog || !recogRunning) return;
    pausedForSpeech = true;
    try { recog.stop(); } catch (e) { /* ignore */ }
  }

  function resumeRecogAfterSpeech() {
    pausedForSpeech = false;
    if (listeningMode) startRecog();
  }

  async function startMicViz() {
    if (micAnalyser) return;
    try {
      ensureAudio();
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const src = audioCtx.createMediaStreamSource(micStream);
      micAnalyser = audioCtx.createAnalyser();
      micAnalyser.fftSize = 256;
      src.connect(micAnalyser);
      pumpSpectrum(micAnalyser);
    } catch (e) { /* mic denied — visualizer just stays flat */ }
  }

  function enableListening() {
    if (!("SpeechRecognition" in window || "webkitSpeechRecognition" in window)) {
      status("VOICE INPUT UNSUPPORTED IN THIS BROWSER");
      return;
    }
    listeningMode = true;
    localStorage.setItem("jarvis_listen", "1");
    $("mic-btn").classList.add("listening");
    setReactorMode("listening");
    startMicViz();
    startRecog();
    status("LISTENING · say a command any time");
  }

  function disableListening() {
    listeningMode = false;
    localStorage.setItem("jarvis_listen", "0");
    $("mic-btn").classList.remove("listening");
    if (recog) { try { recog.stop(); } catch (e) { /* ignore */ } }
    status("MIC OFF");
  }

  function toggleMic() { listeningMode ? disableListening() : enableListening(); }

  // ----------------------------------------------------------- commands

  function submit(text) {
    text = (text || $("cmd").value).trim();
    if (!text) return;
    send({ type: "command", text: text, audio: wantAudio });
    $("cmd").value = "";
  }

  // ---------------------------------------------------------- approval

  let currentApproval = null;
  function showApproval(m) {
    currentApproval = m.id;
    $("ap-desc").textContent = m.description;
    $("approval").classList.remove("hidden");
    setReactorMode("thinking");
  }
  function hideApproval() {
    currentApproval = null;
    $("approval").classList.add("hidden");
  }
  function answerApproval(granted) {
    if (!currentApproval) return;
    send({ type: "approval_response", id: currentApproval, granted: granted });
    hideApproval();
  }

  // -------------------------------------------------------------- clock

  function tickClock() {
    const d = new Date();
    $("clock").textContent = d.toLocaleTimeString("en-GB");
    $("date").textContent = d.toLocaleDateString(undefined,
      { weekday: "long", day: "numeric", month: "long" }).toUpperCase();
  }

  // --------------------------------------------------------------- util

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // --------------------------------------------------------------- wire

  $("send-btn").onclick = () => submit();
  $("cmd").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  $("mic-btn").onclick = toggleMic;
  $("ap-allow").onclick = () => answerApproval(true);
  $("ap-deny").onclick = () => answerApproval(false);

  tickClock();
  setInterval(tickClock, 1000);
  connect();

  // If the user enabled always-on listening before, try to resume it on load.
  // Browsers may require a gesture to start recognition; if the auto-start is
  // refused, the mic button (already primed) enables it on the first click.
  if (localStorage.getItem("jarvis_listen") === "1") {
    window.addEventListener("load", () => { try { enableListening(); } catch (e) {} });
    // A gesture-gated fallback: the first click/keypress anywhere re-arms it.
    const rearm = () => {
      if (localStorage.getItem("jarvis_listen") === "1" && !listeningMode) enableListening();
      window.removeEventListener("pointerdown", rearm);
      window.removeEventListener("keydown", rearm);
    };
    window.addEventListener("pointerdown", rearm);
    window.addEventListener("keydown", rearm);
  }
})();
