/**
 * Page runtime — runs inside the editor's sandboxed iframe.
 *
 * Wraps the shared boot core (boot.js) with the editor-facing concerns:
 * console capture, error reporting, data-change notifications, and the
 * postMessage protocol. The editor reloads this frame to apply definition
 * changes (fresh realm, so custom elements can be re-registered and stale
 * listeners disappear).
 */

import { createPageRuntime } from './boot.js';
import { DataComponent, DataRegistry } from './data.js';

const post = (msg) => window.parent.postMessage({ source: 'contraption-runtime', ...msg }, '*');

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
// Change notifications for the editor's data inspector.

DataComponent.onAnyChange = (event) =>
  post({ type: 'data-change', name: event.name, value: serialize(event.value) });
DataComponent.onListenerError = (err, d) => reportError(err, `observe ${d.name}`);
DataRegistry.onDefine = (d) => post({ type: 'data-change', name: d.name, value: serialize(d.value) });

// ---------------------------------------------------------------------------
// The page runtime itself.

const runtime = createPageRuntime({
  root: document.getElementById('page-root'),
  reportError,
  withOrigin: async (name, fn) => {
    const prev = currentOrigin;
    currentOrigin = name;
    try {
      return await fn();
    } finally {
      currentOrigin = prev;
    }
  },
});

window.addEventListener('message', async (e) => {
  const msg = e.data;
  if (!msg || msg.source !== 'contraption-editor') return;

  if (msg.type === 'load-project') {
    try {
      const registry = await runtime.boot(msg.project);
      const snapshot = {};
      for (const [name, d] of registry.map) snapshot[name] = serialize(d.value);
      post({ type: 'loaded', data: snapshot });
    } catch (err) {
      reportError(err, 'page');
    }
  } else if (msg.type === 'run-executable') {
    if (!runtime.registry) return;
    const c = msg.component;
    try {
      const result = await runtime.runExecutable(c);
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
