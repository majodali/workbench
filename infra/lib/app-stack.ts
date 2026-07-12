import * as path from "node:path";
import {
  Stack,
  StackProps,
  RemovalPolicy,
  Duration,
  CfnOutput,
  CustomResource,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwInteg from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as customResources from "aws-cdk-lib/custom-resources";
import * as logs from "aws-cdk-lib/aws-logs";
import type { AppConfig } from "./config";

const BACKEND = path.join(__dirname, "..", "..", "backend", "src");
const FRONTEND_DIST = path.join(__dirname, "..", "..", "frontend", "dist");

/** Key prefix in the site bucket that published pages are written under. */
const PAGES_PREFIX = "p";

export interface AppStackProps extends StackProps {
  config: AppConfig;
}

/**
 * The Contraption stack: site-wide auth (template-style admin-created
 * accounts, bcrypt + JWT), the page-publishing API, and frontend hosting.
 * Auth routes are deliberately app-neutral (/auth/*) so other apps on the
 * site can share the mechanism.
 */
export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { config } = props;

    // ---- Site bucket (publish target + hosting target) ----
    // existing-bucket mode: your site's bucket. cloudfront mode: our own.
    const siteBucket =
      config.hostingMode === "existing-bucket"
        ? s3.Bucket.fromBucketName(this, "ExistingSiteBucket", requireBucket(config))
        : new s3.Bucket(this, "SiteBucket", {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy: RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
          });

    // ---- DynamoDB ----
    const users = new dynamodb.Table(this, "Users", {
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });
    users.addGlobalSecondaryIndex({
      indexName: "UsernameIndex",
      partitionKey: { name: "usernameLower", type: dynamodb.AttributeType.STRING },
    });

    const pages = new dynamodb.Table(this, "Pages", {
      partitionKey: { name: "slug", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    pages.addGlobalSecondaryIndex({
      indexName: "OwnerIndex",
      partitionKey: { name: "ownerId", type: dynamodb.AttributeType.STRING },
    });

    // ---- JWT signing secret ----
    const jwtSecret = new secretsmanager.Secret(this, "JwtSecret", {
      description: `${config.appName} site JWT signing secret`,
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    // ---- Lambda factory (CommonJS output — see README) ----
    const commonEnv: Record<string, string> = {
      USERS_TABLE: users.tableName,
      PAGES_TABLE: pages.tableName,
      JWT_SECRET: jwtSecret.secretValue.unsafeUnwrap(),
      SITE_BUCKET: siteBucket.bucketName,
      PAGES_PREFIX,
      NODE_OPTIONS: "--enable-source-maps",
    };

    const makeFn = (id: string, entry: string): lambdaNode.NodejsFunction => {
      const fn = new lambdaNode.NodejsFunction(this, id, {
        entry: path.join(BACKEND, entry),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_20_X,
        memorySize: 256,
        timeout: Duration.seconds(15),
        environment: commonEnv,
        logRetention: logs.RetentionDays.TWO_WEEKS,
        bundling: {
          format: lambdaNode.OutputFormat.CJS,
          target: "node20",
          minify: true,
          sourceMap: true,
          // Publish inlines the generated viewer template (build:viewer).
          loader: { ".html": "text" },
        },
      });
      users.grantReadWriteData(fn);
      pages.grantReadWriteData(fn);
      return fn;
    };

    /** Allow a function to write/delete published pages — and nothing else. */
    const grantPagesPrefix = (fn: lambdaNode.NodejsFunction) => {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["s3:PutObject", "s3:DeleteObject"],
          resources: [siteBucket.arnForObjects(`${PAGES_PREFIX}/*`)],
        })
      );
    };

    // ---- HTTP API ----
    const httpApi = new apigw.HttpApi(this, "HttpApi", {
      corsPreflight: {
        allowOrigins: ["*"],
        allowHeaders: ["Content-Type", "Authorization"],
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.DELETE,
          apigw.CorsHttpMethod.OPTIONS,
        ],
      },
    });

    const route = (
      key: string,
      method: apigw.HttpMethod,
      pathPart: string,
      entry: string
    ): lambdaNode.NodejsFunction => {
      const fn = makeFn(key + "Fn", entry);
      httpApi.addRoutes({
        path: pathPart,
        methods: [method],
        integration: new apigwInteg.HttpLambdaIntegration(key, fn),
      });
      return fn;
    };

    route("Health", apigw.HttpMethod.GET, "/health", "http/health.ts");

    // Site-wide auth — app-neutral paths, shared by future apps on the site.
    route("Login", apigw.HttpMethod.POST, "/auth/login", "http/login.ts");
    route("Me", apigw.HttpMethod.GET, "/auth/me", "http/me.ts");
    route("ChangePassword", apigw.HttpMethod.POST, "/auth/me/password", "http/changePassword.ts");
    route("Users", apigw.HttpMethod.GET, "/auth/users", "http/listUsers.ts");
    route("AdminUsers", apigw.HttpMethod.POST, "/auth/admin/users", "http/adminCreateUser.ts");
    route(
      "AdminResetPassword",
      apigw.HttpMethod.POST,
      "/auth/admin/users/{userId}/password",
      "http/adminResetPassword.ts"
    );

    // Contraption pages.
    const publishFn = route("PublishPage", apigw.HttpMethod.POST, "/pages", "http/publishPage.ts");
    route("ListPages", apigw.HttpMethod.GET, "/pages", "http/listPages.ts");
    const deleteFn = route("DeletePage", apigw.HttpMethod.DELETE, "/pages/{slug}", "http/deletePage.ts");
    grantPagesPrefix(publishFn);
    grantPagesPrefix(deleteFn);

    // Runtime config the editor fetches on load (never hardcode URLs in the build).
    const apiUrl = httpApi.apiEndpoint;
    const runtimeConfig: Record<string, string> = {
      apiUrl,
      appName: config.appName,
      pagesPrefix: PAGES_PREFIX,
    };

    // ---- Frontend hosting ----
    const siteUrl = this.deployFrontend(config, runtimeConfig, siteBucket);

    // ---- Seed the first admin (custom resource) ----
    const seedFn = makeFn("SeedAdminFn", "ops/seedAdmin.ts");
    seedFn.addEnvironment("ADMIN_USERNAME", config.adminUsername);
    seedFn.addEnvironment("ADMIN_PASSWORD", config.adminPassword);
    const seedProvider = new customResources.Provider(this, "SeedProvider", {
      onEventHandler: seedFn,
    });
    new CustomResource(this, "SeedAdmin", {
      serviceToken: seedProvider.serviceToken,
      properties: { username: config.adminUsername },
    });

    // ---- Outputs ----
    new CfnOutput(this, "SiteUrl", { value: siteUrl, description: "Open this to use the app" });
    new CfnOutput(this, "ApiUrl", { value: apiUrl });
  }

  /** Deploy the built frontend per the configured hosting mode; returns the site URL. */
  private deployFrontend(
    config: AppConfig,
    runtimeConfig: Record<string, string>,
    siteBucket: s3.IBucket
  ): string {
    const sources = [
      s3deploy.Source.asset(FRONTEND_DIST),
      s3deploy.Source.jsonData("config.json", runtimeConfig),
    ];

    if (config.hostingMode === "existing-bucket") {
      // Deploy INTO the existing site bucket under a sub-folder; never touch
      // the rest of the bucket (prune: false). The app must be BUILT with
      // base "/<prefix>/" — frontend/vite.config.ts reads SITE_PATH_PREFIX.
      new s3deploy.BucketDeployment(this, "DeploySite", {
        destinationBucket: siteBucket,
        destinationKeyPrefix: config.sitePathPrefix,
        prune: false,
        cacheControl: [s3deploy.CacheControl.fromString("no-cache")],
        sources,
      });
      return config.siteBaseUrl;
    }

    // Default: self-contained S3 + CloudFront (+ optional custom domain).
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
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket as s3.Bucket),
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

function requireBucket(config: AppConfig): string {
  if (!config.siteBucketName) {
    throw new Error("HOSTING_MODE=existing-bucket requires SITE_BUCKET_NAME");
  }
  return config.siteBucketName;
}
