// Site-bucket access for published pages. Writes are confined to the pages
// prefix — the IAM grant in infra enforces the same boundary.
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { env } from "./env";

// followRegionRedirects: the existing site bucket may live in a different
// region than the Lambda; without this, S3 rejects with PermanentRedirect.
const s3 = new S3Client({ region: env.region, followRegionRedirects: true });

export function pageKey(slug: string): string {
  return `${env.pagesPrefix}/${slug}/index.html`;
}

export async function writePageObject(slug: string, html: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.siteBucket,
      Key: pageKey(slug),
      Body: html,
      ContentType: "text/html; charset=utf-8",
      // Explicit SSE-S3 satisfies deny-unencrypted-upload bucket policies and
      // avoids needing KMS permissions on buckets with a KMS default key.
      ServerSideEncryption: "AES256",
      // Republish must be visible immediately; CloudFront respects this when
      // the distribution honours origin cache headers.
      CacheControl: "no-cache",
    })
  );
}

export async function deletePageObject(slug: string): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({ Bucket: env.siteBucket, Key: pageKey(slug) })
  );
}
