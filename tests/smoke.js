/**
 * End-to-end smoke test: serves the BUILT app (frontend/dist), opens the
 * editor in headless Chromium, and exercises the sample project — shared
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

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
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

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('SMOKE TEST CRASHED:', e);
  process.exit(2);
});
