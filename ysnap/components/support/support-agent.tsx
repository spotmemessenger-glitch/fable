"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { cn } from "@/lib/cn";
import { ASSISTANT_OPEN_EVENT } from "@/lib/audio-bus";

/**
 * SupportAgent — the YSNAP Assistant.
 *
 * Idle state is a lightweight "Help" pill: no three.js, no model, nothing
 * heavy. Only when a visitor opens the chat does the 3D avatar mount and the
 * ~6.7 MB model download — so the page itself never pays for it. Once opened
 * the avatar stays mounted for the session, so re-opening is instant.
 *
 * Brain: Anthropic (/api/agent) · Voice: ElevenLabs (/api/tts) ·
 * Speech input: Deepgram (/api/stt). All keys live server-side; the static
 * Hostinger mirror calls the Vercel API via NEXT_PUBLIC_AGENT_API.
 */

const AgentAvatar = dynamic(() => import("./agent-avatar"), { ssr: false });

const API = process.env.NEXT_PUBLIC_AGENT_API ?? "";

type Msg = { role: "user" | "assistant"; content: string };

const GREETING: Msg = {
  role: "assistant",
  content: "Welcome to YSNAP. How may I assist you?",
};

/**
 * Miniature stand-in for the full 3D avatar (which mounts a ~600 KB three.js
 * chunk + a 6.7 MB model — deliberately deferred to when the chat opens).
 * Pure CSS/SVG so the idle "Help" pill costs nothing extra to paint; it
 * reuses the same pulse-ring keyframe as the eyebrow dot elsewhere on the
 * site so it reads as "alive" without any JS driving it.
 */
function MiniAvatar() {
  return (
    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center" aria-hidden>
      <span className="animate-pulse-ring absolute inset-0 rounded-full bg-[#ffd84d]/60" />
      <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-[linear-gradient(150deg,#ffe07a,#ffbe2e)] shadow-[inset_0_1px_1px_rgb(255_255_255_/_0.6)]">
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" aria-hidden>
          <circle cx="8.5" cy="10.5" r="1.4" fill="#4a3800" />
          <circle cx="15.5" cy="10.5" r="1.4" fill="#4a3800" />
          <path d="M8 15c1.2 1.1 2.6 1.6 4 1.6s2.8-.5 4-1.6" stroke="#4a3800" strokeWidth={1.8} strokeLinecap="round" />
        </svg>
      </span>
    </span>
  );
}

export default function SupportAgent() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const voiceOnRef = useRef(true);
  voiceOnRef.current = voiceOn;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, busy]);

  /* silence him when the panel closes */
  useEffect(() => {
    if (open) return;
    try {
      srcRef.current?.stop();
    } catch {}
    window.__ysnapAgentSpeaking = false;
    window.__ysnapAgentLevel = 0;
  }, [open]);

  const speak = async (text: string) => {
    if (!voiceOnRef.current) return;
    try {
      const res = await fetch(`${API}/api/tts/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return;
      const buf = await res.arrayBuffer();
      if (!voiceOnRef.current) return;
      const ctx = (audioCtxRef.current ??= new AudioContext());
      if (ctx.state === "suspended") await ctx.resume();
      const audio = await ctx.decodeAudioData(buf);
      try {
        srcRef.current?.stop();
      } catch {}
      const src = ctx.createBufferSource();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.buffer = audio;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      srcRef.current = src;
      window.__ysnapAgentSpeaking = true;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const pump = () => {
        if (!window.__ysnapAgentSpeaking) return;
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        window.__ysnapAgentLevel = sum / data.length / 160;
        requestAnimationFrame(pump);
      };
      src.onended = () => {
        window.__ysnapAgentSpeaking = false;
        window.__ysnapAgentLevel = 0;
      };
      src.start();
      pump();
    } catch {
      /* voice is a bonus — the text reply is already on screen */
    }
  };

  /**
   * Opening the panel greets the visitor out loud.
   *
   * The AudioContext is created and resumed HERE, synchronously, rather than
   * inside speak() — speak() awaits a network round-trip first, and by the
   * time that resolves the browser no longer counts us as being inside a user
   * gesture, so Safari and iOS refuse to start audio. Unlocking it during the
   * click itself is what makes the greeting actually audible.
   */
  const openPanel = () => {
    setOpen(true);
    /* Tell the hero dancer to stop its track — the assistant is about to
       speak, and the two must not talk over each other. */
    window.dispatchEvent(new Event(ASSISTANT_OPEN_EVENT));
    try {
      const ctx = (audioCtxRef.current ??= new AudioContext());
      if (ctx.state === "suspended") void ctx.resume();
    } catch {
      /* no Web Audio support — the text greeting is already on screen */
    }
    /* Only greet a fresh conversation. Re-opening mid-chat shouldn't replay
       "Welcome to YSNAP" over a discussion already in progress. */
    if (msgs.length === 1) void speak(GREETING.content);
  };

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || busy) return;
    setInput("");
    const next: Msg[] = [...msgs, { role: "user", content: text }];
    setMsgs(next);
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/agent/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next.slice(1) }), // greeting stays local
      });
      const data = res.ok ? ((await res.json()) as { text?: string }) : null;
      const reply =
        data?.text?.trim() ||
        "I couldn't reach my brain just then. Try me again in a moment.";
      setMsgs((m) => [...m, { role: "assistant", content: reply }]);
      void speak(reply);
    } catch {
      setMsgs((m) => [
        ...m,
        { role: "assistant", content: "Network hiccup — try that again." },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const toggleMic = async () => {
    if (recording) {
      recRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = async () => {
        setRecording(false);
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: mime });
        if (blob.size < 1500) return; // nothing meaningful captured
        setBusy(true);
        try {
          const res = await fetch(`${API}/api/stt/`, {
            method: "POST",
            headers: { "content-type": mime },
            body: blob,
          });
          const data = res.ok ? ((await res.json()) as { transcript?: string }) : null;
          setBusy(false);
          const heard = data?.transcript?.trim();
          if (heard) void send(heard);
          else
            setMsgs((m) => [
              ...m,
              { role: "assistant", content: "I didn't catch that — try again?" },
            ]);
        } catch {
          setBusy(false);
        }
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
      window.setTimeout(() => {
        if (rec.state === "recording") rec.stop();
      }, 15000); // hard cap
    } catch {
      setMsgs((m) => [
        ...m,
        { role: "assistant", content: "Microphone access was blocked — you can type instead." },
      ]);
    }
  };

  return (
    <>
      {/* ---------------------------------------------- chat panel (above him) */}
      {open ? (
        <div
          role="dialog"
          aria-label="YSNAP assistant"
          /* width set explicitly rather than via left+right insets — pairing
             both insets with sm:w-[370px] let the insets win and stretched
             the panel across the viewport */
          className="fixed bottom-4 right-4 z-[91] flex max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] flex-col overflow-hidden rounded-panel border border-hairline bg-surface shadow-lift sm:max-h-[min(600px,calc(100dvh-40px))] sm:w-[370px]"
        >
          <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2" aria-hidden>
                <span className="absolute inset-0 animate-ping rounded-full bg-green/60" />
                <span className="relative h-2 w-2 rounded-full bg-green" />
              </span>
              <p className="text-sm font-semibold text-ink">YSNAP Assistant</p>
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                AI
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setVoiceOn((v) => !v)}
                aria-pressed={voiceOn}
                aria-label={voiceOn ? "Mute the assistant" : "Unmute the assistant"}
                className="cursor-pointer rounded-full border border-hairline px-2 py-1 text-[11px] font-medium text-ink-soft hover:border-[#dcdcdc]"
              >
                {voiceOn ? "🔊" : "🔇"}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close the assistant"
                className="grid h-7 w-7 cursor-pointer place-items-center rounded-full text-ink-soft hover:bg-sunken"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          </div>

          {/* avatar — mounts (and downloads) only now that the chat is open.
              Hidden on very short viewports so the transcript keeps its room. */}
          <AgentAvatar className="block h-[132px] w-full shrink-0 bg-[radial-gradient(120%_120%_at_50%_0%,#eef3fb_0%,#dde7f5_100%)] min-[520px]:h-[150px]" />

          <div ref={listRef} className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3" aria-live="polite">
            {msgs.map((m, i) => (
              <div
                key={i}
                className={cn(
                  "max-w-[85%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed",
                  m.role === "user"
                    ? "ml-auto rounded-br-md bg-ink text-white"
                    : "rounded-bl-md bg-sunken text-ink",
                )}
              >
                {m.content}
              </div>
            ))}
            {busy ? (
              <div className="flex w-14 items-center gap-1 rounded-2xl rounded-bl-md bg-sunken px-3.5 py-2.5" aria-label="Assistant is thinking">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink/40"
                    style={{ animationDelay: `${i * 0.15}s` }}
                  />
                ))}
              </div>
            ) : null}
          </div>

          <form
            className="flex items-center gap-2 border-t border-hairline p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={recording ? "Listening…" : "Ask about YSNAP…"}
              aria-label="Message the YSNAP Assistant"
              className="h-10 min-w-0 flex-1 rounded-full border border-hairline bg-sunken px-4 text-[13px] text-ink outline-none placeholder:text-faint focus:border-accent"
            />
            <button
              type="button"
              onClick={() => void toggleMic()}
              aria-pressed={recording}
              aria-label={recording ? "Stop recording" : "Speak your question"}
              className={cn(
                "grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-full border transition-colors",
                recording
                  ? "animate-pulse border-coral bg-coral/10 text-coral"
                  : "border-hairline bg-surface text-ink-soft hover:border-[#dcdcdc]",
              )}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
                <line x1="12" y1="18" x2="12" y2="21" />
              </svg>
            </button>
            <button
              type="submit"
              disabled={busy || !input.trim()}
              aria-label="Send"
              className="grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-full bg-ink text-white transition-opacity disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 12h13M13 6l6 6-6 6" />
              </svg>
            </button>
          </form>
        </div>
      ) : null}

      {/* ------------------------------------------------ Help launcher.
          A miniature stand-in avatar (CSS, not the 3D model) with a small
          floating text bubble beside it — deliberately weightless: no
          three.js, no model download until someone actually opens the chat,
          where he "enlarges" into the real animated avatar. */}
      {!open ? (
        <div className="fixed bottom-5 right-4 z-[90] flex items-center gap-2.5">
          <button
            type="button"
            onClick={openPanel}
            aria-label="Open the YSNAP assistant"
            className="flex cursor-pointer items-center gap-2 rounded-full bg-[linear-gradient(135deg,#4c7dff,#6e6ef7)] py-1.5 pl-1.5 pr-4 text-white shadow-lift transition-transform duration-200 hover:-translate-y-0.5"
          >
            <MiniAvatar />
            <span className="text-[13px] font-semibold">Help</span>
          </button>
        </div>
      ) : null}
    </>
  );
}
