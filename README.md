# Contraption — an interactive page-based development environment

Build pages like machines: wire parts together and watch them run. Contraption
is a browser-based environment, in the spirit of coding notebooks, where each
project is built around a **page**. The page is assembled from components you
can view, edit, and run live:

- **Executables** — editable JavaScript with three roles:
  - **definitions** run on page load; every top-level declaration becomes
    visible to every other executable on the page,
  - **scripts** run manually from the editor,
  - **handlers** run automatically when watched data components change.
- **Data components** — named observable values supporting observe/change
  events, plus derived (computed) values.
- **UI components** — custom HTML elements rendered with lit-html, defined in
  executables and placed as tags in the page HTML.
- **Custom components** — assemblies of the above wired together *(planned,
  see roadmap)*.

Data and UI components can be declared in the project document **or** created
from executable code (`data(...)`, `computed(...)`, `defineComponent(...)`).
The executables themselves are not visible on the page — they are viewed and
edited through the editor, which is deliberately a separate, replaceable
shell around the page runtime.

## Quick start

```sh
npm install
npm run dev        # Vite dev server for the editor
```

The editor loads a sample counter project that exercises every component kind:
click the counter buttons, run the “reset count” script, edit the definitions
and press **⟳ reload page**.

Other commands (the scripts contract follows
[majodali/serverless-web-app-template](https://github.com/majodali/serverless-web-app-template)):

```sh
npm run typecheck        # tsc over frontend (checkJs) and infra
npm run build:frontend   # production build to frontend/dist
npm test                 # build + end-to-end smoke test in headless Chromium
npm run synth            # synthesize the CloudFormation (no AWS needed)
npm run deploy           # build + cdk deploy (see DEPLOY.md)
```

To deploy, see **[DEPLOY.md](./DEPLOY.md)** (local) or
**[docs/CI_DEPLOY.md](./docs/CI_DEPLOY.md)** (GitHub Actions + OIDC —
including `existing-bucket` mode for deploying into a sub-folder of an
existing site).

## Design decisions

These were settled up front; the rest of the architecture follows from them.

1. **Hybrid execution model.** Definition executables run imperatively, in
   document order, into a shared namespace. Liveness comes from the data
   components: anything that should update on screen flows through them. This
   avoids building a full reactive-dataflow runtime (Observable-style) while
   dodging the worst of the notebook hidden-state problem — when definitions
   change, you reload the page, which rebuilds the entire realm from the
   document. Scripts, by contrast, always run their latest code with no
   reload.

2. **Web Components + lit-html.** UI components are real custom elements, so
   “custom HTML tags in the page” works with no framework. lit-html (vendored,
   buildless) provides templating and efficient re-render. Components
   re-render when watched data components change.

3. **User code runs in an iframe, never in the editor.** The editor and the
   page runtime communicate only via `postMessage`. Reloading the iframe is
   the clean-reset story — a fresh realm means custom elements can be
   re-registered and stale listeners vanish. (The iframe currently uses
   `sandbox="allow-scripts allow-same-origin"` so module scripts load from
   the same static host; hard origin isolation is on the roadmap.)

4. **Client-only persistence, one JSON document per project.** The project —
   page HTML plus all component definitions, code as strings — is a single
   JSON document, autosaved to localStorage and exportable/importable as a
   file. Git-friendly when exported; a backend can come later without
   changing the format.

## How the shared namespace works

Each executable is parsed with [acorn](https://github.com/acornjs/acorn) and
compiled into an async function whose body is wrapped in `with (scope)`,
where `scope` is a per-page object behind a `Proxy`:

- Reads of names defined by *other* executables resolve through the proxy at
  call time — so definition order only matters for code that runs at
  definition time, not for calls made later.
- After an executable runs, its own top-level declarations (`const`, `let`,
  `function`, `class`, destructured bindings, imports) are copied onto the
  shared scope.
- Static `import` statements are rewritten to dynamic `await import(...)`, so
  executables can import external modules by URL. Top-level `await` works.
- If the last top-level statement is an expression, its value is echoed to
  the editor console, notebook-style.

Known limitations of this scheme (all reported as errors or documented):
`'use strict'` prologues are unsupported (`with` is sloppy-mode); a top-level
`return` skips sharing that executable's definitions; `export` statements are
rejected (everything top-level is shared anyway); bare module specifiers need
full URLs until import-map support lands.

## Runtime API (available in every executable)

| Name | Description |
| --- | --- |
| `data(name, initial)` | Create/get a named observable value. Idempotent. |
| `computed(name, [deps], fn)` | Data component derived from others; recomputes on any dependency change. |
| `defineComponent(tag, opts)` | Register a custom element. `opts`: `render()` (lit-html template, `this` is the element), `watch` (array or function returning data components that trigger re-render), `styles` (CSS string), `connected`/`disconnected`, `shadow` (default `true`). |
| `html`, `svg`, `render`, `nothing` | lit-html templating. |
| `live`, `repeat`, `classMap`, `styleMap`, `when`, `ifDefined`, `ref`, `unsafeHTML` | Common lit-html directives. |
| `dataRegistry` | All data components on the page (`get`, `snapshot`). |
| `pageRoot` | The DOM element containing the page HTML. |
| `event` | In handlers: `{ name, value, oldValue, target }` for the change that fired. |

Data components: `d.value` (get/set), `d.set(v)`, `d.update(fn)`,
`d.observe(fn, {immediate})` → unsubscribe, `d.touch()` (notify after
in-place mutation). Observation is **shallow** — replace values rather than
mutating them, so “what triggered this change?” stays answerable.

## Architecture

The repo follows the
[serverless-web-app-template](https://github.com/majodali/serverless-web-app-template)
layout (npm workspaces):

```
frontend/
├── index.html, src/editor/     the editor shell (lit-html UI, no user code)
│           │  postMessage: load-project / run-executable
│           │              ready / loaded / console / data-change / ran
│           ▼
└── public/                     served VERBATIM (never bundled):
    ├── runtime/page.html + runtime.js   the page realm (sandboxed iframe)
    │   ├── boot.js             shared boot core (also used by the viewer)
    │   ├── evaluate.js         acorn parse → with(scope) compile → invoke
    │   ├── data.js             DataComponent / DataRegistry (+computed)
    │   └── ui.js               defineComponent (custom elements + lit-html)
    └── vendor/                 lit-html and acorn for the page realm
backend/                        Lambdas: site-wide auth (/auth/*) + page publishing
├── src/viewer/ + scripts/      self-contained viewer template for published pages
infra/                          AWS CDK: tables, API, hosting, admin seeding
tests/smoke.js                  end-to-end test in headless Chromium
.github/workflows/              CI (PR checks) and Deploy (OIDC, on main)
```

The split matters: the **editor** is bundled by Vite like a normal app, but
`frontend/public/runtime/` and `frontend/public/vendor/` are copied verbatim —
the page realm loads them by URL on every reload, and **user executables can
import them by URL too** (e.g. `import '../vendor/lit-html/lit-html.js'`), so
they must stay plain ESM at stable, unhashed paths. The two realms each get
their own lit-html instance, which is fine — they never share objects, only
postMessage.

Boot sequence on load/reload: render page HTML into the iframe → build the
shared scope and inject the runtime API → create declared data components →
run definition executables in order → attach handlers → report `loaded`.

## Publishing and auth

Signed-in users can **publish** a project from the editor toolbar: the backend
renders it into a fully self-contained HTML file (runtime + lit-html + acorn +
the project document inlined — no external dependencies, pages never break
when the platform changes) and writes it to the site bucket at
**`/p/<slug>/`**. Anyone can read published pages; only authenticated users
can publish. A published page embeds its project document as JSON, so the
editor can reopen any published URL for editing (`#open=/p/<slug>/`, or the
"edit" button in the publish dialog). Slugs are owned by whoever published
them first; a DynamoDB table tracks ownership and powers the "my pages" list.

Auth is **site-wide**, not Contraption-specific: admin-created accounts
(no signup), bcrypt password hashes, 30-day JWTs from app-neutral `/auth/*`
routes, and the token is stored under an origin-wide localStorage key so
future apps on the same domain share the session. The first admin is seeded
at deploy from `ADMIN_USERNAME`/`ADMIN_PASSWORD`.

> **Trust note:** published pages run arbitrary JavaScript on the site's
> origin — the same origin as everyone's auth token. That's acceptable while
> accounts are admin-created (publishers are trusted); serving published
> pages from a separate sandbox origin is the roadmap item to revisit before
> opening accounts more widely.

## Project document format

```jsonc
{
  "version": 1,
  "name": "Counter demo",
  "page": { "html": "<h1>Counter</h1><counter-view></counter-view>" },
  "components": [
    { "id": "…", "type": "data", "name": "count", "initial": 0 },
    { "id": "…", "type": "executable", "mode": "definition", "name": "definitions", "code": "…" },
    { "id": "…", "type": "executable", "mode": "script", "name": "reset count", "code": "…" },
    { "id": "…", "type": "executable", "mode": "handler", "name": "log changes", "watch": "count", "code": "…" }
  ]
}
```

## Roadmap

- **Sandbox origin for published pages** — serve `/p/*` from a separate
  domain so page code can't read the site auth token (needed before accounts
  go beyond trusted users).
- **Canvas scene graph** — multiple graphic components per canvas with draw
  order, invalidation, and hit-testing so pointer events route to the right
  component. The interface will mirror `defineComponent`.
- **Custom (composed) components** — instantiate a wired assembly of
  components with per-instance state and namespaced inner identities; the
  document format's `type` field anticipates this.
- **Import maps** — project-level bare-specifier resolution for external
  modules.
- **Hard sandbox isolation** — opaque-origin iframe (or separate host) so
  runaway user code cannot block the editor.
- **Editor niceties** — CodeMirror with syntax highlighting, per-executable
  console filtering, undo history/versioned saves, drag-to-reorder.
- **Replaceable editor** — the editor already talks to the runtime only via
  the message protocol; formalize it so custom editor UIs can be built from
  the environment's own UI components.
