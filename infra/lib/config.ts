// Deployment configuration, read from environment variables (see infra/.env.example).
// Follows majodali/serverless-web-app-template; backend-related settings will
// return here when backend services are added.

export type HostingMode = "cloudfront" | "existing-bucket";

export interface AppConfig {
  account?: string;
  region: string;
  /** Short app name used for stack + resource naming. */
  appName: string;

  // ---- Hosting ----
  /** "cloudfront": own S3 + CloudFront (+ optional domain).
   *  "existing-bucket": deploy the app into an existing site bucket under a path. */
  hostingMode: HostingMode;
  // cloudfront mode:
  domainName?: string;
  includeWww: boolean;
  // existing-bucket mode:
  siteBucketName: string;
  sitePathPrefix: string;
  siteBaseUrl: string;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "contraption";
}

export function loadConfig(): AppConfig {
  const appName = sanitize(process.env.APP_NAME?.trim() || "contraption");
  const hostingMode: HostingMode =
    process.env.HOSTING_MODE === "existing-bucket" ? "existing-bucket" : "cloudfront";

  const siteBucketName = process.env.SITE_BUCKET_NAME?.trim() || "";
  const sitePathPrefix = (process.env.SITE_PATH_PREFIX?.trim() || appName).replace(
    /^\/+|\/+$/g,
    ""
  );
  const siteBaseUrl =
    process.env.SITE_BASE_URL?.trim() ||
    (siteBucketName ? `http://${siteBucketName}/${sitePathPrefix}` : "");

  return {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || "us-east-1",
    appName,
    hostingMode,
    domainName: process.env.DOMAIN_NAME?.trim() || undefined,
    includeWww: process.env.INCLUDE_WWW === "true",
    siteBucketName,
    sitePathPrefix,
    siteBaseUrl,
  };
}
