// S3 (or any S3-compatible store) implementation of ObjectStore. The same code talks to AWS S3 in
// prod and to MinIO/LocalStack in tests — only endpoint/credentials differ. This library reads NO
// process.env; the app injects config at its composition root (like @ratio/data-db).
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { ObjectStore } from './object-store';

export interface S3Config {
  bucket: string;
  region?: string;
  // Set for an S3-compatible store (MinIO/LocalStack). Undefined = real AWS S3.
  endpoint?: string;
  // MinIO/LocalStack need path-style addressing (bucket in the path, not the host). Defaults to true
  // whenever a custom endpoint is given.
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  // Optional namespace within the bucket (e.g. 'themes/'); every key is prefixed with it.
  keyPrefix?: string;
}

// A missing key surfaces as a NoSuchKey / NotFound / 404 from GetObject / HeadObject.
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

// S3 wraps ETags in quotes; callers want the bare value.
function bareEtag(etag: string | undefined): string {
  return (etag ?? '').replace(/^"|"$/g, '');
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(cfg: S3Config) {
    this.bucket = cfg.bucket;
    this.prefix = cfg.keyPrefix ?? '';
    this.client = new S3Client({
      region: cfg.region ?? 'us-east-1',
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle ?? Boolean(cfg.endpoint),
      credentials: cfg.credentials,
    });
  }

  private key(k: string): string {
    return this.prefix + k;
  }

  async put(
    key: string,
    body: Uint8Array,
    opts: { contentType?: string } = {}
  ): Promise<{ etag: string }> {
    const res = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        Body: body,
        ContentType: opts.contentType,
      })
    );
    return { etag: bareEtag(res.ETag) };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) })
      );
      if (!res.Body) return null;
      return await res.Body.transformToByteArray();
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async head(key: string): Promise<{ etag: string } | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) })
      );
      return { etag: bareEtag(res.ETag) };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
  }
}
