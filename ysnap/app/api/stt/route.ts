import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, guard } from "@/lib/api-security";

/**
 * Deepgram speech-to-text proxy — the browser records a short clip
 * (MediaRecorder, webm/opus) and posts the raw audio here; Deepgram's
 * prerecorded API returns the transcript. Key stays server-side.
 */

export const runtime = "edge";

/** 15 calls/min per client — a real conversation doesn't record this fast. */
const LIMIT = 15;
const WINDOW_MS = 60_000;

const MAX_BYTES = 4 * 1024 * 1024; // ~4 MB ≈ well over a minute of opus

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

export async function POST(req: NextRequest) {
  const blocked = guard(req, "stt", LIMIT, WINDOW_MS);
  if (blocked) return blocked;
  const CORS = corsHeaders(req.headers.get("origin"));

  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    return NextResponse.json({ error: "stt not configured" }, { status: 503, headers: CORS });
  }
  const audio = await req.arrayBuffer();
  if (audio.byteLength === 0 || audio.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: "bad audio size" }, { status: 400, headers: CORS });
  }
  const res = await fetch(
    "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${key}`,
        "content-type": req.headers.get("content-type") ?? "audio/webm",
      },
      body: audio,
    },
  );
  if (!res.ok) {
    return NextResponse.json({ error: "stt unavailable" }, { status: 502, headers: CORS });
  }
  const data = (await res.json()) as {
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
  };
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  return NextResponse.json({ transcript }, { headers: CORS });
}
