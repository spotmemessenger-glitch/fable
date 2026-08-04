-- Live Nearby Events — persistence (Platform Phase 4B) — DARK.
--
-- ADDITIVE ONLY: three new tables + indexes; no existing table or column is
-- touched. The EventsModule that reads them is NOT imported by AppModule — no
-- code path reaches these tables until an owner-authorized activation.
--
-- PRIVACY: events hold ONLY the coarse PUBLIC venue point (coarseLat/coarseLon/
-- coarseCell) — never a precise fix, and there is NO user-origin column at all.
-- The public search projection carries labels + a coarse cell, never
-- coordinates (threat model T-EV-5/6). No age/gender column exists (A3). No
-- payment column exists. Raw provider payloads are NEVER persisted — only the
-- whitelisted, normalized fields below.
--
-- SOURCE TRUTH (C3): provider/providerEventId/providerSourceId/organizerRef/
-- revisionAt/confidence and the cancel/postpone provenance are stored so every
-- event can credit its source; lifecycle 'cancelled'/'postponed' overrides the
-- time-derived state. TIME (C5): instants are UTC; timezone is display-only;
-- allDay is explicit; occurrenceId is provider-supplied only (recurrence is
-- never inferred). DEDUP (C4): EventDedupDecision records the explainable
-- evidence for any cross-provider merge; exact provider identity is enforced by
-- the Event_provider_providerEventId_key unique.
--
-- PRISMA DRIFT: the `geog` column is Prisma-Unsupported and its GIST index
-- (Event_geog_idx, below) is MANAGED ONLY in this raw SQL — `migrate dev` will
-- report it as drift and may propose to DROP it; it must be preserved (review
-- generated migrations with --create-only). This migration does NOT drop the
-- discovery/exchange geog indexes (likewise raw-SQL-managed).
--
-- ROLLBACK: dropping these three tables removes the dark feature's storage and
-- nothing else. RETENTION: ended events past their retention window carry an
-- expiresAt and are swept by the ops runbook DELETE.

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "providerSourceId" TEXT,
    "organizerRef" TEXT,
    "sourceName" TEXT,
    "url" TEXT,
    "revisionAt" TIMESTAMP(3),
    "confidence" DOUBLE PRECISION,
    "category" TEXT NOT NULL DEFAULT 'other',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "timezone" TEXT,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "occurrenceId" TEXT,
    "lifecycle" TEXT NOT NULL DEFAULT 'scheduled',
    "provenanceBy" TEXT,
    "provenanceAt" TIMESTAMP(3),
    "provenanceNote" TEXT,
    "coarseLat" DOUBLE PRECISION NOT NULL,
    "coarseLon" DOUBLE PRECISION NOT NULL,
    "coarseCell" TEXT NOT NULL,
    "geog" geography(Point, 4326),
    "popularity" DOUBLE PRECISION,
    "canonicalId" TEXT,
    "fetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventDedupDecision" (
    "id" TEXT NOT NULL,
    "canonicalId" TEXT NOT NULL,
    "mergedId" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "titleMatch" BOOLEAN NOT NULL DEFAULT false,
    "venueMatch" BOOLEAN NOT NULL DEFAULT false,
    "timeOverlap" BOOLEAN NOT NULL DEFAULT false,
    "areaMatch" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventDedupDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventSearchProjection" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "normalizedText" TEXT NOT NULL,
    "coarseCell" TEXT NOT NULL,
    "startAt" TIMESTAMP(3),
    "state" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventSearchProjection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Event_canonicalId_idx" ON "Event"("canonicalId");

-- CreateIndex
CREATE INDEX "Event_startAt_idx" ON "Event"("startAt");

-- CreateIndex
CREATE INDEX "Event_coarseCell_idx" ON "Event"("coarseCell");

-- CreateIndex
CREATE UNIQUE INDEX "Event_provider_providerEventId_key" ON "Event"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "EventDedupDecision_canonicalId_idx" ON "EventDedupDecision"("canonicalId");

-- CreateIndex
CREATE UNIQUE INDEX "EventDedupDecision_mergedId_key" ON "EventDedupDecision"("mergedId");

-- CreateIndex
CREATE INDEX "EventSearchProjection_category_startAt_idx" ON "EventSearchProjection"("category", "startAt");

-- CreateIndex (raw SQL — a GIST index over the Prisma-Unsupported `geog`
-- column, for ST_DWithin/ST_Distance nearby queries. Not represented in the
-- Prisma schema; preserve across future `migrate dev` runs.)
CREATE INDEX "Event_geog_idx" ON "Event" USING GIST ("geog");

-- CreateIndex (partial keyset index for the discoverable browse query — newest
-- first over live, canonical, scheduled events; keeps deep pagination flat.)
CREATE INDEX "Event_browse_keyset_idx" ON "Event" ("startAt" DESC, "id" DESC)
  WHERE "canonicalId" IS NULL AND "lifecycle" <> 'cancelled';
