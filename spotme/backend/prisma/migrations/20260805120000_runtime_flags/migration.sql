-- WAVE-1A R7: the activation kill-switch registry. Additive only.
-- One row per dark domain; a MISSING row means DISABLED (the gate fails dark),
-- so creating this table changes nothing user-facing: no rows exist, every
-- gated surface stays 404. Flipping a domain on/off is a single-row UPDATE —
-- no migration, no redeploy, no restart.
CREATE TABLE "RuntimeFlag" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuntimeFlag_pkey" PRIMARY KEY ("key")
);
