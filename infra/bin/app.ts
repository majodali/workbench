#!/usr/bin/env node
import * as dotenv from "dotenv";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { AppStack } from "../lib/app-stack";
import { loadConfig } from "../lib/config";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const config = loadConfig();
const app = new cdk.App();

new AppStack(app, `${config.appName}-stack`, {
  env: { account: config.account, region: config.region },
  config,
  description: `${config.appName} — interactive page development environment`,
});
