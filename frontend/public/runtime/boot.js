/**
 * Page boot core, shared by the editor's page runtime (runtime.js) and the
 * standalone viewer embedded in published pages. Owns the shared scope, the
 * runtime API, and the boot sequence: render page HTML, create data
 * components, run definitions in order, attach handlers.
 *
 * Editor-specific concerns — console capture, postMessage, data-change
 * reporting — stay in runtime.js; the viewer runs this core with defaults.
 */

import { compile, createScope } from './evaluate.js';
import { DataRegistry } from './data.js';
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

function parseWatchList(watch) {
  return String(watch || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param root      element the page HTML renders into
 * @param reportError (err, origin) => void
 * @param withOrigin  async (name, fn) — runs fn with `name` as the current
 *                    executable for console/error attribution (editor only)
 */
export function createPageRuntime({
  root,
  reportError = (err, origin) => console.error(origin ? `[${origin}]` : '', err),
  withOrigin = async (name, fn) => fn(),
}) {
  let scopeCtx = null;
  let registry = null;
  let handlerUnsubs = [];

  function buildScope() {
    scopeCtx = createScope();
    registry = new DataRegistry();
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
      pageRoot: root,
    };
    Object.assign(scopeCtx.scope, api);
  }

  async function runExecutable(component, event) {
    const name = component.name || component.id;
    const compiled = await compile(component.code ?? '', { name, lang: component.lang });
    return withOrigin(name, () => compiled.invoke(scopeCtx, event));
  }

  async function boot(project) {
    for (const unsub of handlerUnsubs) unsub();
    handlerUnsubs = [];

    root.innerHTML = project.page?.html ?? '';
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
        const handlerName = c.name || c.id;
        if (!targets.length) {
          reportError(
            new Error(`handler "${handlerName}" watches nothing — set its "watch" field to data component names`),
            handlerName
          );
          continue;
        }
        let compiled;
        try {
          compiled = await compile(c.code ?? '', { name: handlerName, lang: c.lang });
        } catch (err) {
          reportError(err, handlerName);
          continue;
        }
        for (const target of targets) {
          const d = registry.get(target);
          if (!d) {
            reportError(
              new Error(`handler "${handlerName}" watches unknown data component "${target}"`),
              handlerName
            );
            continue;
          }
          handlerUnsubs.push(
            d.observe(async (event) => {
              try {
                await withOrigin(handlerName, () => compiled.invoke(scopeCtx, event));
              } catch (err) {
                reportError(err, handlerName);
              }
            })
          );
        }
      }
    }

    return registry;
  }

  return {
    boot,
    runExecutable,
    get registry() {
      return registry;
    },
  };
}
