/**
 * Page runtime — runs inside the sandboxed iframe.
 *
 * Boot sequence on 'load-project':
 *  1. Render the page HTML into #page-root.
 *  2. Build the shared scope and inject the runtime API into it.
 *  3. Create declared data components.
 *  4. Compile and run every 'definition' executable, in document order.
 *  5. Attach 'handler' executables to the data components they watch.
 *
 * 'script' executables run only on request from the editor.
 *
 * All communication with the editor goes through postMessage; the editor
 * reloads this frame to apply definition changes (fresh realm, so custom
 * elements can be re-registered and stale listeners disappear).
 */

import { compile, createScope } from './evaluate.js';
import { DataComponent, DataRegistry } from './data.js';
import { makeDefineComponent } from './ui.js';
import { html, svg, render, nothing } from '../vendor/lit-html/lit-html.js';
import { live } from '../vendor/lit-html/directives/live.js';
import { repeat } from '../vendor/lit-html/directives/repeat.js';
import { classMap } from '../vendor/lit-html/directives/class-map.js';
import { styleMap } from '../vendor/lit-html/directives/style-map.js';
import { when } from '../vendor/lit-html/directives/when.js';
import { ifDefined } from '../vendor/lit-html/directives/if-defined.js';
import { ref } from '../vendor/lit-html/directives/ref.js';
import { unsafeHTML } from '../vendor/lit-html/directives/unsafe-html.js';

const post = (msg) => window.parent.postMessage({ source: 'nb-runtime', ...msg }, '*');

// ---------------------------------------------------------------------------
// Serialization for console output and the data inspector.

function serialize(value, depth = 0, seen = new Set()) {
  if (value === null || value === undefined) return String(value);
  const t = typeof value;
  if (t === 'string') return depth === 0 ? value : JSON.stringify(value);
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
  if (t === 'symbol') return value.toString();
  if (t === 'function') return `[function ${value.name || '(anonymous)'}]`;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value instanceof DataComponent) return `Data(${value.name}) = ${serialize(value.value, depth + 1, seen)}`;
  if (value instanceof HTMLElement) return `<${value.tagName.toLowerCase()}>`;
  if (seen.has(value)) return '[circular]';
  if (depth > 3) return Array.isArray(value) ? '[…]' : '{…}';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, 20).map((v) => serialize(v, depth + 1, seen));
      if (value.length > 20) items.push(`… ${value.length - 20} more`);
      return `[${items.join(', ')}]`;
    }
    if (value instanceof Map) {
      return `Map(${value.size})`;
    }
    if (value instanceof Set) {
      return `Set(${value.size})`;
    }
    const entries = Object.entries(value)
      .slice(0, 20)
      .map(([k, v]) => `${k}: ${serialize(v, depth + 1, seen)}`);
    return `{${entries.join(', ')}}`;
  } finally {
    seen.delete(value);
  }
}

// ---------------------------------------------------------------------------
// Console capture and error reporting.

let currentOrigin = null; // name of the executable currently running

function emitConsole(level, args) {
  post({
    type: 'console',
    level,
    text: args.map((a) => serialize(a)).join(' '),
    origin: currentOrigin,
  });
}

for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const native = console[level].bind(console);
  console[level] = (...args) => {
    native(...args);
    emitConsole(level === 'debug' ? 'log' : level, args);
  };
}

function reportError(err, origin) {
  post({
    type: 'console',
    level: 'error',
    text: err?.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : String(err),
    origin: origin ?? currentOrigin,
  });
}

window.addEventListener('error', (e) => reportError(e.error ?? e.message, null));
window.addEventListener('unhandledrejection', (e) => reportError(e.reason, null));

// ---------------------------------------------------------------------------
// Runtime state.

let scopeCtx = null;
let registry = null;
let handlerUnsubs = [];

function buildScope() {
  scopeCtx = createScope();
  registry = new DataRegistry();

  DataComponent.onAnyChange = (event) =>
    post({ type: 'data-change', name: event.name, value: serialize(event.value) });
  DataComponent.onListenerError = (err, d) => reportError(err, `observe ${d.name}`);
  DataRegistry.onDefine = (d) =>
    post({ type: 'data-change', name: d.name, value: serialize(d.value) });

  const defineComponent = makeDefineComponent(reportError);

  const api = {
    // templating
    html,
    svg,
    render,
    nothing,
    live,
    repeat,
    classMap,
    styleMap,
    when,
    ifDefined,
    ref,
    unsafeHTML,
    // components
    defineComponent,
    data: (name, initial) => {
      const d = registry.define(name, initial);
      scopeCtx.scope[name] = d;
      return d;
    },
    computed: (name, deps, fn) => {
      const d = registry.computed(name, deps, fn);
      scopeCtx.scope[name] = d;
      return d;
    },
    dataRegistry: registry,
    pageRoot: document.getElementById('page-root'),
  };
  Object.assign(scopeCtx.scope, api);
}

async function runExecutable(component, event) {
  const name = component.name || component.id;
  const compiled = compile(component.code ?? '', { name });
  const prevOrigin = currentOrigin;
  currentOrigin = name;
  try {
    return await compiled.invoke(scopeCtx, event);
  } finally {
    currentOrigin = prevOrigin;
  }
}

function parseWatchList(watch) {
  return String(watch || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function boot(project) {
  for (const unsub of handlerUnsubs) unsub();
  handlerUnsubs = [];

  document.getElementById('page-root').innerHTML = project.page?.html ?? '';
  buildScope();

  const components = project.components ?? [];

  for (const c of components) {
    if (c.type === 'data') {
      registry.define(c.name, c.initial);
      scopeCtx.scope[c.name] = registry.get(c.name);
    }
  }

  for (const c of components) {
    if (c.type === 'executable' && c.mode === 'definition') {
      try {
        await runExecutable(c);
      } catch (err) {
        reportError(err, c.name || c.id);
      }
    }
  }

  for (const c of components) {
    if (c.type === 'executable' && c.mode === 'handler') {
      const targets = parseWatchList(c.watch);
      if (!targets.length) {
        reportError(
          new Error(`handler "${c.name}" watches nothing — set its "watch" field to data component names`),
          c.name
        );
        continue;
      }
      let compiled;
      try {
        compiled = compile(c.code ?? '', { name: c.name || c.id });
      } catch (err) {
        reportError(err, c.name || c.id);
        continue;
      }
      for (const target of targets) {
        const d = registry.get(target);
        if (!d) {
          reportError(new Error(`handler "${c.name}" watches unknown data component "${target}"`), c.name);
          continue;
        }
        const handlerName = c.name || c.id;
        handlerUnsubs.push(
          d.observe(async (event) => {
            const prevOrigin = currentOrigin;
            currentOrigin = handlerName;
            try {
              await compiled.invoke(scopeCtx, event);
            } catch (err) {
              reportError(err, handlerName);
            } finally {
              currentOrigin = prevOrigin;
            }
          })
        );
      }
    }
  }

  const snapshot = {};
  for (const [name, d] of registry.map) snapshot[name] = serialize(d.value);
  post({ type: 'loaded', data: snapshot });
}

// ---------------------------------------------------------------------------
// Editor messaging.

window.addEventListener('message', async (e) => {
  const msg = e.data;
  if (!msg || msg.source !== 'nb-editor') return;

  if (msg.type === 'load-project') {
    try {
      await boot(msg.project);
    } catch (err) {
      reportError(err, 'page');
    }
  } else if (msg.type === 'run-executable') {
    if (!scopeCtx) return;
    const c = msg.component;
    try {
      const result = await runExecutable(c);
      if (result !== undefined) {
        post({ type: 'console', level: 'result', text: serialize(result), origin: c.name || c.id });
      }
      post({ type: 'ran', id: c.id });
    } catch (err) {
      reportError(err, c.name || c.id);
      post({ type: 'ran', id: c.id, error: true });
    }
  }
});

post({ type: 'ready' });
