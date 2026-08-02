-- Notifications V2 — focus-mode preference columns. ADDITIVE, REVERSIBLE.
--
-- SAFETY: adds two nullable/defaulted columns to the (unused-in-prod)
-- NotificationPreference table. Alters no other table, changes no existing
-- column, drops nothing. Every existing row gets focusMode=false (no behaviour
-- change) and focusAllow=NULL. Nothing reads these until NOTIFICATIONS_V2_ENABLED
-- is set AND the module is wired ON — neither of which happens by default.
--
-- MANUAL ROLLBACK (forward-only migrations; reversibility via additivity):
--   ALTER TABLE "NotificationPreference" DROP COLUMN IF EXISTS "focusAllow";
--   ALTER TABLE "NotificationPreference" DROP COLUMN IF EXISTS "focusMode";

ALTER TABLE "NotificationPreference"
  ADD COLUMN "focusMode" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "focusAllow" TEXT;
