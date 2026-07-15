/**
 * End-to-end smoke test for Contraption: serves the BUILT app
 * (frontend/dist), opens the editor in headless Chromium, and exercises the
 * sample project — shared
 * namespace, data components, computed values, handlers, custom elements,
 * script runs, imports, reload, and error reporting.
 *
 * Run with `npm test` (which builds first). Chromium is resolved from
 * $CHROME_PATH, a Playwright browsers directory, or playwright-core's registry.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..', 'frontend', 'dist');

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('frontend/dist not found — run `npm run build:frontend` first (or use `npm test`).');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

const VIEWER_TEMPLATE = path.join(__dirname, '..', 'backend', 'src', 'generated', 'viewer.html');

/**
 * Static server + a mock of the site API speaking the same wire protocol as
 * the Lambdas (auth + pages), writing published pages through the real viewer
 * template. This lets the full publish UI flow run in CI without AWS.
 */
const MOCK_TOKEN = 'test-token-123';
const MOCK_USER = { userId: 'u1', username: 'tester', displayName: 'Tester', role: 'admin', createdAt: 0 };
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;

function handleMockApi(req, res, urlPath) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (code, obj) =>
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
    const authed = req.headers.authorization === `Bearer ${MOCK_TOKEN}`;
    const route = `${req.method} ${urlPath}`;
    const db = handleMockApi.pages; // slug -> page record

    if (route === 'POST /api/auth/login') {
      const { username, password } = JSON.parse(body || '{}');
      if (username === 'tester' && password === 'pw123') return send(200, { token: MOCK_TOKEN, user: MOCK_USER });
      return send(401, { error: 'Invalid username or password' });
    }
    if (route === 'GET /api/auth/me') {
      return authed ? send(200, { user: MOCK_USER }) : send(401, { error: 'Unauthorized' });
    }
    if (route === 'POST /api/pages') {
      if (!authed) return send(401, { error: 'Unauthorized' });
      const { slug, title, project } = JSON.parse(body || '{}');
      if (!SLUG_RE.test(slug ?? '')) {
        return send(400, { error: 'slug must be 2-63 lowercase letters, digits or hyphens' });
      }
      // Mirror the Lambda: transpile TS executables, embed JS + keep tsCode.
      const { transform } = require('sucrase');
      try {
        project.components = (project.components ?? []).map((c) => {
          if (c?.type === 'executable' && c.lang === 'ts' && typeof c.code === 'string') {
            const js = transform(c.code, { transforms: ['typescript'], disableESTransforms: true }).code;
            return { ...c, code: js, tsCode: c.code };
          }
          return c;
        });
      } catch (err) {
        return send(400, { error: `TypeScript error: ${err.message}` });
      }
      const html = fs
        .readFileSync(VIEWER_TEMPLATE, 'utf-8')
        .replaceAll('{{TITLE}}', title || slug)
        .replace('{{PROJECT_JSON}}', () => JSON.stringify(project).replace(/</g, '\\u003c'));
      fs.mkdirSync(path.join(ROOT, 'p', slug), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'p', slug, 'index.html'), html);
      const now = Date.now();
      const record = db.get(slug) ?? { slug, createdAt: now };
      Object.assign(record, {
        title: title || slug,
        updatedAt: now,
        ownerUsername: MOCK_USER.username,
        path: `/p/${slug}/`,
      });
      db.set(slug, record);
      return send(200, { page: record });
    }
    if (route === 'GET /api/pages') {
      return authed ? send(200, { pages: [...db.values()] }) : send(401, { error: 'Unauthorized' });
    }
    if (req.method === 'DELETE' && urlPath.startsWith('/api/pages/')) {
      if (!authed) return send(401, { error: 'Unauthorized' });
      const slug = decodeURIComponent(urlPath.slice('/api/pages/'.length));
      db.delete(slug);
      fs.rmSync(path.join(ROOT, 'p', slug), { recursive: true, force: true });
      return send(200, { ok: true });
    }
    return send(404, { error: 'not found' });
  });
}
handleMockApi.pages = new Map();

function startServer() {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (urlPath === '/config.json') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ apiUrl: '/api', appName: 'contraption', pagesPrefix: 'p' }));
      return;
    }
    if (urlPath.startsWith('/api/')) {
      handleMockApi(req, res, urlPath);
      return;
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    let file = path.join(ROOT, urlPath);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && fs.existsSync(base)) {
    for (const dir of fs.readdirSync(base)) {
      const candidate = path.join(base, dir, 'chrome-linux', 'chrome');
      if (/^chromium-\d+$/.test(dir) && fs.existsSync(candidate)) return candidate;
    }
  }
  return chromium.executablePath();
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ' — ' + detail : ''}`);
}

(async () => {
  const server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('dialog', (d) => d.accept()); // auto-confirm delete dialogs
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push('editor: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push('console: ' + m.text());
  });

  // The editor autosaves to localStorage; a fresh context always starts on
  // the sample project.
  await page.goto(baseUrl, { waitUntil: 'networkidle' });

  check('editor toolbar renders', (await page.locator('.toolbar').count()) === 1);
  check('sidebar lists 5 items (page + 4 components)', (await page.locator('.item').count()) === 5);

  await page.waitForSelector('.status.running', { timeout: 5000 }).catch(() => {});
  check('runtime status becomes running', (await page.locator('.status.running').count()) === 1);

  const frame = page.frameLocator('#page-frame');
  await frame.locator('counter-view .value').waitFor({ timeout: 5000 }).catch(() => {});
  check(
    'counter-view custom element upgraded in iframe',
    await frame.locator('counter-view .value').count().then((n) => n === 1).catch(() => false)
  );

  const valueText = () => frame.locator('counter-view .value').innerText();
  check('initial count is 0', (await valueText()) === '0', await valueText());

  await frame.locator('counter-view button').nth(1).click();
  await frame.locator('counter-view button').nth(1).click();
  await page.waitForTimeout(200);
  check('count becomes 2 after two clicks', (await valueText()) === '2', await valueText());
  check('computed parity updates', (await frame.locator('counter-view .parity').innerText()).includes('even'));

  const consoleText = await page.locator('.console-scroll').innerText();
  check('handler logged count changes to editor console', consoleText.includes('count: 1 → 2'), consoleText.slice(0, 200));

  const dataText = await page.locator('.data-table').innerText();
  check('data panel shows count=2', /count\s+2/.test(dataText), dataText);
  check('data panel shows parity', /parity\s+even/.test(dataText));

  await page.locator('.item', { hasText: 'reset count' }).click();
  await page.locator('button', { hasText: '▶ run' }).click();
  await page.waitForTimeout(300);
  check('script reset count to 0', (await valueText()) === '0', await valueText());
  check('script console.log arrived', (await page.locator('.console-scroll').innerText()).includes('count reset'));

  // Cross-executable visibility plus last-expression echo.
  await page.locator('.sidebar-actions button', { hasText: '+ script' }).click();
  await page
    .locator('textarea.code')
    .fill('console.log("increment is", typeof increment); increment(5); count.value * 10');
  await page.locator('button', { hasText: '▶ run' }).click();
  await page.waitForTimeout(300);
  const out = await page.locator('.console-scroll').innerText();
  check('new script sees definitions from other executable', out.includes('increment is function'));
  check('last-expression result echoed', out.includes('50'));
  check('count is 5 after increment(5)', (await valueText()) === '5', await valueText());

  await page.locator('button', { hasText: 'reload page' }).click();
  await page.waitForSelector('.status.running', { timeout: 5000 });
  await page.waitForTimeout(200);
  check('after reload count resets to initial 0', (await valueText()) === '0', await valueText());

  await page.locator('.item', { hasText: 'script' }).last().click();
  await page.locator('textarea.code').fill('nonexistentFunction();');
  await page.locator('button', { hasText: '▶ run' }).click();
  await page.waitForTimeout(300);
  check('runtime error surfaces in editor console', (await page.locator('.console-line.level-error').count()) > 0);

  await page
    .locator('textarea.code')
    .fill("import { html as h2 } from '../vendor/lit-html/lit-html.js';\nconsole.log('imported html is', typeof h2);");
  await page.locator('button', { hasText: '▶ run' }).click();
  await page.waitForTimeout(400);
  check(
    'ES import statement works in executable',
    (await page.locator('.console-scroll').innerText()).includes('imported html is function')
  );

  const unexpected = pageErrors.filter((e) => !e.includes('nonexistentFunction'));
  check('no unexpected page errors', unexpected.length === 0, unexpected.join(' | ').slice(0, 300));

  // -------------------------------------------------------------------------
  // Project slots: creating/loading always lands in a fresh slot, switching
  // preserves each project's work.

  check('slot switcher shows one project', (await page.locator('#slot-select option').count()) === 1);

  await page.locator('.toolbar button', { hasText: 'new' }).click();
  await page.waitForTimeout(300);
  check('"new" creates a second slot instead of replacing', (await page.locator('#slot-select option').count()) === 2);
  check('new project starts empty (page + definitions)', (await page.locator('.item').count()) === 2);

  await page.locator('.item', { hasText: 'definitions' }).click();
  await page.locator('textarea.code').fill('// marker-in-slot-two\n');
  await page.waitForTimeout(500); // autosave debounce

  const slotIds = await page.locator('#slot-select option').evaluateAll((os) => os.map((o) => o.value));
  await page.selectOption('#slot-select', slotIds[0]);
  await page.waitForTimeout(400);
  check(
    'switching back restores the counter project (6 items after added script)',
    (await page.locator('.item').count()) === 6,
    String(await page.locator('.item').count())
  );

  await page.selectOption('#slot-select', slotIds[1]);
  await page.waitForTimeout(400);
  await page.locator('.item', { hasText: 'definitions' }).click();
  check(
    'edits in the other slot survive switching',
    (await page.locator('textarea.code').inputValue()).includes('marker-in-slot-two')
  );

  // -------------------------------------------------------------------------
  // Publish flow against the mock API: login (including failure), slug
  // validation, publish, serving, the my-pages list, edit round-trip,
  // session restore, and delete.

  await page.locator('.toolbar button', { hasText: 'publish' }).click();
  check('publish modal opens with a login form', (await page.locator('.modal input[type="password"]').count()) === 1);

  await page.locator('.modal-input').first().fill('tester');
  await page.locator('.modal input[type="password"]').fill('wrong-password');
  await page.locator('.modal button', { hasText: 'sign in' }).click();
  await page.waitForTimeout(400);
  check('bad credentials show an error', (await page.locator('.modal-error').innerText()).includes('Invalid'));

  await page.locator('.modal input[type="password"]').fill('pw123');
  await page.locator('.modal button', { hasText: 'sign in' }).click();
  await page.waitForTimeout(400);
  check('login switches to the publish form', (await page.locator('.modal').innerText()).includes('Signed in as Tester'));

  await page.locator('.modal-input').first().fill('BAD SLUG!');
  await page.locator('.modal button', { hasText: 'publish' }).click();
  await page.waitForTimeout(400);
  check('invalid slug error from the API surfaces in the dialog', (await page.locator('.modal-error').count()) === 1);

  await page.locator('.modal-input').first().fill('e2e-page');
  await page.locator('.modal button', { hasText: 'publish' }).click();
  await page.waitForTimeout(500);
  check('publish succeeds and shows the URL', (await page.locator('.modal-success').innerText()).includes('/p/e2e-page/'));
  check('my-pages list shows the published page', (await page.locator('.pages-table').innerText()).includes('/p/e2e-page/'));

  const publishedTab = await browser.newPage();
  await publishedTab.goto(`${baseUrl}p/e2e-page/`, { waitUntil: 'networkidle' });
  check(
    'mock-published page serves and renders its page HTML',
    (await publishedTab.locator('body').innerText()).includes('New page')
  );
  await publishedTab.close();

  const slotsBeforeEdit = await page.locator('#slot-select option').count();
  await page.locator('.pages-table button', { hasText: 'edit' }).click();
  await page.waitForTimeout(500);
  check(
    'edit from my-pages loads into a fresh slot and closes the modal',
    (await page.locator('#slot-select option').count()) === slotsBeforeEdit + 1 &&
      (await page.locator('.modal').count()) === 0
  );

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.status.running', { timeout: 5000 });
  await page.locator('.toolbar button', { hasText: 'publish' }).click();
  await page.waitForTimeout(400);
  check(
    'auth session survives a page reload',
    (await page.locator('.modal').innerText()).includes('Signed in as Tester')
  );

  await page.locator('.pages-table button', { hasText: 'delete' }).click();
  await page.waitForTimeout(400);
  check(
    'deleting a published page removes it from the list',
    !(await page.locator('.modal').innerText()).includes('/p/e2e-page/')
  );
  await page.locator('.modal-header button', { hasText: '✕' }).click();

  // -------------------------------------------------------------------------
  // Export / import round trip.

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.toolbar button', { hasText: 'export' }).click(),
  ]);
  const exportPath = path.join(require('os').tmpdir(), 'contraption-export.json');
  await download.saveAs(exportPath);
  const exported = JSON.parse(fs.readFileSync(exportPath, 'utf-8'));
  check('export produces the current project document', Array.isArray(exported.components));

  const slotsBeforeImport = await page.locator('#slot-select option').count();
  await page.locator('.toolbar input[type="file"]').setInputFiles(exportPath);
  await page.waitForTimeout(500);
  check(
    'import lands in a fresh slot',
    (await page.locator('#slot-select option').count()) === slotsBeforeImport + 1
  );

  // -------------------------------------------------------------------------
  // Page HTML editing, the stale indicator, component + slot deletion.

  await page.locator('.item', { hasText: 'Page HTML' }).click();
  await page.locator('textarea.code').fill('<h1>Edited page</h1>');
  await page.waitForTimeout(200);
  check(
    'definition-affecting edits mark the page stale',
    (await page.locator('.toolbar button', { hasText: 'reload page' }).innerText()).includes('stale')
  );
  await page.locator('.toolbar button', { hasText: 'reload page' }).click();
  await page.waitForSelector('.status.running', { timeout: 5000 });
  await page.waitForTimeout(200);
  check('reload applies page HTML edits', (await frame.locator('h1').innerText()) === 'Edited page');

  const itemsBeforeDelete = await page.locator('.item').count();
  await page.locator('.item', { hasText: 'definitions' }).click();
  await page.locator('.editor-header button', { hasText: 'delete' }).click();
  await page.waitForTimeout(300);
  check('deleting a component removes it', (await page.locator('.item').count()) === itemsBeforeDelete - 1);

  const slotsBeforeSlotDelete = await page.locator('#slot-select option').count();
  await page.locator('.toolbar button[title="Delete this project from the browser"]').click();
  await page.waitForTimeout(400);
  check(
    'deleting a project slot removes it',
    (await page.locator('#slot-select option').count()) === slotsBeforeSlotDelete - 1
  );

  // -------------------------------------------------------------------------
  // TypeScript executables (phase 1: type-stripping): TS definitions share
  // their namespace with JS, TS scripts run and echo, TS errors surface,
  // publishing embeds JS, and the round-trip restores TS source.

  await page.locator('.toolbar button', { hasText: 'new' }).click();
  await page.waitForTimeout(300);
  await page.locator('.project-name').fill('TS project');
  await page.locator('.item', { hasText: 'definitions' }).click();
  await page.locator('.lang-select').selectOption('ts');
  await page.locator('textarea.code').fill(
    [
      'interface Point { x: number; y: number }',
      'const origin: Point = { x: 0, y: 0 };',
      'const dist = (p: Point): number => Math.hypot(p.x - origin.x, p.y - origin.y);',
      "console.log('ts-def-ok', dist({ x: 3, y: 4 }));",
    ].join('\n')
  );
  await page.waitForTimeout(200);
  await page.locator('.toolbar button', { hasText: 'reload page' }).click();
  await page.waitForSelector('.status.running', { timeout: 5000 });
  await page.waitForTimeout(300);
  check(
    'TS definition executable runs (types stripped)',
    (await page.locator('.console-scroll').innerText()).includes('ts-def-ok 5')
  );

  await page.locator('.sidebar-actions button', { hasText: '+ script' }).click();
  await page.locator('textarea.code').fill("console.log('js-sees-ts', typeof dist); dist({ x: 6, y: 8 })");
  await page.locator('button', { hasText: '▶ run' }).click();
  await page.waitForTimeout(300);
  const tsOut = await page.locator('.console-scroll').innerText();
  check('JS executable sees TS definitions in the shared namespace', tsOut.includes('js-sees-ts function'));
  check('TS-defined function result echoed', tsOut.includes('10'));

  await page.locator('.lang-select').selectOption('ts');
  await page.locator('textarea.code').fill('const n: number = 21;\nn * 2');
  await page.locator('button', { hasText: '▶ run' }).click();
  await page.waitForTimeout(300);
  check(
    'TS script runs with annotations and echoes',
    (await page.locator('.console-scroll').innerText()).includes('42')
  );

  await page.locator('textarea.code').fill('const broken: = 5;');
  await page.locator('button', { hasText: '▶ run' }).click();
  await page.waitForTimeout(300);
  check(
    'TS syntax error surfaces in the console',
    (await page.locator('.console-line.level-error').last().innerText()).length > 0
  );

  // Publishing with the broken TS script still in the project must fail with
  // a TS error from the API, surfaced in the dialog.
  await page.locator('.toolbar button', { hasText: 'publish' }).click();
  await page.locator('.modal-input').first().fill('ts-page');
  await page.locator('.modal button', { hasText: 'publish' }).click();
  await page.waitForTimeout(500);
  check(
    'publish-time TS error surfaces in the dialog',
    (await page.locator('.modal-error').innerText().catch(() => '')).includes('TypeScript error')
  );
  await page.locator('.modal-header button', { hasText: '✕' }).click();

  // Fix the script and publish for real.
  await page.locator('textarea.code').fill("const ok: string = 'fixed';");
  await page.waitForTimeout(300);
  await page.locator('.toolbar button', { hasText: 'publish' }).click();
  await page.locator('.modal-input').first().fill('ts-page');
  await page.locator('.modal button', { hasText: 'publish' }).click();
  await page.waitForTimeout(500);
  check(
    'TS project publishes once fixed',
    (await page.locator('.modal-success').innerText().catch(() => '')).includes('/p/ts-page/')
  );

  const tsPublished = fs.readFileSync(path.join(ROOT, 'p', 'ts-page', 'index.html'), 'utf-8');
  const tsEmbedded = JSON.parse(
    tsPublished.match(/<script type="application\/json" id="contraption-project">([\s\S]*?)<\/script>/)[1]
  );
  const tsDef = tsEmbedded.components.find((c) => c.name === 'definitions');
  check(
    'published artifact embeds transpiled JS',
    !tsDef.code.includes('interface Point') && tsDef.code.includes('dist')
  );
  check('published artifact keeps TS source for round-trip', (tsDef.tsCode ?? '').includes('interface Point'));

  const tsViewerPage = await browser.newPage();
  const tsViewerLogs = [];
  tsViewerPage.on('console', (m) => tsViewerLogs.push(m.text()));
  const tsViewerErrors = [];
  tsViewerPage.on('pageerror', (e) => tsViewerErrors.push(e.message));
  await tsViewerPage.goto(`${baseUrl}p/ts-page/`, { waitUntil: 'networkidle' });
  await tsViewerPage.waitForTimeout(400);
  check('published TS page boots (viewer stays TS-free)', tsViewerLogs.some((l) => l.includes('ts-def-ok 5')));
  check('published TS page has no errors', tsViewerErrors.length === 0, tsViewerErrors.join(' | '));
  await tsViewerPage.close();

  // Round-trip: edit-from-list restores the TS source.
  await page.locator('.pages-table button', { hasText: 'edit' }).click();
  await page.waitForTimeout(500);
  await page.locator('.item', { hasText: 'definitions' }).click();
  check(
    'round-trip restores TS source in the editor',
    (await page.locator('textarea.code').inputValue()).includes('interface Point')
  );
  check(
    'round-trip keeps lang=ts on the executable',
    (await page.locator('.lang-select').inputValue()) === 'ts'
  );

  // -------------------------------------------------------------------------
  // Published-page viewer: render the sample project through the generated
  // self-contained viewer template (as the publish Lambda does) and verify it
  // runs standalone, then verify the editor round-trip via #open=.

  const viewerTemplate = path.join(__dirname, '..', 'backend', 'src', 'generated', 'viewer.html');
  if (!fs.existsSync(viewerTemplate)) {
    console.error('backend/src/generated/viewer.html not found — run `npm run build:viewer` first.');
    process.exit(2);
  }
  const { sampleProject } = await import(
    require('url').pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', 'editor', 'samples.js')).href
  );
  const project = sampleProject();
  // Escaping regression: code containing a literal </script> must not break
  // out of the embedded JSON block.
  project.components.push({
    id: 'nasty',
    type: 'executable',
    mode: 'definition',
    name: 'nasty strings',
    code: 'const nasty = "</script>"; console.log("escape-ok", nasty.length);',
  });
  const publishedHtml = fs
    .readFileSync(viewerTemplate, 'utf-8')
    .replaceAll('{{TITLE}}', 'Test page')
    .replace('{{PROJECT_JSON}}', () => JSON.stringify(project).replace(/</g, '\\u003c'));
  fs.mkdirSync(path.join(ROOT, 'p', 'test-page'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'p', 'test-page', 'index.html'), publishedHtml);

  const viewerPage = await browser.newPage();
  const viewerErrors = [];
  viewerPage.on('pageerror', (e) => viewerErrors.push(e.message));
  const viewerLogs = [];
  viewerPage.on('console', (m) => viewerLogs.push(m.text()));

  await viewerPage.goto(`${baseUrl}p/test-page/`, { waitUntil: 'networkidle' });
  await viewerPage.locator('counter-view .value').waitFor({ timeout: 5000 }).catch(() => {});
  check('published page boots standalone', (await viewerPage.locator('counter-view .value').count()) === 1);
  check('published page takes its title from the project', (await viewerPage.title()) === 'Counter demo');

  await viewerPage.locator('counter-view button').nth(1).click();
  await viewerPage.waitForTimeout(200);
  check(
    'published page is interactive (counter increments)',
    (await viewerPage.locator('counter-view .value').innerText()) === '1'
  );
  check(
    'published page handlers fire (console log)',
    viewerLogs.some((l) => l.includes('count: 0 → 1'))
  );
  check(
    'embedded </script> in code is escaped safely',
    viewerLogs.some((l) => l.includes('escape-ok 9'))
  );
  check('published page has no errors', viewerErrors.length === 0, viewerErrors.join(' | '));
  await viewerPage.close();

  // Round-trip: #open= loads the embedded project back into the editor.
  const editorPage = await browser.newPage();
  await editorPage.goto(`${baseUrl}#open=/p/test-page/`, { waitUntil: 'networkidle' });
  await editorPage.waitForSelector('.status.running', { timeout: 5000 }).catch(() => {});
  await editorPage.waitForTimeout(300);
  check(
    'editor #open= reopens a published page (6 sidebar items)',
    (await editorPage.locator('.item').count()) === 6
  );
  // editorPage is a fresh browser context (empty localStorage): the initial
  // slot plus the one #open= creates. The opened project must be selected.
  check(
    '#open= lands in a fresh slot instead of replacing',
    (await editorPage.locator('#slot-select option').count()) === 2
  );
  const reopenedFrame = editorPage.frameLocator('#page-frame');
  await reopenedFrame.locator('counter-view .value').waitFor({ timeout: 5000 }).catch(() => {});
  check(
    'reopened project runs in the editor',
    await reopenedFrame.locator('counter-view .value').count().then((n) => n === 1).catch(() => false)
  );
  await editorPage.close();

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('SMOKE TEST CRASHED:', e);
  process.exit(2);
});
