-- View-once ("Private photo") enforcement.
--
-- Hand-written (no shadow database available on this machine), so it must stay
-- byte-compatible with what `prisma migrate dev` would have produced for the
-- ViewOnce model in schema.prisma.
--
-- Before this, the server had never heard of view-once: RoomEvent had no
-- expiry, nothing but the 30-day group purge ever deleted a row, and `fetch`
-- served any slice by attachId to any socket that had joined the room. A
-- recipient could re-download a photo the app had told the sender was burned.
--
-- attachId is the PRIMARY KEY on purpose: the first fetcher claims the single
-- view by inserting this row, so two racing fetchers cannot both be served.

CREATE TABLE "ViewOnce" (
  "attachId"  TEXT NOT NULL,
  "roomId"    TEXT NOT NULL,
  "senderId"  TEXT NOT NULL,
  "viewerId"  TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "burnedAt"  TIMESTAMP(3),
  CONSTRAINT "ViewOnce_pkey" PRIMARY KEY ("attachId")
);

CREATE INDEX "ViewOnce_roomId_idx" ON "ViewOnce"("roomId");
