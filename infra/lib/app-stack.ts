import * as path from "node:path";
import { Stack, StackProps, RemovalPolicy, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import type { AppConfig } from "./config";

const FRONTEND_DIST = path.join(__dirname, "..", "..", "frontend", "dist");

export interface AppStackProps extends StackProps {
  config: AppConfig;
}

/**
 * Client-only for now: the stack just publishes the built frontend per the
 * configured hosting mode. Backend resources (API, tables, auth) will be added
 * here following the template's pattern when backend services land.
 */
export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { config } = props;

    // Runtime config served next to the app. No apiUrl yet — this is the slot
    // where backend endpoints will surface without rebuilding the frontend.
    const runtimeConfig: Record<string, string> = {
      appName: config.appName,
    };

    const siteUrl = this.deployFrontend(config, runtimeConfig);
    new CfnOutput(this, "SiteUrl", { value: siteUrl, description: "Open this to use the app" });
  }

  /** Deploy the built frontend per the configured hosting mode; returns the site URL. */
  private deployFrontend(config: AppConfig, runtimeConfig: Record<string, string>): string {
    const sources = [
      s3deploy.Source.asset(FRONTEND_DIST),
      s3deploy.Source.jsonData("config.json", runtimeConfig),
    ];

    if (config.hostingMode === "existing-bucket") {
      // Deploy INTO an existing site bucket under a sub-folder; never touch the
      // rest of the bucket (prune: false). The app must be BUILT with base
      // "/<prefix>/" — frontend/vite.config.ts reads SITE_PATH_PREFIX to do that.
      if (!config.siteBucketName) {
        throw new Error("HOSTING_MODE=existing-bucket requires SITE_BUCKET_NAME");
      }
      const bucket = s3.Bucket.fromBucketName(this, "ExistingSiteBucket", config.siteBucketName);
      new s3deploy.BucketDeployment(this, "DeploySite", {
        destinationBucket: bucket,
        destinationKeyPrefix: config.sitePathPrefix,
        prune: false,
        cacheControl: [s3deploy.CacheControl.fromString("no-cache")],
        sources,
      });
      return config.siteBaseUrl;
    }

    // Default: self-contained S3 + CloudFront (+ optional custom domain).
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    let certificate: acm.ICertificate | undefined;
    let domainNames: string[] | undefined;
    let hostedZone: route53.IHostedZone | undefined;
    if (config.domainName) {
      hostedZone = route53.HostedZone.fromLookup(this, "Zone", {
        domainName: config.domainName,
      });
      domainNames = [config.domainName];
      if (config.includeWww) domainNames.push(`www.${config.domainName}`);
      certificate = new acm.Certificate(this, "SiteCert", {
        domainName: config.domainName,
        subjectAlternativeNames: config.includeWww ? [`www.${config.domainName}`] : undefined,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      });
    }

    const distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: "index.html",
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
      domainNames,
      certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    if (hostedZone && config.domainName) {
      new route53.ARecord(this, "AliasRecord", {
        zone: hostedZone,
        recordName: config.domainName,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
      });
      if (config.includeWww) {
        new route53.ARecord(this, "WwwAliasRecord", {
          zone: hostedZone,
          recordName: `www.${config.domainName}`,
          target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
        });
      }
    }

    new s3deploy.BucketDeployment(this, "DeploySite", {
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
      sources,
    });

    new CfnOutput(this, "CloudFrontUrl", {
      value: `https://${distribution.distributionDomainName}`,
    });
    return config.domainName
      ? `https://${config.domainName}`
      : `https://${distribution.distributionDomainName}`;
  }
}
