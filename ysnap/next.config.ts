import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hybrid deployment:
  //  - Vercel (default): full Next.js with the /api/* routes that hold the
  //    support agent's server-side keys (Anthropic, ElevenLabs, Deepgram).
  //  - Hostinger (STATIC_EXPORT=1): plain HTML export to `out/` for shared
  //    hosting; the widget calls the Vercel-hosted API cross-origin instead.
  ...(process.env.STATIC_EXPORT === "1" ? { output: "export" as const } : {}),
  // The static export has no image-optimization server, so serve images as-is.
  images: { unoptimized: true },
  // Emit each route as a folder with index.html so paths resolve on plain
  // static hosting without server rewrites (e.g. /foo -> /foo/index.html).
  trailingSlash: true,
};

export default nextConfig;
