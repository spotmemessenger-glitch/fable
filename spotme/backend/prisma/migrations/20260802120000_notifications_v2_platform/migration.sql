-- Notifications V2 platform — ADDITIVE, REVERSIBLE (Priority 2, PR A).
--
-- SAFETY: this migration ONLY creates four NEW tables and their indexes. It
-- alters NO existing table, drops nothing, and changes no column type or
-- nullability. Nothing reads or writes these tables until the (default-OFF)
-- NOTIFICATIONS_V2_ENABLED flag is set AND the NotificationModule is imported
-- into AppModule — neither of which happens in this branch. Applying it is a
-- no-op for every shipped feature.
--
-- MANUAL ROLLBACK (Prisma migrations are forward-only in this repo; reversibility
-- is achieved by additivity + a written drop script — see
-- docs/priority-2/rollback-push-platform.md):
--
--   DROP TABLE IF EXISTS "ConversationNotifPref";
--   DROP TABLE IF EXISTS "NotificationPreference";
--   DROP TABLE IF EXISTS "NotificationReceipt";
--   DROP TABLE IF EXISTS "NotificationOutbox";
--
-- Because no existing feature references these tables, the drop is safe at any
-- time and loses no data belonging to another feature.

-- CreateTable
CREATE TABLE "NotificationOutbox" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "roomId" TEXT,
    "eventSeq" INTEGER,
    "eventClass" TEXT NOT NULL,
    "actorId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "collapseKey" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "ttlSeconds" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "count" INTEGER NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationReceipt" (
    "id" TEXT NOT NULL,
    "outboxId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "providerId" TEXT,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "userId" TEXT NOT NULL,
    "dndEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dndStart" INTEGER,
    "dndEnd" INTEGER,
    "dndTz" TEXT,
    "allowCallsInDnd" BOOLEAN NOT NULL DEFAULT true,
    "defaultLevel" TEXT NOT NULL DEFAULT 'all',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "ConversationNotifPref" (
    "userId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'default',
    "muteUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationNotifPref_pkey" PRIMARY KEY ("userId","roomId")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationOutbox_dedupeKey_key" ON "NotificationOutbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationOutbox_status_nextAttemptAt_idx" ON "NotificationOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NotificationOutbox_recipientId_collapseKey_status_idx" ON "NotificationOutbox"("recipientId", "collapseKey", "status");

-- CreateIndex
CREATE INDEX "NotificationOutbox_createdAt_idx" ON "NotificationOutbox"("createdAt");

-- CreateIndex
CREATE INDEX "NotificationReceipt_outboxId_idx" ON "NotificationReceipt"("outboxId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationReceipt_outboxId_deviceId_event_key" ON "NotificationReceipt"("outboxId", "deviceId", "event");

-- CreateIndex
CREATE INDEX "ConversationNotifPref_userId_idx" ON "ConversationNotifPref"("userId");
