-- Wave 1C C7: the Stage-A allowlist. Additive; empty by default (nobody
-- allowlisted). Independent of RuntimeFlag: exact (domain,userId) grants.
CREATE TABLE "DomainAllowlist" (
    "domain" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "note" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DomainAllowlist_pkey" PRIMARY KEY ("domain","userId")
);
CREATE INDEX "DomainAllowlist_domain_idx" ON "DomainAllowlist"("domain");
