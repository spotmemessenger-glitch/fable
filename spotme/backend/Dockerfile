# The language pipeline lives in web/api/translate.js — tuned against a real
# Tanglish corpus and verified in the field, so it ships AS-IS rather than
# being rewritten. It sits outside this build context, which is why translation,
# TURN credentials and voice cloning all 404'd in production while every local
# test passed: the files were simply not in the image.
#
# `npm run deploy` stages them into ./deploy-api first. Deploying with a
# bare `railway up` skips that step, so the staging directory is asserted below
# and the BUILD fails loudly rather than shipping another silent 404.
#
# The staging directory MUST NOT be gitignored. It used to be `.deploy/`, which
# .gitignore excluded — and `railway up` skips gitignored paths, so the files
# never reached the build context and EVERY deploy failed on the assert below
# while Railway quietly kept serving the previous container. A `.railwayignore`
# does not help: it only adds exclusions, it does not override .gitignore.
# `deploy-api/` is untracked but not ignored, which is exactly what uploads.
FROM node:22-slim AS build
WORKDIR /app
# Prisma's engine links against libssl. node:22-slim (bookworm) ships OpenSSL 3
# but not what Prisma probes for, so detection falls back to "openssl-1.1.x"
# and the container dies at boot on libssl.so.1.1. Installing openssl here and
# pinning binaryTargets in schema.prisma are the two halves of the fix.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
# Fail here, not at runtime: a missing handler directory is invisible until a
# user's message fails to translate.
RUN test -f deploy-api/translate.js || \
  (echo "MISSING deploy-api — run 'npm run deploy', not 'railway up'" && exit 1)
RUN npx prisma generate
RUN npm run build

FROM node:22-slim
# M3: ffmpeg/ffprobe are the {moment-media} transcode worker. Without them the
# worker fails every job and a feed serves raw phone video (HEVC, trailing
# moov) that Android Chrome often cannot play at all.
#
# iPhone media (normalize.ts) makes both of these HARD runtime requirements of
# the UPLOAD path, not just of the background worker:
#
#   ffmpeg           — `.mov` → faststart MP4 with `-map_metadata -1`. This is
#                      what removes the QuickTime GPS atom, and it runs BEFORE
#                      the bytes are stored.
#   libheif-examples — provides `heif-convert`, the HEIC → JPEG decode. It
#                      pulls libheif1 + libde265 (the HEVC DECODER); no x265
#                      encoder is needed, because the server only ever reads
#                      HEIC and writes JPEG.
#
# Verified in this exact base image: ffmpeg 5.1.9, libheif 1.15.1, libde265
# 1.0.11 — a GPS-tagged HEIC decodes and a GPS-tagged .mov remuxes.
#
# If either binary is missing, `ingest()` REFUSES the upload with
# `transcode-unavailable` (HTTP 503) rather than storing an unnormalised
# original — so a broken image degrades to "iPhone uploads rejected", never to
# "iPhone uploads stored with their GPS coordinates".
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update -y && apt-get install -y --no-install-recommends \
      openssl ca-certificates ffmpeg libheif-examples \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
# The serverless-style handlers, mounted at the same /api/* paths they had on
# Vercel. WEB_API_DIR tells main.ts where they landed.
COPY --from=build /app/deploy-api ./web-api
ENV WEB_API_DIR=/app/web-api
EXPOSE 4000
# Migrations run at boot, not by hand: a deploy that ships code expecting a
# column the database lacks is a broken deploy, and nobody is watching to
# remember the step. `migrate deploy` is a no-op when there is nothing to do.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
