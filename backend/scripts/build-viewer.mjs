/**
 * Build the self-contained viewer template for published pages.
 *
 * Bundles src/viewer/entry.js — which pulls in the shared runtime core from
 * frontend/public/runtime/ and the vendored lit-html + acorn — into a single
 * ES module, and inlines it into src/viewer/template.html. The result,
 * src/generated/viewer.html, still contains the {{TITLE}} and
 * {{PROJECT_JSON}} placeholders that the publish Lambda fills per page.
 *
 * Run via `npm run build:viewer` (CI runs it before typecheck-independent
 * synth; the Lambda bundle inlines the generated file as text).
 */

import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, "..");

const result = await esbuild.build({
  entryPoints: [path.join(backendRoot, "src/viewer/entry.js")],
  bundle: true,
  format: "esm",
  minify: true,
  write: false,
  target: "es2022",
  legalComments: "none",
});

const js = result.outputFiles[0].text;
// The bundle is inlined into a <script> block, so it must not contain a
// closing script tag. Escaping is only safe outside string/regex literals,
// so assert instead — minified esbuild output doesn't produce this sequence.
if (js.includes("</script>")) {
  throw new Error("bundled viewer JS contains '</script>' — inline embedding would break");
}

const template = readFileSync(path.join(backendRoot, "src/viewer/template.html"), "utf-8");
const html = template.replace("{{VIEWER_JS}}", () => js);

const outDir = path.join(backendRoot, "src/generated");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "viewer.html");
writeFileSync(outFile, html);

console.log(
  `viewer template: ${(html.length / 1024).toFixed(1)} KB (js ${(js.length / 1024).toFixed(1)} KB) → ${path.relative(process.cwd(), outFile)}`
);
