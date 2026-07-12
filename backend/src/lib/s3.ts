// Site-bucket access for published pages. Writes are confined to the pages
// prefix — the IAM grant in infra enforces the same boundary.
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { env } from "./env";

const s3 = new S3Client({ region: env.region });

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
