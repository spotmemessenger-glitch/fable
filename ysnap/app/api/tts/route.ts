import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, guard } from "@/lib/api-security";

/**
 * ElevenLabs text-to-speech proxy — key stays server-side; returns MP3.
 * Text length is capped so a stray client can't burn character quota.
 */

export const runtime = "edge";

/** 20 calls/min per client — audio is the priciest thing this proxy holds. */
const LIMIT = 20;
const WINDOW_MS = 60_000;

/** Premade "Rachel" voice — present on every ElevenLabs account. Override
    with ELEVENLABS_VOICE_ID for a branded voice. */
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

export async function POST(req: NextRequest) {
  const blocked = guard(req, "tts", LIMIT, WINDOW_MS);
  if (blocked) return blocked;
  const CORS = corsHeaders(req.headers.get("origin"));

  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    return NextResponse.json({ error: "tts not configured" }, { status: 503, headers: CORS });
  }
  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400, headers: CORS });
  }
  const text = (body.text ?? "").trim().slice(0, 600);
  if (!text) {
    return NextResponse.json({ error: "no text" }, { status: 400, headers: CORS });
  }
  const voice = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": key },
      body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
    },
  );
  if (!res.ok) {
    return NextResponse.json({ error: "tts unavailable" }, { status: 502, headers: CORS });
  }
  return new NextResponse(res.body, {
    headers: { ...CORS, "content-type": "audio/mpeg", "cache-control": "no-store" },
  });
}
