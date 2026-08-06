-- Wave 1B (owner decision D6): the 18+ age gate declaration. Additive only.
-- birthYearMonth holds a self-declared 'YYYY-MM' (never a full DOB — data
-- minimization, src/policy/age.ts); agePolicyVersion records which policy text
-- the declarant saw. Existing rows keep NULL = "declaration required on next
-- login" (B2); nothing user-facing changes at migration time.
ALTER TABLE "User" ADD COLUMN "birthYearMonth" TEXT;
ALTER TABLE "User" ADD COLUMN "agePolicyVersion" TEXT;
