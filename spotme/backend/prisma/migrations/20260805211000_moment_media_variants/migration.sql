-- M3: transcode ladder output. Additive and nullable — an asset is servable
-- before the worker has run, it simply has no derived renditions yet.
ALTER TABLE "MomentMediaAsset" ADD COLUMN "variants" TEXT;
ALTER TABLE "MomentMediaAsset" ADD COLUMN "posterKey" TEXT;
ALTER TABLE "MomentMediaAsset" ADD COLUMN "durationSeconds" DOUBLE PRECISION;
