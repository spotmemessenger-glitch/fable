/**
 * Confirms the integration suite left nothing behind.
 *
 *   node scripts/s3-verify-clean.mjs
 *
 * The suite deletes what it created in `afterAll`. This is the check that it
 * actually did, because a leak into a shared staging bucket is slow, silent,
 * and only noticed when someone reads a bill. It runs with `if: always()` so a
 * failed suite — the case most likely to skip its own cleanup — is still swept.
 *
 * RUNS IN BOTH PLACES, and that is the point. Against R2 it protects a real
 * shared bucket. Against CI's MinIO it protects nothing — the container is
 * discarded seconds later — but it is the only place the `afterAll` path is
 * exercised on every pull request. Without it, a cleanup path that quietly
 * stopped working would first be noticed during a rare manual R2 run, which is
 * both the worst place to find out and the place where it has already leaked.
 *
 * It only ever looks at, and only ever deletes, objects under the integration
 * suite's own `rooms/itest…` prefix. Anything else in the bucket is not its
 * business and is left strictly alone.
 */
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3'

const PREFIX = 'rooms/itest'

const bucket = process.env.S3_BUCKET
const endpoint = process.env.S3_ENDPOINT

// Both guards before the client is built. This script DELETES, so an empty
// bucket name must not become a guess and an empty endpoint must not silently
// aim a delete sweep at real AWS.
if (!bucket) {
  console.error('S3_BUCKET is not set — refusing to guess')
  process.exit(1)
}
if (!endpoint) {
  console.error('S3_ENDPOINT is not set — refusing to fall back to real AWS')
  process.exit(1)
}

const client = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
})

const stale = []
let token

do {
  const page = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: PREFIX,
    ContinuationToken: token,
  }))
  for (const o of page.Contents || []) stale.push(o.Key)
  token = page.IsTruncated ? page.NextContinuationToken : undefined
} while (token)

if (!stale.length) {
  console.log(`clean: no objects under "${PREFIX}"`)
  process.exit(0)
}

// Sweep rather than merely report. Leaving them and printing a warning means
// the next run inherits them and the warning becomes background noise.
console.warn(`${stale.length} object(s) left under "${PREFIX}" — sweeping`)
for (const Key of stale) {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key }))
  console.warn(`  deleted ${Key}`)
}

// Non-zero: the suite's own cleanup did not do its job, and that is worth
// failing on even though this script fixed it. A cleanup path that silently
// stops working is how a shared bucket fills up.
console.error('suite cleanup was incomplete — see afterAll in test/s3-integration.spec.ts')
process.exit(1)
