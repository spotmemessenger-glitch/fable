-- Composer edits: trim points and the chosen cover frame, applied by the
-- transcode worker rather than re-encoded on the phone.
--
-- Additive and nullable, like the M3 ladder columns above: every existing
-- asset reads NULL and transcodes exactly as it did before these existed, so
-- this migration changes no current behaviour on its own.
ALTER TABLE "MomentMediaAsset" ADD COLUMN "trimStartMs" INTEGER;
ALTER TABLE "MomentMediaAsset" ADD COLUMN "trimEndMs" INTEGER;
ALTER TABLE "MomentMediaAsset" ADD COLUMN "coverAtMs" INTEGER;
