/* J.A.R.V.I.S. HUD client.
   Talks to the Python bridge over WebSocket, drives the panels, handles voice
   input (Web Speech API) and audio-reactive output (Web Audio on TTS). */

(function () {
  "use strict";

  // Same origin as the page, /ws path — works unchanged locally and once
  // deployed to a cloud host (Railway/Fly), since it's no longer a hardcoded
  // port. wss:// automatically when the page itself is served over https.
  const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
  const $ = (id) => document.getElementById(id);

  // hud.js defines window.setReactorMode for the canvas bust. Wrapping it
  // here mirrors every mode change onto body[data-state] so CSS can quicken
  // the ambient animation on every panel (vitals, agents, console, markets)
  // to match what JARVIS is doing, not just the reactor itself — one wrap
  // covers every call site (state messages, wake acks, approvals, recording)
  // without touching hud.js or duplicating the mode logic.
  const _setReactorModeCore = window.setReactorMode;
  window.setReactorMode = function (mode) {
    document.body.dataset.state = mode;
    if (_setReactorModeCore) _setReactorModeCore(mode);
  };

  // If no real jarvis.server is reachable behind this page (e.g. the
  // static-only Vercel preview), fall back to a self-contained PREVIEW: the
  // visuals animate, market data is fetched client-side (real), and
  // vitals/agents are simulated. Decided by probeThenStart() below via an
  // actual connection attempt, not by guessing from the hostname.
  const DEMO_AGENTS = [
    { id: "ceo", name: "J.A.R.V.I.S.", role: "Chief · orchestrator", tier: "fable-5" },
    { id: "research", name: "SCHOLAR", role: "Web research", tier: "on hold" },
    { id: "coder", name: "FORGE", role: "Files & code", tier: "sonnet-5" },
    { id: "designer", name: "MUSE", role: "Design / UI", tier: "on hold" },
    { id: "video", name: "REEL", role: "Video pipeline", tier: "on hold" },
    { id: "market", name: "LEDGER", role: "Market intel", tier: "feeds live" },
    { id: "memory", name: "ARCHIVE", role: "Memory & audit", tier: "sqlite" },
    { id: "system", name: "CORE", role: "System & shell", tier: "gated" },
  ];

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
      case "hello":
        agents = m.agents; renderAgents();
        if (m.model) setActiveModel(m.model);
        send({ type: "list_models" });
        if (m.native) {
          // The PC is listening natively; the browser must NOT also listen or
          // every command runs twice. Stand down and go visual-only.
          window.__native = true;
          if (listeningMode) disableListening();
          setReactorMode("idle");
          status("VOICE: NATIVE · just say “Hey Jarvis”");
        }
        break;
      case "vitals": updateVitals(m); break;
      case "crypto": renderCrypto(m.items); break;
      case "forex": renderForex(m.items); break;
      case "news": renderNews(m.items); break;
      case "weather": renderWeather(m); break;
      case "memory": renderMemory(m); break;
      case "user_said": addMsg("you", m.text); break;
      case "say": handleSay(m); break;
      case "state": handleState(m.state); break;
      case "tool": handleTool(m); break;
      case "notice": addMsg("system", m.text); break;
      case "approval_request": showApproval(m); break;
      case "approval_resolved": hideApproval(); break;
      case "models": renderModels(m.models, m.active); break;
      case "model_set": onModelSet(m.active); break;
      case "model_error": addMsg("system", "Couldn't switch model: " + m.error); break;
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

  // --------------------------------------------------------- model picker
  // A live dropdown of every brain JARVIS can use: the Claude tiers plus every
  // Ollama model (local + cloud). Picking one tells the server to switch the
  // model for the next turn — Claude for full tool use, Ollama for free chat.

  let activeModel = null;

  function renderModels(models, active) {
    const sel = $("model-select");
    if (!sel) return;
    sel.disabled = false;
    sel.innerHTML = "";
    [
      ["anthropic", "CLAUDE · paid"],
      ["cerebras", "CEREBRAS · free"],
      ["ollama", "OLLAMA · free"],
    ].forEach(([prov, label]) => {
      const items = (models || []).filter((m) => m.provider === prov);
      if (!items.length) return;
      const og = document.createElement("optgroup");
      og.label = label;
      items.forEach((m) => {
        const o = document.createElement("option");
        o.value = m.provider + "|" + m.id;
        const tag = m.kind === "local" ? "  ·local" : m.kind === "cloud" ? "  ·cloud" : "";
        o.textContent = m.label + tag;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    if (active) setActiveModel(active);
  }

  function setActiveModel(active) {
    activeModel = active;
    const sel = $("model-select");
    if (sel && active) sel.value = active.provider + "|" + active.model;
  }

  function onModelSet(active) {
    setActiveModel(active);
    status("BRAIN → " + active.model.toUpperCase());
    addMsg("system", "Model switched to " + active.model + " (" + active.provider + ").");
  }

  function onModelPick() {
    const v = $("model-select").value;
    const i = v.indexOf("|");
    if (i < 0) return;
    const provider = v.slice(0, i), model = v.slice(i + 1);
    if (activeModel && activeModel.provider === provider && activeModel.model === model) return;
    send({ type: "set_model", provider: provider, model: model });
    status("SWITCHING BRAIN → " + model.toUpperCase());
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

  function renderWeather(m) {
    $("w-place").textContent = m.place || "—";
    $("w-temp").textContent = (m.temp_f != null ? Math.round(m.temp_f) : "—") + "°";
    $("w-cond").textContent = m.condition || "—";
    $("w-forecast").innerHTML = (m.forecast || []).map((d) => {
      const label = new Date(d.day).toLocaleDateString(undefined, { weekday: "short" }).toUpperCase();
      return `<div class="w-day">${label}<br><span class="w-hi">${d.hi}°</span>/<span class="w-lo">${d.lo}°</span></div>`;
    }).join("");
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
    if (s === "idle" && pendingRecord) {
      // The wake ack has finished playing — now capture the command for Scribe.
      pendingRecord = false;
      startCommandRecording();
      return;
    }
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
    // ElevenLabs only, deliberately — no fallback to any other voice engine.
    // A prior fallback to the browser's built-in speechSynthesis caused two
    // voices to play over each other (JARVIS's real voice + a generic system
    // voice). If ElevenLabs audio isn't present, the reply is shown as text
    // only rather than spoken in the wrong voice.
    if (m.audio && wantAudio) queueAudio(m.audio);
  }

  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.connect(audioCtx.destination);
    }
    // Autoplay policy can leave the context suspended until a gesture; try to
    // resume eagerly so JARVIS can speak without a click (works once the
    // browser trusts this origin, or when launched with autoplay allowed).
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
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
  let awaitUntil = 0;            // after "Hey Jarvis", accept a command until this time
  let pendingRecord = false;     // start the Scribe recorder once the ack finishes
  let recordingCommand = false;  // MediaRecorder is capturing the command

  // Wake word. Lenient on common mis-hears of "Jarvis". In always-on mode a
  // phrase is only acted on if it contains the wake word, OR it arrives inside
  // the short window opened by a bare "Hey Jarvis".
  const WAKE_RE = /\b(?:hey|hi|ok|okay)?\s*(?:jarvis|jervis|travis|charvis|jarvi|service)\b/i;
  const WAKE_WINDOW_MS = 9000;

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
      if (!last.isFinal) return;
      const t = txt.trim();
      $("cmd").value = "";
      if (!t) return;
      if (t === lastSubmitted && now() - lastSubmittedAt < 4000) return; // echo/dupe
      handleHeard(t);
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
        status("MIC BLOCKED · allow microphone access for this site, then click the mic");
        addMsg("system", "Microphone permission is blocked. Click the lock/mic icon in the address bar, allow the mic, then press the mic button again.");
      } else if (ev.error === "network") {
        // Web Speech needs the browser's cloud recognizer (Chrome/Edge).
        status("VOICE ERROR · speech service unreachable");
        addMsg("system", "Speech recognition service unreachable. Use Chrome or Edge, and check the internet connection.");
      } else if (ev.error === "audio-capture") {
        status("VOICE ERROR · no microphone found");
        addMsg("system", "No microphone detected. Plug one in or select the right input device in Windows sound settings.");
      }
      // no-speech / aborted are normal between phrases; onend restarts us.
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

  // Decide what to do with a heard phrase, applying the wake-word gate.
  let lastGateHintAt = 0;
  function handleHeard(t) {
    const hasWake = WAKE_RE.test(t);
    const inWindow = now() < awaitUntil;

    if (recordingCommand) return; // Scribe recorder owns this utterance

    if (hasWake) {
      const cmd = t.replace(WAKE_RE, " ").replace(/\s+/g, " ").trim().replace(/^[,.\-\s]+/, "");
      if (cmd) {
        awaitUntil = 0;
        dispatch(cmd);
      } else {
        // Bare "Hey Jarvis" — acknowledge, then record the command and send it
        // to Scribe for accurate transcription (the browser recognizer only
        // spots the wake word; it is not trusted with the command itself).
        awaitUntil = now() + WAKE_WINDOW_MS;
        pendingRecord = true;
        send({ type: "wake" });
        setReactorMode("listening");
        status("YES, BOSS? · listening for your command");
      }
      return;
    }
    if (inWindow) {
      awaitUntil = now() + WAKE_WINDOW_MS; // conversation continues
      dispatch(t);
      return;
    }
    // No wake word and not in a command window — ignored, but say so
    // occasionally, otherwise the gate feels like a broken mic.
    if (now() - lastGateHintAt > 20000) {
      lastGateHintAt = now();
      status(`heard “${t.slice(0, 40)}” · say “Hey Jarvis” first`);
    }
  }

  function dispatch(text) {
    lastSubmitted = text; lastSubmittedAt = now();
    submit(text);
  }

  // ------------------------------------------- Scribe command recorder
  // After the wake ack, record the owner's command from the mic and send the
  // AUDIO to the server, where ElevenLabs Scribe transcribes it accurately.
  // Ends on ~1.3s of silence after speech, or a 12s cap.

  async function startCommandRecording() {
    if (recordingCommand) return;
    try {
      ensureAudio();
      if (!micStream) {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      if (!micAnalyser) {
        const src = audioCtx.createMediaStreamSource(micStream);
        micAnalyser = audioCtx.createAnalyser();
        micAnalyser.fftSize = 256;
        src.connect(micAnalyser);
        pumpSpectrum(micAnalyser);
      }
    } catch (e) {
      status("MIC UNAVAILABLE FOR RECORDING");
      return;
    }

    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus" : "audio/webm";
    let rec;
    try { rec = new MediaRecorder(micStream, { mimeType: mime }); }
    catch (e) { try { rec = new MediaRecorder(micStream); } catch (e2) { return; } }

    recordingCommand = true;
    setReactorMode("listening");
    status("RECORDING · speak your command");
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    const data = new Uint8Array(micAnalyser.frequencyBinCount);
    let spokeAt = 0, silentSince = 0;
    const startedAt = now();
    const watcher = setInterval(() => {
      micAnalyser.getByteFrequencyData(data);
      let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i];
      const loud = (sum / data.length) > 14;
      const t = now();
      if (loud) { spokeAt = spokeAt || t; silentSince = 0; }
      else if (spokeAt && !silentSince) silentSince = t;
      const spokeAndPaused = spokeAt && silentSince && (t - silentSince > 1300);
      const neverSpoke = !spokeAt && (t - startedAt > 6000);
      const tooLong = t - startedAt > 12000;
      if (spokeAndPaused || neverSpoke || tooLong) {
        clearInterval(watcher);
        try { rec.stop(); } catch (e) { /* already stopped */ }
      }
    }, 100);

    rec.onstop = async () => {
      recordingCommand = false;
      status("PROCESSING…");
      const blob = new Blob(chunks, { type: mime });
      if (blob.size < 2000) { // nothing meaningful captured
        status("LISTENING · say a command any time");
        setReactorMode(listeningMode ? "listening" : "idle");
        return;
      }
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = ""; const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
      }
      send({ type: "audio_command", data: btoa(bin), mime });
    };
    rec.start();
  }

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

  // --------------------------------------------------------- equalizer bars

  const EQ_BARS = 24;
  function initEqualizer() {
    ["eq-left", "eq-right"].forEach((id) => {
      const wrap = $(id);
      for (let i = 0; i < EQ_BARS; i++) wrap.appendChild(document.createElement("i"));
    });
    requestAnimationFrame(tickEqualizer);
  }

  function tickEqualizer() {
    const spec = window.audioSpectrum;
    const bars = document.querySelectorAll("#eq-left i, #eq-right i");
    const t = now() / 1000;
    bars.forEach((bar, i) => {
      let h;
      if (spec) {
        h = 15 + (spec[Math.floor((i / EQ_BARS) * spec.length)] / 255) * 85;
      } else {
        h = 10 + Math.abs(Math.sin(t * 1.6 + i * 0.5)) * 22; // idle shimmer
      }
      bar.style.height = h + "%";
    });
    requestAnimationFrame(tickEqualizer);
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
  { const ms = $("model-select"); if (ms) ms.onchange = onModelPick; }
  $("ap-allow").onclick = () => answerApproval(true);
  $("ap-deny").onclick = () => answerApproval(false);

  // ------------------------------------------------------------ preview mode

  async function fetchJson(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }

  async function demoMarkets() {
    // Real market data, fetched straight from the browser (CORS-friendly APIs).
    try {
      const c = await fetchJson(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd,inr&include_24hr_change=true");
      renderCrypto([
        { symbol: "BTC", usd: c.bitcoin?.usd, inr: c.bitcoin?.inr, change_24h: +(c.bitcoin?.usd_24h_change || 0).toFixed(2) },
        { symbol: "ETH", usd: c.ethereum?.usd, inr: c.ethereum?.inr, change_24h: +(c.ethereum?.usd_24h_change || 0).toFixed(2) },
        { symbol: "SOL", usd: c.solana?.usd, inr: c.solana?.inr, change_24h: +(c.solana?.usd_24h_change || 0).toFixed(2) },
      ]);
    } catch (e) { /* leave crypto blank on failure */ }
    try {
      // open.er-api.com is CORS-friendly (frankfurter.app is not, in the browser).
      const f = await fetchJson("https://open.er-api.com/v6/latest/USD");
      const want = ["INR", "EUR", "GBP", "JPY"];
      renderForex(want.filter((k) => f.rates && f.rates[k] != null)
        .map((k) => ({ pair: `USD/${k}`, rate: f.rates[k] })));
    } catch (e) { /* leave forex blank */ }
  }

  function demoVitals() {
    // Smoothly wandering synthetic load so the panels look alive.
    let cpu = 12, ram = 34, disk = 41;
    const cores = Array.from({ length: 16 }, () => 10);
    const step = () => {
      cpu = Math.max(3, Math.min(96, cpu + (Math.sin(now() / 1400) * 6) + (Math.random() - 0.5) * 8));
      ram = Math.max(20, Math.min(88, ram + (Math.random() - 0.5) * 3));
      for (let i = 0; i < cores.length; i++) cores[i] = Math.max(2, Math.min(99, cores[i] + (Math.random() - 0.5) * 22));
      updateVitals({
        cpu, ram, disk, cores,
        net_sent_mb: (now() / 90000).toFixed(1), net_recv_mb: (now() / 12000).toFixed(1),
        uptime_h: (now() / 3600000 + 3).toFixed(1), disk_free_gb: 686.6,
      });
    };
    step();
    setInterval(step, 1500);
  }

  function startDemo() {
    document.body.classList.add("preview");
    agents = DEMO_AGENTS; renderAgents();
    { const ms = $("model-select"); if (ms) { ms.innerHTML = "<option>PREVIEW — models load on your PC</option>"; ms.disabled = true; } }
    status("PREVIEW · full assistant runs on your PC");
    const el = $("link-state"); el.textContent = "PREVIEW"; el.classList.add("on");
    setReactorMode("idle");
    renderMemory({ stats: { facts: 2, episodes: 0 }, facts: [
      "[preference] preferred name: Prefers to be called Yuvraj",
      "[project] Building a personal JARVIS voice assistant",
    ]});
    renderNews([
      { title: "Preview mode — connect on your machine for the live news wire.", alert: false },
      { title: "Voice, memory, and the AI brain run locally on your PC.", alert: false },
    ]);
    renderWeather({ place: "PREVIEW", temp_f: 72, condition: "Clear", forecast: [] });
    addMsg("system", "PREVIEW MODE — this is the live interface. Voice, memory and the AI brain run on your machine; open it there to talk to JARVIS.");
    demoVitals();
    demoMarkets();
    setInterval(demoMarkets, 60000);
    // A little life: idle → brief "thinking" pulse now and then.
    setInterval(() => {
      setReactorMode("thinking"); setReactorLevel(0.4);
      setTimeout(() => { setReactorMode("idle"); setReactorLevel(0); }, 1400);
    }, 12000);
    // Command box explains it's a preview instead of trying to reach a server.
    $("send-btn").onclick = () => addMsg("system", "Open JARVIS on your PC to send commands — the brain lives there.");
    $("cmd").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("send-btn").onclick(); } });
    $("mic-btn").onclick = () => addMsg("system", "Voice runs on your machine, alongside the assistant.");
  }

  tickClock();
  setInterval(tickClock, 1000);
  initEqualizer();

  // Decide preview-vs-full mode by actually trying the backend, not by
  // guessing from the hostname. A static-only deploy (no server behind the
  // page, e.g. the Vercel preview) fails this probe and falls back to demo
  // mode; a real deployment (localhost, or a cloud host actually running
  // jarvis.server) succeeds and gets full functionality — same code path
  // regardless of where the server happens to be hosted.
  probeThenStart();

  function probeThenStart() {
    let decided = false;
    let probe;
    try {
      probe = new WebSocket(WS_URL);
    } catch (e) {
      startDemo();
      return;
    }
    const giveUp = setTimeout(() => {
      if (decided) return;
      decided = true;
      try { probe.close(); } catch (e) {}
      startDemo();
    }, 3000);
    probe.onopen = () => {
      if (decided) return;
      decided = true;
      clearTimeout(giveUp);
      try { probe.close(); } catch (e) {} // connect() below opens the real one
      startFull();
    };
    probe.onerror = () => {
      if (decided) return;
      decided = true;
      clearTimeout(giveUp);
      startDemo();
    };
  }

  function startFull() {
  connect();

  // ALWAYS-ON BY DEFAULT: start listening the moment the page opens, no mic
  // click needed. (The mic button now only turns it OFF.) The browser requires
  // a one-time permission grant per machine; after that this starts silently.
  // If the browser refuses to start without a gesture, the first click or
  // keypress anywhere re-arms it automatically.
  if (localStorage.getItem("jarvis_listen") !== "0") {
    localStorage.setItem("jarvis_listen", "1");
    // Don't start browser listening if the PC is listening natively (set by the
    // server 'hello'). Delay gives that message time to arrive first.
    const boot = () => { if (window.__native) return; try { if (!listeningMode) enableListening(); } catch (e) {} };
    if (document.readyState === "complete") setTimeout(boot, 1000);
    else window.addEventListener("load", () => setTimeout(boot, 1000));
    const rearm = () => {
      if (localStorage.getItem("jarvis_listen") === "1" && !listeningMode) boot();
      window.removeEventListener("pointerdown", rearm);
      window.removeEventListener("keydown", rearm);
    };
    window.addEventListener("pointerdown", rearm);
    window.addEventListener("keydown", rearm);
  }
  }
})();
