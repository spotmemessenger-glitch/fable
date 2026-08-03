-- X3DH prekey infrastructure (ADR-004 §8, e2e_v3). Additive; no existing table changes.
CREATE TABLE "SignedPreKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "keyId" INTEGER NOT NULL,
    "pub" TEXT NOT NULL,
    "sig" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "SignedPreKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OneTimePreKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "keyId" INTEGER NOT NULL,
    "pub" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OneTimePreKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SignedPreKey_userId_deviceId_keyId_key" ON "SignedPreKey"("userId", "deviceId", "keyId");
CREATE INDEX "SignedPreKey_userId_deviceId_idx" ON "SignedPreKey"("userId", "deviceId");
CREATE UNIQUE INDEX "OneTimePreKey_userId_deviceId_keyId_key" ON "OneTimePreKey"("userId", "deviceId", "keyId");
CREATE INDEX "OneTimePreKey_userId_deviceId_idx" ON "OneTimePreKey"("userId", "deviceId");

ALTER TABLE "SignedPreKey" ADD CONSTRAINT "SignedPreKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OneTimePreKey" ADD CONSTRAINT "OneTimePreKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
