/**
 * RAW-SQL OBJECTS FENCE — the catalog assertions for every database object
 * that exists ONLY in migration SQL, where `prisma db push` cannot create it
 * and schema.prisma cannot express it.
 *
 * THE AUDIT THIS ENFORCES. Six objects are raw-SQL-managed. Two were already
 * asserted by CI-running tests (DiscoveryVisibility_geog_idx — catalog check
 * in discovery-people.e2e-spec.ts; the MomentReactionRow CHECK — behaviorally
 * in moments-lifecycle.e2e-spec.ts). FOUR were fenced by nothing:
 * ExchangeIntent_geog_idx, Event_geog_idx, Moment_geog_idx, and
 * ExchangeIntent_discoverable_keyset_idx. A future `migrate dev` that lets the
 * diff tool "clean up" an index it cannot see in schema.prisma would drop them
 * silently, and every query plan that depends on them would degrade to a
 * sequential scan with no test going red. This file is the fence.
 *
 * WHERE THIS RUNS, AND WHY ONLY THERE. The backend CI job provisions with
 * `prisma migrate deploy` (production parity) — the ONLY provisioning that
 * executes migration SQL, so the only database where these objects can exist.
 * The e2e job provisions with `prisma db push`, which skips migration SQL BY
 * DESIGN — but that job runs Playwright, never jest, so this file cannot be
 * selected there. Both migration-header claims are true; they describe
 * different jobs.
 *
 * NON-VACUOUS BY CONSTRUCTION: every query first asserts it returned rows at
 * all, so an empty catalog, a wrong schema, or a dead connection fails loudly
 * instead of passing on an accidentally-empty result set.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

/** The four GIST indexes managed only in raw migration SQL. */
const GIST_INDEXES = [
  'DiscoveryVisibility_geog_idx',
  'ExchangeIntent_geog_idx',
  'Event_geog_idx',
  'Moment_geog_idx',
] as const;

describe('raw-SQL-managed objects survive on a migrate-deploy database', () => {
  it('all four GIST geography indexes exist (missing ones are NAMED)', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN ('DiscoveryVisibility_geog_idx', 'ExchangeIntent_geog_idx', 'Event_geog_idx', 'Moment_geog_idx')
    `;
    // A dead connection or an unmigrated/empty catalog must fail HERE, loudly —
    // not sail through a set difference of nothing against nothing.
    expect(rows.length).toBeGreaterThan(0);

    // SET DIFFERENCE, so one failure names EVERY missing index at once.
    const present = new Set(rows.map((r) => r.indexname));
    const missing = GIST_INDEXES.filter((name) => !present.has(name));
    expect(missing).toEqual([]);

    // And each one that exists is genuinely a GiST index, not a name squatter.
    for (const r of rows) {
      expect(r.indexdef).toMatch(/USING gist/i);
    }
  });

  it('ExchangeIntent_discoverable_keyset_idx is PARTIAL and DESC — not merely present', async () => {
    /* The browse keyset is `ORDER BY "createdAt" DESC, "id" DESC` over the
     * discoverable predicate. An index of the right NAME but the wrong shape
     * (full instead of partial, ASC instead of DESC) would satisfy an
     * existence check while the planner ignores it — so the shape is the
     * assertion, read from the catalog's own definition. */
    const rows = await prisma.$queryRaw<Array<{ indexdef: string; indpred: string | null }>>`
      SELECT i.indexdef, pg_get_expr(x.indpred, x.indrelid) AS indpred
      FROM pg_indexes i
      JOIN pg_class c ON c.relname = i.indexname
      JOIN pg_index x ON x.indexrelid = c.oid
      WHERE i.schemaname = current_schema()
        AND i.indexname = 'ExchangeIntent_discoverable_keyset_idx'
    `;
    expect(rows.length).toBe(1);
    const { indexdef, indpred } = rows[0];

    // PARTIAL: pg_index.indpred is non-null, and the predicate covers the
    // exact discoverable gate the migration wrote.
    expect(indpred).not.toBeNull();
    expect(indpred).toMatch(/visibility/);
    expect(indpred).toMatch(/discoverable/);
    expect(indpred).toMatch(/status/);
    expect(indpred).toMatch(/moderationState/);

    // DESC on BOTH keyset columns, in order. Postgres renders lowercase
    // identifiers unquoted in pg_get_indexdef ("id" comes back as id), so the
    // quotes are optional in the match — the ORDER is not.
    expect(indexdef).toMatch(/"createdAt" DESC, "?id"? DESC/);
  });

  it('the MomentReactionRow CHECK exists and is closed over EXACTLY the migrated reaction set', async () => {
    /* The allowed values are read from the migration that created the
     * constraint — never assumed here — so if the registry is ever legally
     * widened by a NEW migration, this fence points at the divergence instead
     * of silently blessing a stale hardcoded list. */
    const migration = readFileSync(
      join(__dirname, '../prisma/migrations/20260804210000_moments_backend/migration.sql'),
      'utf8',
    );
    const checkLine = migration.match(/CHECK\s*\(\s*"reaction"\s+IN\s*\(([^)]+)\)\s*\)/);
    expect(checkLine).not.toBeNull();
    const migratedSet = [...checkLine![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(migratedSet.length).toBeGreaterThan(0); // the migration parse itself is non-vacuous

    const rows = await prisma.$queryRaw<Array<{ conname: string; def: string }>>`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = 'MomentReactionRow_reaction_closed'
        AND contype = 'c'
        AND conrelid = (SELECT oid FROM pg_class WHERE relname = 'MomentReactionRow' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema()))
    `;
    expect(rows.length).toBe(1);

    // Closed over EXACTLY the migrated set: same values, nothing more, nothing
    // fewer, read back out of the live constraint definition.
    const liveSet = [...rows[0].def.matchAll(/'([^':]+)'(?:::text)?/g)].map((m) => m[1]).sort();
    expect(liveSet).toEqual(migratedSet);
  });
});
