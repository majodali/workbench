/**
 * Editor shell. Owns the project document, renders the component list and
 * editors with lit-html, and talks to the page runtime iframe over
 * postMessage. All user code executes in the iframe, never here.
 */

import { html, render, nothing } from 'lit-html';
import { live } from 'lit-html/directives/live.js';
import { repeat } from 'lit-html/directives/repeat.js';
import { classMap } from 'lit-html/directives/class-map.js';
import { sampleProject, emptyProject } from './samples.js';
import './editor.css';

// Namespaced by base path: when deployed under a sub-folder of a shared
// domain, this app must not collide with other apps' localStorage.
const STORAGE_KEY = `notebook-project:${new URL('.', location.href).pathname}`;
const PAGE_ITEM = '__page__';

// ---------------------------------------------------------------------------
// State

const state = {
  project: loadProject(),
  selectedId: PAGE_ITEM,
  console: [],
  dataValues: {},
  pageStatus: 'loading', // loading | running
  stale: false, // definitions changed since last reload
};

function loadProject() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const doc = JSON.parse(raw);
      if (doc && Array.isArray(doc.components)) return doc;
    }
  } catch {
    /* fall through to sample */
  }
  return sampleProject();
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.project));
    } catch (err) {
      console.warn('autosave failed', err);
    }
  }, 300);
}

function mutate(fn, { needsReload = false } = {}) {
  fn();
  if (needsReload) state.stale = true;
  persist();
  update();
}

function selected() {
  if (state.selectedId === PAGE_ITEM) return null;
  return state.project.components.find((c) => c.id === state.selectedId) ?? null;
}

// ---------------------------------------------------------------------------
// Runtime iframe messaging

const iframe = () =>
  /** @type {HTMLIFrameElement | null} */ (document.getElementById('page-frame'));

function postToRuntime(msg) {
  iframe()?.contentWindow?.postMessage({ source: 'nb-editor', ...msg }, '*');
}

function reloadPage() {
  state.pageStatus = 'loading';
  state.dataValues = {};
  update();
  const frame = iframe();
  // Reassigning src reloads the frame; the runtime posts 'ready' when it
  // boots and we send the project in response.
  frame.src = frame.getAttribute('src');
}

function runComponent(c) {
  if (state.pageStatus !== 'running') return;
  postToRuntime({ type: 'run-executable', component: { id: c.id, name: c.name, code: c.code } });
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg || msg.source !== 'nb-runtime') return;

  switch (msg.type) {
    case 'ready':
      postToRuntime({ type: 'load-project', project: state.project });
      break;
    case 'loaded':
      state.pageStatus = 'running';
      state.stale = false;
      state.dataValues = msg.data ?? {};
      break;
    case 'console':
      state.console.push({ level: msg.level, text: msg.text, origin: msg.origin, ts: Date.now() });
      if (state.console.length > 500) state.console.splice(0, state.console.length - 500);
      break;
    case 'data-change':
      state.dataValues = { ...state.dataValues, [msg.name]: msg.value };
      break;
    default:
      break;
  }
  update();
});

// ---------------------------------------------------------------------------
// Actions

function addComponent(kind) {
  const id = crypto.randomUUID();
  let component;
  if (kind === 'data') {
    component = { id, type: 'data', name: uniqueName('value'), initial: null };
  } else {
    component = {
      id,
      type: 'executable',
      mode: kind, // definition | script | handler
      name: uniqueName(kind),
      code: '',
      ...(kind === 'handler' ? { watch: '' } : {}),
    };
  }
  mutate(
    () => {
      state.project.components.push(component);
      state.selectedId = id;
    },
    { needsReload: kind !== 'script' }
  );
}

function uniqueName(base) {
  const names = new Set(state.project.components.map((c) => c.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

function deleteComponent(c) {
  if (!confirm(`Delete "${c.name}"?`)) return;
  mutate(
    () => {
      state.project.components = state.project.components.filter((x) => x.id !== c.id);
      if (state.selectedId === c.id) state.selectedId = PAGE_ITEM;
    },
    { needsReload: true }
  );
}

function moveComponent(c, delta) {
  mutate(
    () => {
      const list = state.project.components;
      const i = list.indexOf(c);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
    },
    { needsReload: true }
  );
}

function exportProject() {
  const blob = new Blob([JSON.stringify(state.project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.project.name || 'project'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importProject(file) {
  file.text().then((text) => {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      alert('Not valid JSON.');
      return;
    }
    if (!doc || !Array.isArray(doc.components)) {
      alert('Not a project file (missing components array).');
      return;
    }
    mutate(() => {
      state.project = doc;
      state.selectedId = PAGE_ITEM;
      state.console = [];
    });
    reloadPage();
  });
}

function replaceProject(doc) {
  mutate(() => {
    state.project = doc;
    state.selectedId = PAGE_ITEM;
    state.console = [];
  });
  reloadPage();
}

// ---------------------------------------------------------------------------
// Views

const MODE_LABELS = { definition: 'definition — runs on page load', script: 'script — run manually', handler: 'handler — runs on data changes' };
const MODE_BADGES = { definition: 'def', script: 'run', handler: 'on' };

function sidebarView() {
  return html`
    <div class="sidebar">
      <div class="sidebar-list">
        <div
          class=${classMap({ item: true, selected: state.selectedId === PAGE_ITEM })}
          @click=${() => {
            state.selectedId = PAGE_ITEM;
            update();
          }}
        >
          <span class="badge badge-page">page</span>
          <span class="item-name">Page HTML</span>
        </div>
        ${repeat(
          state.project.components,
          (c) => c.id,
          (c) => html`
            <div
              class=${classMap({ item: true, selected: state.selectedId === c.id })}
              @click=${() => {
                state.selectedId = c.id;
                update();
              }}
            >
              <span class="badge ${c.type === 'data' ? 'badge-data' : `badge-${c.mode}`}">
                ${c.type === 'data' ? 'data' : MODE_BADGES[c.mode] ?? '?'}
              </span>
              <span class="item-name">${c.name}</span>
            </div>
          `
        )}
      </div>
      <div class="sidebar-actions">
        <span class="sidebar-actions-label">add</span>
        <button title="Definition executable — runs on page load" @click=${() => addComponent('definition')}>+ def</button>
        <button title="Script executable — run manually" @click=${() => addComponent('script')}>+ script</button>
        <button title="Handler executable — runs on data changes" @click=${() => addComponent('handler')}>+ handler</button>
        <button title="Data component" @click=${() => addComponent('data')}>+ data</button>
      </div>
    </div>
  `;
}

function codeKeydown(c, e) {
  if (e.key === 'Tab') {
    e.preventDefault();
    const t = e.target;
    const { selectionStart: s, selectionEnd: end } = t;
    t.setRangeText('  ', s, end, 'end');
    t.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && c?.type === 'executable') {
    e.preventDefault();
    runComponent(c);
  }
}

function pageEditorView() {
  return html`
    <div class="editor-pane">
      <div class="editor-header">
        <span class="editor-title">Page HTML</span>
        <span class="hint">The page body. Custom tags defined by executables can be used here.</span>
      </div>
      <textarea
        class="code"
        spellcheck="false"
        .value=${live(state.project.page?.html ?? '')}
        @keydown=${(e) => codeKeydown(null, e)}
        @input=${(e) =>
          mutate(
            () => {
              state.project.page = { ...(state.project.page ?? {}), html: e.target.value };
            },
            { needsReload: true }
          )}
      ></textarea>
    </div>
  `;
}

function dataEditorView(c) {
  let initialText;
  try {
    initialText = JSON.stringify(c.initial);
  } catch {
    initialText = 'null';
  }
  return html`
    <div class="editor-pane">
      <div class="editor-header">
        <input
          class="name-input"
          .value=${live(c.name)}
          @input=${(e) => mutate(() => (c.name = e.target.value), { needsReload: true })}
        />
        <span class="hint">data component — observable named value</span>
        <span class="spacer"></span>
        <button class="danger" @click=${() => deleteComponent(c)}>delete</button>
      </div>
      <label class="field-label">initial value (JSON)</label>
      <textarea
        class="code small"
        spellcheck="false"
        .value=${live(initialText ?? 'null')}
        @input=${(e) => {
          try {
            const v = JSON.parse(e.target.value);
            mutate(() => (c.initial = v), { needsReload: true });
            e.target.classList.remove('invalid');
          } catch {
            e.target.classList.add('invalid');
          }
        }}
      ></textarea>
      <p class="hint">
        Current value on the page: <code>${state.dataValues[c.name] ?? '(not loaded)'}</code>
      </p>
    </div>
  `;
}

function executableEditorView(c) {
  return html`
    <div class="editor-pane">
      <div class="editor-header">
        <input
          class="name-input"
          .value=${live(c.name)}
          @input=${(e) => mutate(() => (c.name = e.target.value), { needsReload: c.mode !== 'script' })}
        />
        <select
          .value=${live(c.mode)}
          @change=${(e) => mutate(() => (c.mode = e.target.value), { needsReload: true })}
        >
          <option value="definition">${MODE_LABELS.definition}</option>
          <option value="script">${MODE_LABELS.script}</option>
          <option value="handler">${MODE_LABELS.handler}</option>
        </select>
        ${c.mode === 'handler'
          ? html`<input
              class="watch-input"
              placeholder="watch: data names, comma-separated"
              .value=${live(c.watch ?? '')}
              @input=${(e) => mutate(() => (c.watch = e.target.value), { needsReload: true })}
            />`
          : nothing}
        <span class="spacer"></span>
        <button
          title="Run this code now (Ctrl/Cmd+Enter)"
          ?disabled=${state.pageStatus !== 'running'}
          @click=${() => runComponent(c)}
        >
          ▶ run
        </button>
        <button class="danger" @click=${() => deleteComponent(c)}>delete</button>
      </div>
      <textarea
        class="code"
        spellcheck="false"
        .value=${live(c.code ?? '')}
        @keydown=${(e) => codeKeydown(c, e)}
        @input=${(e) => mutate(() => (c.code = e.target.value), { needsReload: c.mode !== 'script' })}
      ></textarea>
      <div class="editor-footer">
        <button @click=${() => moveComponent(c, -1)}>↑ move up</button>
        <button @click=${() => moveComponent(c, 1)}>↓ move down</button>
        <span class="hint">
          ${c.mode === 'definition'
            ? 'Definitions run in list order on page load — reload to apply edits.'
            : c.mode === 'handler'
              ? 'Handlers attach on page load — reload to apply edits.'
              : 'Scripts always run their latest code.'}
        </span>
      </div>
    </div>
  `;
}

function editorView() {
  const c = selected();
  if (!c) return pageEditorView();
  return c.type === 'data' ? dataEditorView(c) : executableEditorView(c);
}

function dataPanelView() {
  const entries = Object.entries(state.dataValues);
  return html`
    <div class="panel">
      <div class="panel-title">data</div>
      ${entries.length
        ? html`<table class="data-table">
            ${entries.map(([name, value]) => html`<tr><td class="data-name">${name}</td><td class="data-value">${value}</td></tr>`)}
          </table>`
        : html`<div class="hint pad">No data components yet.</div>`}
    </div>
  `;
}

function consolePanelView() {
  return html`
    <div class="panel console-panel">
      <div class="panel-title">
        console
        <span class="spacer"></span>
        <button class="mini" @click=${() => { state.console = []; update(); }}>clear</button>
      </div>
      <div class="console-scroll" id="console-scroll">
        ${state.console.map(
          (entry) => html`
            <div class="console-line level-${entry.level}">
              ${entry.origin ? html`<span class="console-origin">${entry.origin}</span>` : nothing}
              <span class="console-text">${entry.text}</span>
            </div>
          `
        )}
      </div>
    </div>
  `;
}

function toolbarView() {
  return html`
    <header class="toolbar">
      <span class="logo">◳ notebook</span>
      <input
        class="project-name"
        .value=${live(state.project.name ?? '')}
        @input=${(e) => mutate(() => (state.project.name = e.target.value))}
      />
      <button class=${classMap({ primary: state.stale })} @click=${reloadPage}>
        ⟳ reload page${state.stale ? ' (stale)' : ''}
      </button>
      <span class="status ${state.pageStatus}">${state.pageStatus}</span>
      <span class="spacer"></span>
      <button @click=${exportProject}>export</button>
      <label class="button-like">
        import
        <input
          type="file"
          accept="application/json,.json"
          hidden
          @change=${(e) => {
            if (e.target.files[0]) importProject(e.target.files[0]);
            e.target.value = '';
          }}
        />
      </label>
      <button @click=${() => confirm('Replace the current project with the sample?') && replaceProject(sampleProject())}>
        sample
      </button>
      <button @click=${() => confirm('Replace the current project with a new empty one?') && replaceProject(emptyProject())}>
        new
      </button>
    </header>
  `;
}

function appView() {
  return html`
    ${toolbarView()}
    <main class="layout">
      ${sidebarView()} ${editorView()}
      <div class="preview">
        <iframe id="page-frame" src="runtime/page.html" sandbox="allow-scripts allow-same-origin"></iframe>
        ${dataPanelView()} ${consolePanelView()}
      </div>
    </main>
  `;
}

function update() {
  render(appView(), document.getElementById('app'));
  const scroll = document.getElementById('console-scroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

update();
