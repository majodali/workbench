/**
 * Executable evaluation with a shared top-level namespace.
 *
 * Every executable is parsed with acorn, its top-level declarations are
 * collected, and the code is run inside `with (scope)` so that names defined
 * by other executables resolve at call time. After the code runs, its own
 * top-level declarations are copied onto the shared scope object, making them
 * visible to every other executable on the page.
 *
 * ES import statements are rewritten to dynamic `await import(...)` because
 * the code runs through the Function constructor (which cannot contain static
 * imports). Imported bindings are exported to the shared scope like any other
 * top-level declaration.
 *
 * Known limitations (documented in README):
 *  - 'use strict' at the top of an executable is not supported (`with` is
 *    a sloppy-mode construct).
 *  - A top-level `return` skips exporting that executable's definitions.
 *  - `export` statements are rejected; everything top-level is shared anyway.
 */

import * as acorn from '../vendor/acorn.mjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** Create a shared scope and the proxy that backs `with` lookups. */
export function createScope() {
  const scope = Object.create(null);
  const proxy = new Proxy(scope, {
    has(target, key) {
      // Names present in the scope resolve here; everything else falls
      // through to the executable's own bindings and then the globals.
      return key in target;
    },
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      return target[key];
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  return { scope, proxy };
}

function collectPatternNames(pattern, names) {
  switch (pattern.type) {
    case 'Identifier':
      names.push(pattern.name);
      break;
    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        collectPatternNames(prop.type === 'RestElement' ? prop.argument : prop.value, names);
      }
      break;
    case 'ArrayPattern':
      for (const el of pattern.elements) {
        if (el) collectPatternNames(el, names);
      }
      break;
    case 'AssignmentPattern':
      collectPatternNames(pattern.left, names);
      break;
    case 'RestElement':
      collectPatternNames(pattern.argument, names);
      break;
    default:
      break;
  }
}

function rewriteImport(node, names) {
  const src = node.source.raw;
  if (node.specifiers.length === 0) return `await import(${src});`;
  const parts = [];
  const tmp = `__mod_${node.start}`;
  parts.push(`const ${tmp} = await import(${src});`);
  for (const spec of node.specifiers) {
    const local = spec.local.name;
    if (spec.type === 'ImportNamespaceSpecifier') {
      parts.push(`const ${local} = ${tmp};`);
    } else if (spec.type === 'ImportDefaultSpecifier') {
      parts.push(`const ${local} = ${tmp}.default;`);
    } else {
      const imported =
        spec.imported.type === 'Literal' ? spec.imported.raw : JSON.stringify(spec.imported.name);
      parts.push(`const ${local} = ${tmp}[${imported}];`);
    }
    names.push(local);
  }
  return parts.join(' ');
}

/**
 * Compile executable source into an invokable form.
 * Returns { names, invoke(scopeCtx, event) } where `names` are the top-level
 * bindings the executable contributes to the shared scope.
 */
export function compile(code, { name = 'executable' } = {}) {
  let ast;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
    });
  } catch (err) {
    const e = new SyntaxError(`${name}: ${err.message}`);
    e.cause = err;
    throw e;
  }

  const names = [];
  const rewrites = [];

  for (const node of ast.body) {
    switch (node.type) {
      case 'VariableDeclaration':
        for (const decl of node.declarations) collectPatternNames(decl.id, names);
        break;
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
        if (node.id) names.push(node.id.name);
        break;
      case 'ImportDeclaration':
        rewrites.push({ start: node.start, end: node.end, text: rewriteImport(node, names) });
        break;
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
      case 'ExportAllDeclaration':
        throw new SyntaxError(
          `${name}: export statements are not supported — every top-level declaration is already shared with other executables.`
        );
      default:
        break;
    }
  }

  // Notebook-style result echo: if the last top-level statement is an
  // expression, capture its value so the editor can display it.
  const last = ast.body[ast.body.length - 1];
  if (last && last.type === 'ExpressionStatement') {
    const expr = code.slice(last.expression.start, last.expression.end);
    rewrites.push({ start: last.start, end: last.end, text: `__result = (${expr});` });
  }

  rewrites.sort((a, b) => a.start - b.start);
  let transformed = code;
  for (const r of rewrites.reverse()) {
    transformed = transformed.slice(0, r.start) + r.text + transformed.slice(r.end);
  }

  const unique = [...new Set(names)];
  const exportStmt = unique.length ? `;__export({ ${unique.join(', ')} });` : '';
  const body = `var __result;\nwith (__scope) {\n${transformed}\n${exportStmt}\n}\nreturn __result;`;

  let fn;
  try {
    fn = new AsyncFunction('__scope', '__export', 'event', body);
  } catch (err) {
    const e = new SyntaxError(`${name}: ${err.message}`);
    e.cause = err;
    throw e;
  }

  return {
    names: unique,
    async invoke({ scope, proxy }, event) {
      return fn(proxy, (exported) => Object.assign(scope, exported), event);
    },
  };
}
