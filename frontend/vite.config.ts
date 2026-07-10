import * as path from "node:path";
import { defineConfig } from "vite";
import * as dotenv from "dotenv";

// A single infra/.env drives both the CDK stack and the app's base path. In CI
// the same values come from repo Variables (process.env), which take precedence.
dotenv.config({ path: path.resolve(process.cwd(), "../infra/.env") });

function basePath(): string {
  if (process.env.HOSTING_MODE === "existing-bucket") {
    const prefix = (process.env.SITE_PATH_PREFIX || process.env.APP_NAME || "")
      .replace(/[^a-zA-Z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "");
    if (prefix) return `/${prefix}/`;
  }
  return "/";
}

// The editor shell is bundled; runtime/ and vendor/ live in public/ and are
// copied verbatim — the page realm and user executables load them by URL, so
// they must stay plain ESM at stable paths.
export default defineConfig({
  base: basePath(),
  build: { outDir: "dist" },
});
