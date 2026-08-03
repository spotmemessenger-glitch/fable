-- Smart Nearby Discovery Map — persistence (Platform Phase 2, checkpoint 3).
--
-- ADDITIVE ONLY: three new tables + indexes; no existing table or column is
-- touched. The feature is DARK — no code path reaches these tables until an
-- owner-authorized activation change imports DiscoveryModule.
--
-- PRIVACY: columns hold ONLY the on-device coarse public position
-- (ADR-018/019/024) — coarseLat/coarseLon/coarseCell — never a precise fix.
-- No sensitive attribute exists here (no age, no gender — A3/P6). The profile
-- projection references the canonical handle but is NOT the authority for
-- handle uniqueness/ownership/lifecycle (A9): deliberately NO unique index on
-- handle; it is derived, rebuildable, and cascades away with the user.
--
-- ROLLBACK: dropping these three tables removes the dark feature's storage and
-- nothing else (no other table references them). Prefer leaving them in place
-- when unsure — empty tables are inert and dropping is only safe while no
-- activation has occurred.
--
-- PRODUCTION PERMISSION: requires the PostGIS extension, enabled by the 1A
-- migration (20260803120000_enable_postgis) — see its header for the
-- managed-DB permission gate. This migration only USES the geography type.
--
-- RETENTION / DELETION: presence rows expire via expiresAt (expired rows are
-- unqueryable by contract and sweepable by ops); ON DELETE CASCADE removes a
-- user's visibility and projection rows with the account (A9); block
-- projections are keyed by both ids and swept with account deletion by the
-- projection rebuild.

CREATE TABLE "DiscoveryVisibility" (
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "coarseCell" TEXT NOT NULL,
    "coarseLat" DOUBLE PRECISION NOT NULL,
    "coarseLon" DOUBLE PRECISION NOT NULL,
    "geog" geography(Point, 4326),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "visibilityVersion" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DiscoveryVisibility_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "DiscoveryPublicProfileProjection" (
    "userId" TEXT NOT NULL,
    "handle" TEXT,
    "normalizedHandle" TEXT,
    "displayName" TEXT NOT NULL,
    "avatarRef" TEXT,
    "discoverable" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveryPublicProfileProjection_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "DiscoveryBlockProjection" (
    "ownerUserId" TEXT NOT NULL,
    "blockedUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveryBlockProjection_pkey" PRIMARY KEY ("ownerUserId","blockedUserId")
);

-- Spatial index: the nearest-first bounded-radius query plans on this.
CREATE INDEX "DiscoveryVisibility_geog_idx" ON "DiscoveryVisibility" USING GIST ("geog");
CREATE INDEX "DiscoveryVisibility_expiresAt_idx" ON "DiscoveryVisibility"("expiresAt");
CREATE INDEX "DiscoveryVisibility_enabled_expiresAt_idx" ON "DiscoveryVisibility"("enabled", "expiresAt");
CREATE INDEX "DiscoveryPublicProfileProjection_normalizedHandle_idx" ON "DiscoveryPublicProfileProjection"("normalizedHandle");
CREATE INDEX "DiscoveryPublicProfileProjection_discoverable_idx" ON "DiscoveryPublicProfileProjection"("discoverable");
CREATE INDEX "DiscoveryBlockProjection_blockedUserId_idx" ON "DiscoveryBlockProjection"("blockedUserId");

ALTER TABLE "DiscoveryVisibility" ADD CONSTRAINT "DiscoveryVisibility_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveryPublicProfileProjection" ADD CONSTRAINT "DiscoveryPublicProfileProjection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
