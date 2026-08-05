-- D7: durable delivery marker for moderation reports. Additive and nullable:
-- existing rows keep NULL, which correctly reads as "never delivered".
ALTER TABLE "MomentReport" ADD COLUMN "queuedAt" TIMESTAMP(3);
