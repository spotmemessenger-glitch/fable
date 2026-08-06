/**
 * Creates the integration suite's bucket, if it is not already there.
 *
 *   node scripts/s3-ensure-bucket.mjs
 *
 * WHY THIS EXISTS. The official `minio/minio` image has no equivalent of
 * Bitnami's MINIO_DEFAULT_BUCKETS, and Actions service containers cannot pass
 * the `server /data` command the official image needs — so MinIO is started as
 * a step and the bucket is created here rather than by the image.
 *
 * WHY NOT LET THE SUITE CREATE IT. S3StorageAdapter has no bucket-creation
 * path, and it should not grow one: the R2 credentials this same suite runs
 * under in the staging smoke test are deliberately least-privilege, with no
 * bucket-creation right at all. Provisioning belongs to whoever set the bucket
 * up, which in CI is this script and in staging is a human.
 *
 * It is idempotent — an existing bucket is a success, not an error — so a
 * re-run of a job that got half-way through does not fail here.
 */
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3'

const bucket = process.env.S3_BUCKET
const endpoint = process.env.S3_ENDPOINT

// Refuse to guess. An empty S3_BUCKET here would otherwise become a confusing
// SDK error several layers down, and an empty S3_ENDPOINT would silently aim
// this at real AWS.
if (!bucket) {
  console.error('S3_BUCKET is not set — refusing to guess')
  process.exit(1)
}
if (!endpoint) {
  console.error('S3_ENDPOINT is not set — refusing to fall back to real AWS')
  process.exit(1)
}

const client = new S3Client({
  region: process.env.S3_REGION || 'us-east-1',
  endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
})

try {
  await client.send(new HeadBucketCommand({ Bucket: bucket }))
  console.log(`bucket "${bucket}" already exists`)
  process.exit(0)
} catch (err) {
  // 404/NotFound is the expected path on a fresh container. Anything else —
  // 403 from wrong credentials, a connection refusal from a MinIO that never
  // came up — must not be swallowed and retried as a creation.
  const status = err?.$metadata?.httpStatusCode
  if (status !== 404 && err?.name !== 'NotFound' && err?.name !== 'NoSuchBucket') {
    console.error(
      `HeadBucket on "${bucket}" failed: ${err?.name || 'Error'} ` +
        `(HTTP ${status ?? 'none'}) — ${err?.message || err}`,
    )
    process.exit(1)
  }
}

try {
  await client.send(new CreateBucketCommand({ Bucket: bucket }))
  console.log(`created bucket "${bucket}"`)
} catch (err) {
  // Two concurrent runs, or a HeadBucket that raced a creation. Both mean the
  // bucket is there now, which is all this script promises.
  if (
    err?.name === 'BucketAlreadyOwnedByYou' ||
    err?.name === 'BucketAlreadyExists'
  ) {
    console.log(`bucket "${bucket}" already exists`)
    process.exit(0)
  }
  console.error(
    `CreateBucket "${bucket}" failed: ${err?.name || 'Error'} — ${err?.message || err}`,
  )
  process.exit(1)
}
