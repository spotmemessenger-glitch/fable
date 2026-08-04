-- SpotMe Exchange — persistence (Platform Phase 3B) — DARK.
--
-- ADDITIVE ONLY: five new tables + indexes; no existing table or column is
-- touched. The ExchangeModule that reads them is NOT imported by AppModule —
-- no code path reaches these tables until an owner-authorized activation.
--
-- PRIVACY: intents hold ONLY the on-device coarse public position (ADR-018/019)
-- — coarseLat/coarseLon/coarseCell — never a precise fix. No age/gender/
-- sensitive column exists (A3). No payment/escrow column exists; the
-- informationalPrice is a display label only. The public search projection
-- carries labels + a coarse cell, never coordinates (threat model T-EX-19).
--
-- BUSINESS (D4): ExchangeBusinessParticipation is a DARK SEAM — the table
-- exists so the contract is complete, but no business flow is reachable in v1
-- (individuals-only posture, owner-retained).
--
-- PRISMA DRIFT: the `geog` column is Prisma-Unsupported and its GIST index
-- (ExchangeIntent_geog_idx, below) is MANAGED ONLY in this raw SQL — `migrate
-- dev` will report it as drift and may propose to DROP it; it must be preserved
-- (review generated migrations with --create-only). This migration deliberately
-- does NOT drop DiscoveryVisibility_geog_idx (the diff tool proposed to; the
-- discovery index is likewise raw-SQL-managed and must survive).
--
-- ROLLBACK: dropping these five tables removes the dark feature's storage and
-- nothing else. RETENTION/DELETION: intents expire via expiresAt (expired rows
-- are unqueryable by contract, sweepable by ops); ON DELETE CASCADE removes a
-- user's intents, their lifecycle/matches, and projections with the account.


-- CreateTable
CREATE TABLE "ExchangeIntent" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "ownerKind" TEXT NOT NULL DEFAULT 'user',
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "tags" TEXT[],
    "budgetBand" TEXT,
    "informationalPrice" TEXT,
    "availabilityState" TEXT NOT NULL DEFAULT 'unknown',
    "availabilityFrom" TIMESTAMP(3),
    "availabilityTo" TIMESTAMP(3),
    "availabilitySchedule" TEXT,
    "coarseLat" DOUBLE PRECISION NOT NULL,
    "coarseLon" DOUBLE PRECISION NOT NULL,
    "coarseCell" TEXT NOT NULL,
    "geog" geography(Point, 4326),
    "radiusKm" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "maxRadiusKm" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "visibility" TEXT NOT NULL DEFAULT 'hidden',
    "moderationState" TEXT NOT NULL DEFAULT 'clear',
    "versionSeq" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "ExchangeIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeSearchProjection" (
    "intentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "normalizedText" TEXT NOT NULL,
    "intentLabels" TEXT[],
    "coarseCell" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExchangeSearchProjection_pkey" PRIMARY KEY ("intentId")
);

-- CreateTable
CREATE TABLE "ExchangeLifecycleEvent" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "byKind" TEXT NOT NULL,
    "reasonCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeLifecycleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeMatchProjection" (
    "id" TEXT NOT NULL,
    "needId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "score" DOUBLE PRECISION NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 1,
    "distanceBand" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExchangeMatchProjection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeBusinessParticipation" (
    "businessId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "categoryLabels" TEXT[],
    "coarseCell" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExchangeBusinessParticipation_pkey" PRIMARY KEY ("businessId")
);

-- CreateIndex
CREATE INDEX "ExchangeIntent_ownerId_status_idx" ON "ExchangeIntent"("ownerId", "status");

-- CreateIndex
CREATE INDEX "ExchangeIntent_kind_status_idx" ON "ExchangeIntent"("kind", "status");

-- CreateIndex
CREATE INDEX "ExchangeIntent_status_expiresAt_idx" ON "ExchangeIntent"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "ExchangeIntent_expiresAt_idx" ON "ExchangeIntent"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeIntent_ownerId_idempotencyKey_key" ON "ExchangeIntent"("ownerId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ExchangeSearchProjection_kind_category_idx" ON "ExchangeSearchProjection"("kind", "category");

-- CreateIndex
CREATE INDEX "ExchangeLifecycleEvent_intentId_createdAt_idx" ON "ExchangeLifecycleEvent"("intentId", "createdAt");

-- CreateIndex
CREATE INDEX "ExchangeMatchProjection_needId_status_score_idx" ON "ExchangeMatchProjection"("needId", "status", "score");

-- CreateIndex
CREATE INDEX "ExchangeMatchProjection_offerId_status_idx" ON "ExchangeMatchProjection"("offerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeMatchProjection_needId_offerId_key" ON "ExchangeMatchProjection"("needId", "offerId");

-- AddForeignKey
ALTER TABLE "ExchangeIntent" ADD CONSTRAINT "ExchangeIntent_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeLifecycleEvent" ADD CONSTRAINT "ExchangeLifecycleEvent_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "ExchangeIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeMatchProjection" ADD CONSTRAINT "ExchangeMatchProjection_needId_fkey" FOREIGN KEY ("needId") REFERENCES "ExchangeIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeMatchProjection" ADD CONSTRAINT "ExchangeMatchProjection_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "ExchangeIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CreateIndex (raw SQL — a GIST index over the Prisma-Unsupported `geog`
-- column, which cannot be expressed in schema.prisma; MANAGED HERE. Preserve
-- across future `migrate dev` runs, same as DiscoveryVisibility_geog_idx.)
CREATE INDEX "ExchangeIntent_geog_idx" ON "ExchangeIntent" USING GIST ("geog");
