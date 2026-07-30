-- Groups v2: roles, granular permissions, public/private visibility, soft delete.
--
-- Written by hand rather than generated because existing Group rows (from the
-- retired /api/groups stack) need a backfilled roomId and a seeded owner
-- membership. A generated migration aborts on the required-column step.

CREATE TYPE "GroupRole" AS ENUM ('OWNER', 'ADMIN', 'MODERATOR', 'MEMBER');
CREATE TYPE "GroupVisibility" AS ENUM ('PRIVATE', 'PUBLIC');

-- 1. New columns, roomId/updatedAt nullable for now so the backfill can run.
ALTER TABLE "Group"
  ADD COLUMN "roomId"            TEXT,
  ADD COLUMN "username"          TEXT,
  ADD COLUMN "visibility"        "GroupVisibility" NOT NULL DEFAULT 'PRIVATE',
  ADD COLUMN "secretKey"         TEXT,
  ADD COLUMN "membersCanAdd"     BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "membersCanMessage" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "membersCanMedia"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "updatedAt"         TIMESTAMP(3),
  ADD COLUMN "deletedAt"         TIMESTAMP(3);

-- 2. Backfill legacy rows. Each gets a fresh 32-hex room id in the same shape
--    the web client generates, and updatedAt seeded from createdAt.
--    gen_random_uuid() is core PG13+; gen_random_bytes would need pgcrypto,
--    which is not installed on the Railway database.
UPDATE "Group"
   SET "roomId"    = COALESCE("roomId", replace(gen_random_uuid()::text, '-', '')),
       "updatedAt" = COALESCE("updatedAt", "createdAt");

-- 3. Now they can be required.
ALTER TABLE "Group"
  ALTER COLUMN "roomId"    SET NOT NULL,
  ALTER COLUMN "updatedAt" SET NOT NULL;

-- 4. conversationId becomes optional — the migration bridge to the old stack.
--    Its FK must survive group deletion without cascading into Conversation.
ALTER TABLE "Group" ALTER COLUMN "conversationId" DROP NOT NULL;
ALTER TABLE "Group" DROP CONSTRAINT IF EXISTS "Group_conversationId_fkey";
ALTER TABLE "Group"
  ADD CONSTRAINT "Group_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Group_roomId_key"    ON "Group"("roomId");
CREATE UNIQUE INDEX "Group_username_key"  ON "Group"("username");
CREATE INDEX        "Group_deletedAt_idx" ON "Group"("deletedAt");

-- 5. Membership table.
CREATE TABLE "GroupMember" (
  "id"                TEXT NOT NULL,
  "groupId"           TEXT NOT NULL,
  "userId"            TEXT NOT NULL,
  "role"              "GroupRole" NOT NULL DEFAULT 'MEMBER',
  "canAddAdmin"       BOOLEAN NOT NULL DEFAULT false,
  "canBan"            BOOLEAN NOT NULL DEFAULT false,
  "canMute"           BOOLEAN NOT NULL DEFAULT false,
  "canRemove"         BOOLEAN NOT NULL DEFAULT false,
  "canDeleteMessages" BOOLEAN NOT NULL DEFAULT false,
  "canControlInvites" BOOLEAN NOT NULL DEFAULT false,
  "mutedUntil"        TIMESTAMP(3),
  "bannedAt"          TIMESTAMP(3),
  "joinedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leftAt"            TIMESTAMP(3),
  CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GroupMember_groupId_userId_key" ON "GroupMember"("groupId", "userId");
CREATE INDEX "GroupMember_userId_idx" ON "GroupMember"("userId");
CREATE INDEX "GroupMember_groupId_leftAt_idx" ON "GroupMember"("groupId", "leftAt");

ALTER TABLE "GroupMember"
  ADD CONSTRAINT "GroupMember_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupMember"
  ADD CONSTRAINT "GroupMember_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. Port legacy membership: every ConversationParticipant on a group's
--    conversation becomes a GroupMember, and the creator becomes OWNER.
--    Without this, migrated groups would have zero members and be unreachable.
INSERT INTO "GroupMember" ("id", "groupId", "userId", "role", "joinedAt")
SELECT gen_random_uuid()::text,
       g."id",
       cp."userId",
       CASE WHEN cp."userId" = g."ownerId" THEN 'OWNER'::"GroupRole"
            ELSE 'MEMBER'::"GroupRole" END,
       cp."joinedAt"
  FROM "Group" g
  JOIN "ConversationParticipant" cp ON cp."conversationId" = g."conversationId"
 WHERE g."conversationId" IS NOT NULL
ON CONFLICT ("groupId", "userId") DO NOTHING;

-- An owner with no participant row would otherwise lose control of the group.
INSERT INTO "GroupMember" ("id", "groupId", "userId", "role", "joinedAt")
SELECT gen_random_uuid()::text, g."id", g."ownerId", 'OWNER'::"GroupRole", g."createdAt"
  FROM "Group" g
ON CONFLICT ("groupId", "userId") DO NOTHING;

-- 7. Legacy groups also need RoomMember rows, or the gateway will not deliver
--    their events to anyone.
INSERT INTO "RoomMember" ("roomId", "userId", "joinedAt", "lastSeen")
SELECT g."roomId", gm."userId", gm."joinedAt", CURRENT_TIMESTAMP
  FROM "Group" g
  JOIN "GroupMember" gm ON gm."groupId" = g."id"
ON CONFLICT ("roomId", "userId") DO NOTHING;
