-- Nearby Moments — backend persistence (Platform Phase 5C) — DARK.
--
-- ADDITIVE ONLY: seven new tables + indexes; no existing table touched. The
-- MomentsModule that reads them is NOT imported by AppModule. PRIVACY
-- (M5/ADR-028): location is an OPT-IN coarse cell on nearby/public posts only;
-- no viewer/origin column exists; 'private' posts never enter any feed query.
-- The legacy client-E2E `Story` model is untouched — Phase 5 stories are
-- `MomentStory`. No age/gender/payment/engagement-counter column exists.
--
-- PRISMA DRIFT: the `geog` column is Prisma-Unsupported; its GIST index and
-- the partial keyset index below are MANAGED ONLY in this raw SQL (preserve
-- across `migrate dev`, same as the discovery/exchange/events geog indexes).
-- The MomentReactionRow CHECK constraint (closed registry, M4) is likewise
-- raw-SQL-managed. ROLLBACK: drop the seven tables.

-- CreateTable
CREATE TABLE "Moment" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT,
    "mediaIds" TEXT[],
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "coarseLat" DOUBLE PRECISION,
    "coarseLon" DOUBLE PRECISION,
    "coarseCell" TEXT,
    "cityCell" TEXT,
    "geog" geography(Point, 4326),
    "moderationState" TEXT NOT NULL DEFAULT 'visible',
    "versionSeq" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Moment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MomentStory" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'friends',
    "state" TEXT NOT NULL DEFAULT 'active',
    "versionSeq" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MomentStory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MomentComment" (
    "id" TEXT NOT NULL,
    "momentId" TEXT NOT NULL,
    "parentId" TEXT,
    "authorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "moderationState" TEXT NOT NULL DEFAULT 'visible',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MomentComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MomentReactionRow" (
    "momentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reaction" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MomentReactionRow_pkey" PRIMARY KEY ("momentId","userId")
);

-- CreateTable
CREATE TABLE "MomentFollow" (
    "followerId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MomentFollow_pkey" PRIMARY KEY ("followerId","targetId")
);

-- CreateTable
CREATE TABLE "MomentBlock" (
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MomentBlock_pkey" PRIMARY KEY ("blockerId","blockedId")
);

-- CreateTable
CREATE TABLE "MomentReport" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MomentReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MomentModerationEvent" (
    "id" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "reason" TEXT,
    "byKind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MomentModerationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Moment_authorId_createdAt_idx" ON "Moment"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "Moment_cityCell_idx" ON "Moment"("cityCell");

-- CreateIndex
CREATE INDEX "Moment_visibility_moderationState_idx" ON "Moment"("visibility", "moderationState");

-- CreateIndex
CREATE INDEX "MomentStory_state_expiresAt_idx" ON "MomentStory"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "MomentStory_authorId_state_idx" ON "MomentStory"("authorId", "state");

-- CreateIndex
CREATE INDEX "MomentComment_momentId_createdAt_idx" ON "MomentComment"("momentId", "createdAt");

-- CreateIndex
CREATE INDEX "MomentFollow_targetId_idx" ON "MomentFollow"("targetId");

-- CreateIndex
CREATE INDEX "MomentBlock_blockedId_idx" ON "MomentBlock"("blockedId");

-- CreateIndex
CREATE INDEX "MomentReport_targetKind_targetId_idx" ON "MomentReport"("targetKind", "targetId");

-- CreateIndex
CREATE INDEX "MomentReport_reason_status_idx" ON "MomentReport"("reason", "status");

-- CreateIndex
CREATE INDEX "MomentModerationEvent_targetId_createdAt_idx" ON "MomentModerationEvent"("targetId", "createdAt");

-- AddForeignKey
ALTER TABLE "Moment" ADD CONSTRAINT "Moment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MomentStory" ADD CONSTRAINT "MomentStory_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MomentComment" ADD CONSTRAINT "MomentComment_momentId_fkey" FOREIGN KEY ("momentId") REFERENCES "Moment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MomentReactionRow" ADD CONSTRAINT "MomentReactionRow_momentId_fkey" FOREIGN KEY ("momentId") REFERENCES "Moment"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Raw SQL — GIST index for nearby-feed ST_DWithin over the coarse point.
CREATE INDEX "Moment_geog_idx" ON "Moment" USING GIST ("geog");

-- Raw SQL — partial keyset index for feed pagination (createdAt DESC, id DESC)
-- over live, non-private rows.
CREATE INDEX "Moment_feed_keyset_idx" ON "Moment" ("createdAt" DESC, "id" DESC)
  WHERE "deletedAt" IS NULL AND "visibility" <> 'private';

-- Raw SQL — the M4 closed reaction registry, enforced at the database too.
ALTER TABLE "MomentReactionRow" ADD CONSTRAINT "MomentReactionRow_reaction_closed"
  CHECK ("reaction" IN ('like', 'love', 'laugh', 'wow', 'support'));
