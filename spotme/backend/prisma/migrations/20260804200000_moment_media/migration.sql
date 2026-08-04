-- Nearby Moments — media assets (Platform Phase 5B) — DARK.
--
-- ADDITIVE ONLY: one new table + indexes; no existing table touched. The
-- MediaModule that reads it is NOT imported by AppModule. PRIVACY: only
-- METADATA-STRIPPED bytes are persisted (the exif-strip boundary runs BEFORE
-- any storage write); the table stores keys/hashes only, never bytes, never
-- EXIF, never a coordinate. Dedup on contentHash; refCount-driven deletion
-- cascade (5C moments hold references). ROLLBACK: drop the table.

-- CreateTable
CREATE TABLE "MomentMediaAsset" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "thumbnailKey" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "refCount" INTEGER NOT NULL DEFAULT 0,
    "exifStripped" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "MomentMediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MomentMediaAsset_contentHash_key" ON "MomentMediaAsset"("contentHash");

