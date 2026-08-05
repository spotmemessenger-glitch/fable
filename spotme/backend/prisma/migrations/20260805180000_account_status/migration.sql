-- Wave 1C (owner decision, D6 addendum): explicit account status. Additive.
-- 'active' (default) | 'frozen_minor'. Existing rows become 'active'; freezing
-- is assigned only by the under-18 declaration paths, never by migration.
ALTER TABLE "User" ADD COLUMN "accountStatus" TEXT NOT NULL DEFAULT 'active';
