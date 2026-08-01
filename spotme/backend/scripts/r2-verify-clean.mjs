/**
 * Confirms the R2 smoke test left nothing behind.
 *
 *   node scripts/r2-verify-clean.mjs
 *
 * The suite deletes what it created in `afterAll`. This is the check that it
 * actually did, because a leak into a shared staging bucket is slow, silent,
 * and only noticed when someone reads a bill. It runs with `if: always()` so a
 * failed suite — the case most likely to skip its own cleanup — is still swept.
 *
 * It only ever looks at, and only ever deletes, objects under the integration
 * suite's own `rooms/itest…` prefix. Anything else in the bucket is not its
 * business and is left strictly alone.
 */
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3'

const PREFIX = 'rooms/itest'

const client = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
})

const bucket = process.env.S3_BUCKET
if (!bucket) {
  console.error('S3_BUCKET is not set — refusing to guess')
  process.exit(1)
}

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
console.error('suite cleanup was incomplete — see afterAll in s3-integration.spec.ts')
process.exit(1)
