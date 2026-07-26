"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { cn } from "@/lib/cn";
import { ASSISTANT_OPEN_EVENT } from "@/lib/audio-bus";

/**
 * HeroDancer — the looping dance model plus its own music toggle.
 *
 * Loading discipline, because the two assets together are ~11.7 MB:
 *  - the model (5.8 MB) mounts only once the browser goes idle, so the hero's
 *    headline and CTAs paint first and LCP is unaffected;
 *  - the track (5.9 MB) is `preload="none"` and is not fetched at all until
 *    someone actually unmutes. Muted is the default, so the common case
 *    downloads zero bytes of audio.
 *
 * Until the model arrives a soft orb holds the space, so nothing reflows in
 * when it lands.
 */

const DancerModel = dynamic(() => import("./dancer-model"), { ssr: false });

export default function HeroDancer({ className }: { className?: string }) {
  const [mounted, setMounted] = useState(false);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  /* Defer the model until the browser is idle. rIC keeps it off the critical
     path; the timeout is the Safari fallback, which has no rIC. */
  useEffect(() => {
    let idle = 0;
    let timer = 0;
    const go = () => setMounted(true);
    if (typeof window.requestIdleCallback === "function") {
      idle = window.requestIdleCallback(go, { timeout: 2500 });
    } else {
      timer = window.setTimeout(go, 1200);
    }
    return () => {
      if (idle && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  /* The assistant and the music must never talk over each other: opening the
     chat ducks the track. It stays off afterwards rather than resuming on its
     own — audio restarting unprompted is worse than a second click. */
  useEffect(() => {
    const duck = () => {
      audioRef.current?.pause();
      setPlaying(false);
    };
    window.addEventListener(ASSISTANT_OPEN_EVENT, duck);
    return () => window.removeEventListener(ASSISTANT_OPEN_EVENT, duck);
  }, []);

  /* Pause when the tab is hidden — background music from an unfocused tab is
     the single most annoying thing a page can do. */
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) audioRef.current?.pause();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      a.muted = false;
      a.volume = 0.55;
      /* play() inside the click is what satisfies the autoplay policy, and
         it is also what triggers the first byte of the track to download */
      void a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      a.pause();
      setPlaying(false);
    }
  };

  return (
    <div className={cn("relative", className)}>
      {/* placeholder orb — holds the exact footprint so the model fades in
          without shifting anything around it */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity duration-700",
          ready ? "opacity-0" : "opacity-100",
        )}
        style={{
          background:
            "radial-gradient(circle at 34% 30%, #ffffff 0%, #8ee9d8 38%, #17a794 72%, #0d7d70 100%)",
          boxShadow: "0 18px 40px rgb(13 125 112 / 0.28), inset 0 -6px 14px rgb(6 60 54 / 0.35)",
        }}
      />

      <div
        className={cn(
          "h-full w-full transition-opacity duration-700",
          ready ? "opacity-100" : "opacity-0",
        )}
      >
        {mounted ? <DancerModel className="h-full w-full" onReady={() => setReady(true)} /> : null}
      </div>

      {/* Track. preload="none" so the 5.9 MB never downloads for the muted
          default; loop gives the repeat mode. */}
      <audio ref={audioRef} src="/audio/rumba-step-pop.mp3" loop preload="none" muted />

      <button
        type="button"
        onClick={toggle}
        aria-pressed={playing}
        aria-label={playing ? "Mute the music" : "Play the music"}
        title={playing ? "Mute the music" : "Play the music"}
        className="glass absolute bottom-1 left-1/2 grid h-11 w-11 -translate-x-1/2 cursor-pointer place-items-center rounded-full text-ink-soft shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {playing ? (
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M11 5 6 9H3v6h3l5 4V5Z" />
            <path d="M15.5 8.5a5 5 0 0 1 0 7" />
            <path d="M18.5 5.5a9 9 0 0 1 0 13" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M11 5 6 9H3v6h3l5 4V5Z" />
            <path d="m16 9 5 6M21 9l-5 6" />
          </svg>
        )}
      </button>
    </div>
  );
}
