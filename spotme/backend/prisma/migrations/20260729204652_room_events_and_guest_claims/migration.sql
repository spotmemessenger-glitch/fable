-- AlterTable
ALTER TABLE "User" ADD COLUMN     "claimSecretHash" TEXT;

-- CreateTable
CREATE TABLE "RoomEvent" (
    "id" SERIAL NOT NULL,
    "roomId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "payload" BYTEA NOT NULL,
    "meta" JSONB,
    "attachId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoomEvent_roomId_id_idx" ON "RoomEvent"("roomId", "id");

-- CreateIndex
CREATE INDEX "RoomEvent_roomId_attachId_idx" ON "RoomEvent"("roomId", "attachId");
