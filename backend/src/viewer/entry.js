/**
 * Standalone viewer for published pages. Reads the project document embedded
 * in the page and boots it with the shared runtime core. No editor, no
 * postMessage — errors go to the browser console.
 *
 * Bundled (with the runtime and its vendored dependencies) into a single
 * self-contained HTML template by scripts/build-viewer.mjs, so published
 * pages have no external dependencies and never break when the platform
 * changes.
 */

import { createPageRuntime } from '../../../frontend/public/runtime/boot.js';

const holder = document.getElementById('contraption-project');
const project = JSON.parse(holder.textContent);

if (project.name) document.title = project.name;

const runtime = createPageRuntime({ root: document.getElementById('page-root') });
runtime.boot(project).catch((err) => console.error('contraption boot failed', err));
