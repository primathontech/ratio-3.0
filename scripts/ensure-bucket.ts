// Ensure the object-store bucket exists (idempotent) — a dev-bootstrap step so a FRESH machine works.
// A brand-new MinIO volume has no bucket, so onboarding's first theme publish 404s with NoSuchBucket
// and the Design step spins forever. `bun run dev` runs this after migrate. No-op when the bundle
// store is disabled (no BUNDLE_S3_BUCKET) or the bucket already exists — so it's safe to run always
// and never touches a real prod bucket (HeadBucket succeeds there → no create attempt).
import { S3Client, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';

async function main(): Promise<void> {
  const bucket = process.env.BUNDLE_S3_BUCKET;
  if (!bucket) {
    console.log('(no BUNDLE_S3_BUCKET — bundle store disabled, skipping bucket ensure)');
    return;
  }
  const endpoint = process.env.BUNDLE_S3_ENDPOINT;
  const accessKeyId = process.env.BUNDLE_S3_KEY;
  const secretAccessKey = process.env.BUNDLE_S3_SECRET;
  const s3 = new S3Client({
    region: process.env.BUNDLE_S3_REGION ?? 'us-east-1',
    endpoint,
    forcePathStyle: Boolean(endpoint), // path-style for MinIO/LocalStack (mirrors data-objects/s3.ts)
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
  });

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`bucket "${bucket}" already exists`);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`created bucket "${bucket}"`);
  }
}

main().catch((e) => {
  console.error('ensure-bucket failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
