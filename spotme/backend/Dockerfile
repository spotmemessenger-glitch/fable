# Deploys straight to Railway/Fly with `git push` — no Kubernetes needed at this scale.
FROM node:22-slim AS build
WORKDIR /app
# Prisma's engine links against libssl. node:22-slim (bookworm) ships OpenSSL 3
# but not the headers Prisma probes for, so detection silently falls back to
# "openssl-1.1.x" and the container dies at boot with
# `libssl.so.1.1: cannot open shared object file`. Installing openssl here and
# pinning binaryTargets in schema.prisma are the two halves of the fix.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
EXPOSE 4000
# Migrations run at boot, not by hand: a deploy that ships code expecting a
# column the database does not have is a broken deploy, and there is no human
# in the loop here to remember the step. `migrate deploy` only applies
# committed migrations and is a no-op when there is nothing to do.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
