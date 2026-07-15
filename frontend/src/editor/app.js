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
import { api, ApiError, getToken, setToken, fetchPublishedProject } from './api.js';
import './editor.css';

// Storage keys are namespaced by base path: when deployed under a sub-folder
// of a shared domain, this app must not collide with other apps' localStorage.
// Projects live in named slots — an index plus one key per project — so
// loading a published page or importing never overwrites existing work.
const BASE_PATH = new URL('.', location.href).pathname;
const INDEX_KEY = `contraption-projects:${BASE_PATH}`;
const LEGACY_KEY = `contraption-project:${BASE_PATH}`; // pre-slots single project
const slotKey = (id) => `contraption-project:${BASE_PATH}:${id}`;
const PAGE_ITEM = '__page__';

function readSlot(id) {
  try {
    const doc = JSON.parse(localStorage.getItem(slotKey(id)));
    if (doc && Array.isArray(doc.components)) return doc;
  } catch {
    /* corrupted slot — treat as missing */
  }
  return null;
}

/** Load the slot index, migrating the legacy single-project key if present. */
function initProjects() {
  try {
    const index = JSON.parse(localStorage.getItem(INDEX_KEY));
    if (index && Array.isArray(index.slots) && index.slots.length) {
      const currentId = index.slots.some((s) => s.id === index.currentId)
        ? index.currentId
        : index.slots[0].id;
      const project = readSlot(currentId) ?? sampleProject();
      return { slots: index.slots, currentId, project };
    }
  } catch {
    /* fall through to fresh index */
  }

  let project = null;
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY));
    if (legacy && Array.isArray(legacy.components)) project = legacy;
  } catch {
    /* no legacy project */
  }
  project = project ?? sampleProject();

  const id = crypto.randomUUID();
  const slots = [{ id, name: project.name || 'Untitled project', updatedAt: Date.now() }];
  try {
    localStorage.setItem(slotKey(id), JSON.stringify(project));
    localStorage.setItem(INDEX_KEY, JSON.stringify({ currentId: id, slots }));
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* storage unavailable — the editor still works, just without persistence */
  }
  return { slots, currentId: id, project };
}

const initialProjects = initProjects();

// ---------------------------------------------------------------------------
// State

const state = {
  project: initialProjects.project,
  slots: initialProjects.slots,
  currentSlotId: initialProjects.currentId,
  selectedId: PAGE_ITEM,
  console: [],
  dataValues: {},
  pageStatus: 'loading', // loading | running
  stale: false, // definitions changed since last reload
  user: null, // signed-in user (from /auth/me), null when logged out
  publish: {
    open: false,
    slug: '',
    title: '',
    busy: false,
    error: null,
    publishedPath: null, // site-relative URL after a successful publish
    pages: null, // my published pages, once listed
  },
  login: { username: '', password: '', busy: false, error: null },
};

function saveIndex() {
  try {
    localStorage.setItem(
      INDEX_KEY,
      JSON.stringify({ currentId: state.currentSlotId, slots: state.slots })
    );
  } catch (err) {
    console.warn('saving project index failed', err);
  }
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushAutosave, 300);
}

function flushAutosave() {
  clearTimeout(saveTimer);
  try {
    const slot = state.slots.find((s) => s.id === state.currentSlotId);
    if (slot) {
      slot.name = state.project.name || 'Untitled project';
      slot.updatedAt = Date.now();
    }
    localStorage.setItem(slotKey(state.currentSlotId), JSON.stringify(state.project));
    saveIndex();
  } catch (err) {
    console.warn('autosave failed', err);
  }
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
  iframe()?.contentWindow?.postMessage({ source: 'contraption-editor', ...msg }, '*');
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
  postToRuntime({
    type: 'run-executable',
    component: { id: c.id, name: c.name, code: c.code, lang: c.lang },
  });
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg || msg.source !== 'contraption-runtime') return;

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
    createSlot(doc);
  });
}

// ---------------------------------------------------------------------------
// Project slots — loading anything always lands in a fresh slot; existing
// work is never overwritten.

function activateProject(id, doc) {
  state.currentSlotId = id;
  state.project = doc;
  state.selectedId = PAGE_ITEM;
  state.console = [];
  saveIndex();
  update();
  reloadPage();
}

function createSlot(doc) {
  flushAutosave();
  const id = crypto.randomUUID();
  state.slots.push({ id, name: doc.name || 'Untitled project', updatedAt: Date.now() });
  try {
    localStorage.setItem(slotKey(id), JSON.stringify(doc));
  } catch (err) {
    console.warn('saving new project failed', err);
  }
  activateProject(id, doc);
}

function switchSlot(id) {
  if (id === state.currentSlotId) return;
  const doc = readSlot(id);
  if (!doc) return;
  flushAutosave();
  activateProject(id, doc);
}

function deleteCurrentSlot() {
  const slot = state.slots.find((s) => s.id === state.currentSlotId);
  if (
    !confirm(
      `Delete project "${slot?.name ?? 'Untitled'}" from this browser? Published copies are unaffected.`
    )
  ) {
    return;
  }
  clearTimeout(saveTimer); // don't resurrect the key via a pending autosave
  localStorage.removeItem(slotKey(state.currentSlotId));
  state.slots = state.slots.filter((s) => s.id !== state.currentSlotId);
  if (!state.slots.length) {
    createSlot(emptyProject());
    return;
  }
  const next = state.slots[0];
  activateProject(next.id, readSlot(next.id) ?? emptyProject());
}

// ---------------------------------------------------------------------------
// Auth + publishing

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

async function restoreSession() {
  if (!getToken()) return;
  try {
    const { user } = await api.me();
    state.user = user;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 404)) setToken(null);
  }
  update();
}

async function doLogin() {
  state.login.busy = true;
  state.login.error = null;
  update();
  try {
    const { token, user } = await api.login(state.login.username.trim(), state.login.password);
    setToken(token);
    state.user = user;
    state.login = { username: '', password: '', busy: false, error: null };
  } catch (err) {
    state.login.busy = false;
    state.login.error = err.message;
  }
  update();
}

function doLogout() {
  setToken(null);
  state.user = null;
  state.publish.pages = null;
  update();
}

function openPublish() {
  state.publish.open = true;
  state.publish.error = null;
  state.publish.publishedPath = null;
  if (!state.publish.slug) state.publish.slug = slugify(state.project.name);
  if (!state.publish.title) state.publish.title = state.project.name ?? '';
  update();
  if (state.user) refreshPages();
}

async function refreshPages() {
  try {
    const { pages } = await api.listPages();
    state.publish.pages = pages;
  } catch {
    state.publish.pages = null;
  }
  update();
}

async function doPublish() {
  const p = state.publish;
  p.busy = true;
  p.error = null;
  p.publishedPath = null;
  update();
  try {
    const { page } = await api.publish(p.slug.trim(), p.title.trim(), state.project);
    p.publishedPath = page.path;
    refreshPages();
  } catch (err) {
    p.error = err.message;
  }
  p.busy = false;
  update();
}

async function deletePublished(page) {
  if (!confirm(`Delete the published page "${page.slug}"? The URL will stop working.`)) return;
  try {
    await api.deletePage(page.slug);
    if (state.publish.publishedPath === page.path) state.publish.publishedPath = null;
    refreshPages();
  } catch (err) {
    state.publish.error = err.message;
    update();
  }
}

async function openPublishedInEditor(path) {
  try {
    const project = await fetchPublishedProject(path);
    createSlot(project);
    state.publish.open = false;
    update();
  } catch (err) {
    state.publish.error = err.message;
    update();
  }
}

/** Support #open=/p/slug/ links — reopen any published page for editing. */
function handleOpenHash() {
  const match = location.hash.match(/^#open=(.+)$/);
  if (!match) return;
  const path = decodeURIComponent(match[1]);
  history.replaceState(null, '', location.pathname + location.search);
  openPublishedInEditor(path);
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
        <select
          class="lang-select"
          title="Language (TypeScript is type-stripped, not typechecked)"
          .value=${live(c.lang ?? 'js')}
          @change=${(e) =>
            mutate(() => (c.lang = e.target.value), { needsReload: c.mode !== 'script' })}
        >
          <option value="js">JS</option>
          <option value="ts">TS</option>
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

function loginFormView() {
  const l = state.login;
  return html`
    <p class="hint">Sign in to publish. Accounts are created by the site admin.</p>
    <label class="field-label">username</label>
    <input
      class="modal-input"
      .value=${live(l.username)}
      @input=${(e) => {
        l.username = e.target.value;
        update();
      }}
    />
    <label class="field-label">password</label>
    <input
      class="modal-input"
      type="password"
      .value=${live(l.password)}
      @input=${(e) => {
        l.password = e.target.value;
        update();
      }}
      @keydown=${(e) => e.key === 'Enter' && doLogin()}
    />
    ${l.error ? html`<p class="modal-error">${l.error}</p>` : nothing}
    <div class="modal-actions">
      <button class="primary" ?disabled=${l.busy || !l.username || !l.password} @click=${doLogin}>
        ${l.busy ? 'signing in…' : 'sign in'}
      </button>
    </div>
  `;
}

function publishFormView() {
  const p = state.publish;
  return html`
    <p class="hint">
      Signed in as <strong>${state.user.displayName}</strong>
      <button class="mini" @click=${doLogout}>sign out</button>
    </p>
    <label class="field-label">page URL slug — becomes ${location.origin}/p/&lt;slug&gt;/</label>
    <input
      class="modal-input"
      placeholder="my-page"
      .value=${live(p.slug)}
      @input=${(e) => {
        p.slug = e.target.value;
        update();
      }}
    />
    <label class="field-label">title</label>
    <input class="modal-input" .value=${live(p.title)} @input=${(e) => (p.title = e.target.value)} />
    ${p.error ? html`<p class="modal-error">${p.error}</p>` : nothing}
    ${p.publishedPath
      ? html`<p class="modal-success">
          Published →
          <a href=${p.publishedPath} target="_blank" rel="noopener">${location.origin}${p.publishedPath}</a>
        </p>`
      : nothing}
    <div class="modal-actions">
      <button class="primary" ?disabled=${p.busy || !p.slug.trim()} @click=${doPublish}>
        ${p.busy ? 'publishing…' : 'publish'}
      </button>
    </div>
    ${p.pages?.length
      ? html`
          <div class="panel-title" style="padding-left:0">my published pages</div>
          <table class="pages-table">
            ${p.pages.map(
              (page) => html`
                <tr>
                  <td><a href=${page.path} target="_blank" rel="noopener">/p/${page.slug}/</a></td>
                  <td class="pages-title">${page.title}</td>
                  <td class="pages-actions">
                    <button class="mini" title="Load into the editor" @click=${() => openPublishedInEditor(page.path)}>
                      edit
                    </button>
                    <button class="mini danger" @click=${() => deletePublished(page)}>delete</button>
                  </td>
                </tr>
              `
            )}
          </table>
        `
      : nothing}
  `;
}

function publishModalView() {
  if (!state.publish.open) return nothing;
  return html`
    <div
      class="modal-backdrop"
      @click=${(e) => {
        if (e.target === e.currentTarget) {
          state.publish.open = false;
          update();
        }
      }}
    >
      <div class="modal">
        <div class="modal-header">
          <span class="editor-title">publish page</span>
          <span class="spacer"></span>
          <button
            class="mini"
            @click=${() => {
              state.publish.open = false;
              update();
            }}
          >
            ✕
          </button>
        </div>
        ${state.user ? publishFormView() : loginFormView()}
      </div>
    </div>
  `;
}

function toolbarView() {
  return html`
    <header class="toolbar">
      <span class="logo">⚙ contraption</span>
      <select
        id="slot-select"
        class="slot-select"
        title="Switch project"
        @change=${(e) => switchSlot(e.target.value)}
      >
        ${state.slots.map(
          (s) => html`<option value=${s.id} ?selected=${s.id === state.currentSlotId}>${s.name}</option>`
        )}
      </select>
      <input
        class="project-name"
        title="Rename this project"
        .value=${live(state.project.name ?? '')}
        @input=${(e) => mutate(() => (state.project.name = e.target.value))}
      />
      <button class="danger" title="Delete this project from the browser" @click=${deleteCurrentSlot}>
        🗑
      </button>
      <button class=${classMap({ primary: state.stale })} @click=${reloadPage}>
        ⟳ reload page${state.stale ? ' (stale)' : ''}
      </button>
      <span class="status ${state.pageStatus}">${state.pageStatus}</span>
      <span class="spacer"></span>
      <button title="Publish this page to the site" @click=${openPublish}>
        ↗ publish${state.user ? '' : ' (sign in)'}
      </button>
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
      <button title="Create a new project from the sample" @click=${() => createSlot(sampleProject())}>
        sample
      </button>
      <button title="Create a new empty project" @click=${() => createSlot(emptyProject())}>new</button>
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
    ${publishModalView()}
  `;
}

function update() {
  render(appView(), document.getElementById('app'));
  const scroll = document.getElementById('console-scroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
  // <option selected> only sets the default; set the live selection explicitly
  // so re-renders can't leave the switcher on a stale entry.
  const slotSelect = /** @type {HTMLSelectElement | null} */ (
    document.getElementById('slot-select')
  );
  if (slotSelect) slotSelect.value = state.currentSlotId;
}

update();
restoreSession();
handleOpenHash();
