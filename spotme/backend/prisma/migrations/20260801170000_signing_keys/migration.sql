-- ADR-008 Phase 2B: published signing-key lifecycle (publish / supersede /
-- withdraw). Tombstoned — rows are never deleted.
CREATE TABLE "SigningKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "publicKeyB64" TEXT NOT NULL,
    "algo" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "supersessionSigB64" TEXT,

    CONSTRAINT "SigningKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SigningKey_userId_publicKeyB64_key" ON "SigningKey"("userId", "publicKeyB64");

CREATE INDEX "SigningKey_userId_status_idx" ON "SigningKey"("userId", "status");

ALTER TABLE "SigningKey" ADD CONSTRAINT "SigningKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
