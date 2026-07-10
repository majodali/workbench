/**
 * Built-in sample project: a counter demonstrating all four executable
 * concerns — definitions, a computed data component, a manual script, and a
 * change handler.
 *
 * Code bodies are stored as line arrays so the sample source can freely use
 * backticks and ${} without escaping noise here.
 */

const definitionsCode = [
  '// Runs on page load. Everything defined at the top level here is',
  '// visible to every other executable on the page.',
  '',
  'const increment = (n = 1) => count.set(count.value + n);',
  '',
  "computed('parity', [count], (n) => (n % 2 === 0 ? 'even' : 'odd'));",
  '',
  "defineComponent('counter-view', {",
  '  watch: () => [count, parity],',
  '  styles: `',
  '    .counter { display: flex; align-items: center; gap: 12px; font-size: 28px; }',
  '    button { width: 40px; height: 40px; font-size: 20px; cursor: pointer; border-radius: 8px;',
  '             border: 1px solid #8884; background: transparent; }',
  '    button:hover { background: #8882; }',
  '    .value { min-width: 3ch; text-align: center; font-variant-numeric: tabular-nums; }',
  '    .parity { color: #888; font-size: 14px; margin-top: 6px; }',
  '  `,',
  '  render() {',
  '    return html`',
  '      <div class="counter">',
  '        <button @click=${() => increment(-1)}>−</button>',
  '        <span class="value">${count.value}</span>',
  '        <button @click=${() => increment(1)}>+</button>',
  '      </div>',
  '      <div class="parity">count is ${parity.value}</div>',
  '    `;',
  '  },',
  '});',
].join('\n');

const resetCode = [
  '// A script: runs only when you press Run.',
  'count.set(0);',
  "console.log('count reset');",
].join('\n');

const handlerCode = [
  '// A handler: runs whenever a watched data component changes.',
  '// The change is available as `event` ({ name, value, oldValue }).',
  'console.log(`count: ${event.oldValue} → ${event.value}`);',
].join('\n');

const pageHtml = [
  '<h1>Counter</h1>',
  '<counter-view></counter-view>',
  '<p>',
  '  Select an executable on the left to edit it. Run the “reset count” script,',
  '  click the buttons above, and watch the console and data panels.',
  '</p>',
].join('\n');

export function sampleProject() {
  return {
    version: 1,
    name: 'Counter demo',
    page: { html: pageHtml },
    components: [
      { id: 'data-count', type: 'data', name: 'count', initial: 0 },
      { id: 'exec-defs', type: 'executable', mode: 'definition', name: 'definitions', code: definitionsCode },
      { id: 'exec-reset', type: 'executable', mode: 'script', name: 'reset count', code: resetCode },
      { id: 'exec-log', type: 'executable', mode: 'handler', name: 'log changes', watch: 'count', code: handlerCode },
    ],
  };
}

export function emptyProject() {
  return {
    version: 1,
    name: 'Untitled project',
    page: { html: '<h1>New page</h1>' },
    components: [
      {
        id: crypto.randomUUID(),
        type: 'executable',
        mode: 'definition',
        name: 'definitions',
        code: '// Top-level definitions here are visible to all executables.\n',
      },
    ],
  };
}
