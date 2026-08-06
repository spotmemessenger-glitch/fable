# 09 — Database Schema

> Reconstruction pending A5 ratification. Schema `[PROPOSED]`, PostgreSQL +
> Prisma (canonical architecture). **No exact coordinates are stored** — only
> coarsened/approximate location; the precise fix never leaves the device.

## 9.1 Entities (Prisma-style sketch `[PROPOSED]`)

```prisma
model ExchangeItem {
  id            String   @id @default(cuid())
  ownerId       String                       // user or business
  type          ItemType                     // NEED | OFFER
  status        ItemStatus                   // DRAFT|ACTIVE|MATCHED|ENGAGED|PAUSED|RESOLVED|EXPIRED|CLOSED|REMOVED
  category      String                       // from the transparent category graph
  title         String
  text          String
  tags          String[]
  budgetBand    BudgetBand?                  // banded, never an exact amount
  timeframeFrom DateTime?
  timeframeTo   DateTime?
  // APPROXIMATE location only — cell-snapped on device (ADR-018). No exact lat/lon column exists.
  approxCellLat Float
  approxCellLon Float
  geoCell       String                       // discretized cell id for indexing
  recurring     Boolean  @default(false)
  precision     Precision                    // APPROXIMATE | NEIGHBOURHOOD | EXACT_ON_CONNECT
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  expiresAt     DateTime?
  matches       Match[]
  reports       Report[]
  @@index([type, status, geoCell])
  @@index([ownerId, status])
  @@index([expiresAt])
}

model Match {
  id        String   @id @default(cuid())
  needId    String
  offerId   String
  status    MatchStatus                      // PROPOSED|VIEWED|ACCEPTED|DECLINED|DISMISSED|SUPERSEDED|EXPIRED
  score     Float
  rankReason Json                            // component breakdown (§04) for the explainable rationale
  epoch     Int                              // supersede guard
  createdAt DateTime @default(now())
  need      ExchangeItem @relation("need", fields: [needId], references: [id])
  offer     ExchangeItem @relation("offer", fields: [offerId], references: [id])
  @@unique([needId, offerId])
  @@index([needId, status, score])
  @@index([offerId, status])
}

model Reputation {
  subjectId     String  @id                  // user or business
  score         Float   @default(0)          // derived, non-sensitive
  completed     Int     @default(0)
  reported      Int     @default(0)
  verified      Boolean @default(false)
  updatedAt     DateTime @updatedAt
}

model Report {
  id         String   @id @default(cuid())
  itemId     String?
  matchId    String?
  reporterId String
  reason     String
  evidence   Json
  status     ReportStatus                    // OPEN|REVIEWING|ACTIONED|DISMISSED|APPEALED
  createdAt  DateTime @default(now())
}

model ConsentRecord {
  id        String   @id @default(cuid())
  userId    String
  scope     String                           // map-visibility | share-location | proactive-pings | personalization
  granted   Boolean
  updatedAt DateTime @updatedAt
  @@index([userId, scope])
}
```

## 9.2 Indexing & geo

- Location is stored **discretized** (`geoCell`, `approxCell*`) so spatial
  queries never need exact points. Radius search is over cells covering the
  adaptive radius — **no PostGIS/H3 in v1** (explicitly out of scope; a cell
  index suffices `[PROPOSED]`).
- Hot paths indexed: candidate lookup `(type,status,geoCell)`; owner views
  `(ownerId,status)`; expiry sweeps `(expiresAt)`; match ranking
  `(needId,status,score)`.

## 9.3 Integrity & lifecycle

- Migrations reviewed and rehearsed; no destructive migration without a rollback/
  forward-repair plan (`MIGRATED_BUILD_MEMORY` §2.3).
- **Expiry/purge job** transitions ACTIVE→EXPIRED past `expiresAt` and purges
  resolved/expired items + matches after the retention window (§07),
  transactional-outbox driven, idempotent.
- **Match recompute** is idempotent and epoch-guarded; stale matches marked
  SUPERSEDED, not deleted mid-flight.

## 9.4 What is deliberately absent

- **No exact latitude/longitude column** anywhere for a Need/Offer.
- **No sensitive-attribute column** (religion/health/etc.).
- **No stored precise track/history** (location history off by default).
