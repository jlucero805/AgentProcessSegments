#!/usr/bin/env node
// Optional real-browser smoke for the built SPA.
//
// Requires Puppeteer, which is deliberately not a project dependency:
//   npm install --no-save puppeteer
//   npx puppeteer browsers install chrome
//   node scripts/ui-smoke.mjs [--allow-missing-puppeteer]
//
// Set UI_MOBILE=1 for a 390x844 viewport (off-canvas menu, horizontal board,
// full-width drawer). Set UI_BASE for a different running brain.
// The script creates a request and a cell through the UI, checks the drawer/chat and
// the Config schedule card, removes both through the API on every exit path, and
// fails on page or console errors. A missing Puppeteer fails the run;
// --allow-missing-puppeteer skips it deliberately and prints SKIPPED (a skip is not
// a pass).
//
// Locate elements through the data-testid hooks, accessible aria-labels, and Help
// data-slugs below, never through visible copy. scripts/ui-smoke.test.mjs fails when
// one used here is missing from the SPA or the Help manifest.
import { resolveUiSmokePuppeteer } from './e2e/puppeteer.mjs';
import { createSignalCleanup } from './e2e/signal-cleanup.mjs';
import { cleanupUiSmokeArtifacts } from './e2e/ui-smoke-cleanup.mjs';

const guard = await resolveUiSmokePuppeteer({ argv: process.argv.slice(2) });
if (!guard.ok) {
  for (const line of guard.lines) console.error(line);
  process.exit(guard.exitCode);
}
const puppeteer = guard.puppeteer;

const base = (process.env.UI_BASE ?? 'http://127.0.0.1:7391').replace(/\/+$/, '');
const mobile = process.env.UI_MOBILE === '1';
const REQUEST_TITLE = 'Browser smoke';
const CELL_NAME = 'Smoke cell';
const BOARD_COLUMNS = ['intake', 'clarify', 'dispatch', 'review', 'merge', 'finalize'];
let browser;
let page;
let requestId;
let cellId;
let baselineRequestIds = null;
let baselineCellIds = null;
let baselineReady = false;
let artifactsRemoved = false;
let cleanupFailed = false;

async function fetchJson(route) {
  const response = await fetch(`${base}${route}`);
  if (!response.ok) throw new Error(`GET ${route} -> ${response.status}`);
  return response.json();
}

async function removeArtifacts() {
  if (!requestId && !cellId && !baselineReady) return;
  if (artifactsRemoved) return;
  artifactsRemoved = true;
  try {
    const { failures } = await cleanupUiSmokeArtifacts({
      base,
      request: { id: requestId, title: REQUEST_TITLE },
      cell: { id: cellId, name: CELL_NAME },
      baselineRequestIds: baselineReady ? baselineRequestIds : null,
      baselineCellIds: baselineReady ? baselineCellIds : null,
      log: (message) => console.error(message),
    });
    if (failures.length > 0) {
      cleanupFailed = true;
      console.error(
        `ui smoke cleanup failed for ${failures.length} artifact(s); the board may need manual cleanup`,
      );
    }
  } catch (error) {
    cleanupFailed = true;
    console.error(`ui smoke cleanup failed: ${error.message}`);
  }
}

async function closeBrowser() {
  const current = browser;
  if (!current) return;
  try {
    await current.close();
  } catch (error) {
    cleanupFailed = true;
    console.error(`ui smoke cleanup: browser close failed: ${error.message}`);
    try {
      current.process()?.kill('SIGKILL');
    } catch {
      // The browser already exited.
    }
  } finally {
    browser = null;
  }
}

async function cleanup() {
  try {
    await removeArtifacts();
  } catch (error) {
    cleanupFailed = true;
    console.error(`ui smoke cleanup failed: ${error.message}`);
  }
  await closeBrowser();
}

function forceCleanup() {
  try {
    browser?.process()?.kill('SIGKILL');
  } catch {
    // The browser already exited.
  }
}

const signalCleanup = createSignalCleanup({ cleanup, force: forceCleanup });

try {
  browser = await puppeteer.launch({
    headless: true,
    // Puppeteer's default signal handlers exit immediately and would skip cleanup.
    handleSIGINT: false,
    handleSIGTERM: false,
    args: ['--no-sandbox'],
  });
  page = await browser.newPage();
  if (mobile) await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
} catch (error) {
  if (browser) await browser.close().catch(() => {});
  console.error(`ui smoke FAILED: could not start the browser: ${error.message}`);
  console.error(
    '  hint: run `npx puppeteer browsers install chrome` (or set PUPPETEER_EXECUTABLE_PATH)',
  );
  process.exit(1);
}

const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('favicon')) {
    errors.push(`console: ${message.text()}`);
  }
});

const HELP_MERMAID_SELECTOR =
  '[data-testid="help-article"] svg[id^="help-mermaid-"]';

async function waitForMermaidDiagram() {
  try {
    await page.waitForSelector(HELP_MERMAID_SELECTOR, { visible: true, timeout: 15_000 });
  } catch (error) {
    const article = await page
      .evaluate(() => {
        const node = document.querySelector('[data-testid="help-article"]');
        return node ? node.innerText : '';
      })
      .catch(() => '');
    const state = article.includes('Rendering diagram…')
      ? 'the diagram is still loading'
      : 'no rendered diagram appeared';
    throw new Error(
      `Help "Getting started" did not render a Mermaid <svg> (${state}): ${error.message}\n` +
        `article text: ${article.slice(0, 300)}`,
      { cause: error },
    );
  }
}

async function sidebarBox() {
  return page.evaluate(() => {
    const element = document.querySelector('[data-testid="sidebar"]');
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, width: rect.width, open: element.getAttribute('data-open') };
  });
}

async function openMenu(step) {
  if (!mobile) return;
  // Wait until the closing transition is done and the hamburger is the top element.
  await page.waitForFunction(
    () => {
      const button = document.querySelector('button[aria-label="Open menu"]');
      if (!button) return false;
      const rect = button.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button;
    },
    { timeout: 3_000 },
  ).catch((error) => {
    throw new Error(`hamburger not reachable at ${step}: ${error.message}`);
  });
  await page.click('button[aria-label="Open menu"]');
  await page.waitForFunction(
    () => {
      const element = document.querySelector('[data-testid="sidebar"]');
      return Boolean(element) && element.getBoundingClientRect().x >= 0;
    },
    { timeout: 2_000 },
  ).catch((error) => {
    throw new Error(`menu did not open at ${step}: ${error.message}`);
  });
}

try {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-testid^="column-"]').length === count,
    { timeout: 15_000 },
    BOARD_COLUMNS.length,
  );
  const columnIds = await page.$$eval('[data-testid^="column-"]', (columns) =>
    columns.map((column) => column.getAttribute('data-testid')),
  );
  const expectedColumns = BOARD_COLUMNS.map((column) => `column-${column}`);
  if (columnIds.join(',') !== expectedColumns.join(',')) {
    throw new Error(`board columns differ: ${JSON.stringify(columnIds)}`);
  }

  const background = await page.evaluate(() => {
    const root = document.getElementById('root')?.firstElementChild;
    return getComputedStyle(root ?? document.body).backgroundColor;
  });
  if (background === 'rgba(0, 0, 0, 0)' || background === 'rgb(255, 255, 255)') {
    throw new Error(`Tailwind did not apply; root background is ${background}`);
  }

  if (mobile) {
    const closed = await sidebarBox();
    if (!closed || closed.x >= 0 || closed.open !== 'false') {
      throw new Error(`menu should start off-canvas: ${JSON.stringify(closed)}`);
    }
    const scroll = await page.evaluate(() => {
      const column = document.querySelector('[data-testid^="column-"]');
      const board = column?.parentElement;
      return board ? { scrollWidth: board.scrollWidth, clientWidth: board.clientWidth } : null;
    });
    if (!scroll || scroll.scrollWidth <= scroll.clientWidth) {
      throw new Error(`board is not horizontally scrollable: ${JSON.stringify(scroll)}`);
    }
  }

  // Cleanup must never remove an artifact that existed before this run. Capture the
  // ids first, then use the create-response ids; the baseline is only the fallback
  // for a response that was lost after the server created the artifact.
  const [baselineRequests, baselineCells] = await Promise.all([
    fetchJson('/api/requests'),
    fetchJson('/api/cells'),
  ]);
  baselineRequestIds = new Set(
    baselineRequests
      .filter((request) => request.title === REQUEST_TITLE)
      .map((request) => request.id),
  );
  baselineCellIds = new Set(
    baselineCells.filter((cell) => cell.name === CELL_NAME).map((cell) => cell.id),
  );
  baselineReady = true;

  await openMenu('create');
  await page.click('[data-testid="new-request"]');
  await page.waitForSelector('[data-testid="create-title"]', { visible: true, timeout: 10_000 });
  await page.type('[data-testid="create-title"]', REQUEST_TITLE);
  await page.type(
    '[data-testid="create-body"]',
    'Created by a real Chromium against the running brain.',
  );
  const [requestResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url() === `${base}/api/requests` &&
        response.request().method() === 'POST',
    ),
    page.click('[data-testid="create-submit"]'),
  ]);
  if (requestResponse.status() !== 201) {
    throw new Error(`create request failed: ${requestResponse.status()}`);
  }
  const createdRequest = await requestResponse.json();
  if (typeof createdRequest.id !== 'string') {
    throw new Error('create request response did not contain an id');
  }
  requestId = createdRequest.id;

  await page.waitForSelector('[data-testid="request-detail"]', { timeout: 15_000 });
  await page.waitForFunction(
    (title) =>
      document.querySelector('[data-testid="request-title"]')?.textContent?.trim() === title,
    { timeout: 15_000 },
    REQUEST_TITLE,
  );
  // These mount only after the drawer's form and chat have loaded.
  await page.waitForSelector('[data-testid="finalize-digest"]', { visible: true, timeout: 15_000 });
  await page.waitForSelector('[data-testid="harness-select"]', { visible: true, timeout: 15_000 });
  await page.waitForSelector('[data-testid="composer-send"]', { visible: true, timeout: 10_000 });

  if (mobile) {
    const drawer = await page.evaluate(() => {
      const aside = document.querySelector('[data-testid="request-detail"]');
      if (!aside) return null;
      const rect = aside.getBoundingClientRect();
      return { x: rect.x, width: rect.width, viewport: window.innerWidth };
    });
    if (!drawer || drawer.x > 2 || drawer.width < drawer.viewport - 2) {
      throw new Error(`drawer is not full-width: ${JSON.stringify(drawer)}`);
    }
  }

  await page.evaluate(() => {
    const close = [...document.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === 'Close drawer',
    );
    close?.click();
  });
  await page.waitForSelector('[data-testid="request-detail"]', { hidden: true, timeout: 10_000 });
  await page.waitForFunction(
    (title) =>
      [...document.querySelectorAll('[data-testid="request-card"]')].some((card) =>
        card.textContent?.includes(title),
      ),
    { timeout: 10_000 },
    REQUEST_TITLE,
  );

  await openMenu('cell');
  await page.click('[data-testid="new-cell"]');
  await page.waitForSelector('[data-testid="cell-name"]', { visible: true, timeout: 15_000 });
  await page.type('[data-testid="cell-name"]', CELL_NAME);
  // The submit button only enables after the cell draft's process has loaded.
  await page.waitForFunction(
    () => {
      const button = document.querySelector('[data-testid="cell-submit"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    { timeout: 15_000 },
  );
  const [cellResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url() === `${base}/api/cells` && response.request().method() === 'POST',
    ),
    page.click('[data-testid="cell-submit"]'),
  ]);
  if (cellResponse.status() !== 201) {
    throw new Error(`create cell failed: ${cellResponse.status()}`);
  }
  const createdCell = await cellResponse.json();
  if (typeof createdCell.id !== 'string') {
    throw new Error('create cell response did not contain an id');
  }
  cellId = createdCell.id;
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('[data-testid="cell-option"]')].some(
        (option) => option.textContent?.trim() === name,
      ),
    { timeout: 15_000 },
    CELL_NAME,
  );

  await openMenu('master');
  await page.click('[data-testid="nav-master"]');
  await page.waitForSelector('[data-testid="master-detail"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="master-cron-loop"]', { visible: true, timeout: 15_000 });
  await page.waitForSelector('[data-testid="master-title"]', { visible: true, timeout: 10_000 });
  if (cellId) {
    await page.waitForFunction(
      (name) =>
        document.querySelector('[data-testid="master-title"]')?.textContent?.includes(name),
      { timeout: 10_000 },
      CELL_NAME,
    );
    await page.waitForSelector('[data-testid="master-policy"]', { visible: true, timeout: 10_000 });
  }
  await page.waitForSelector('[data-testid="master-chat"]', { visible: true, timeout: 10_000 });
  await page.evaluate(() => {
    const close = [...document.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === 'Close master detail',
    );
    close?.click();
  });
  await page.waitForSelector('[data-testid="master-detail"]', { hidden: true, timeout: 5_000 });

  if (!mobile) {
    await page.click('button[aria-label="Terminal"]');
    await page.waitForSelector('button[aria-label="Hide terminal panel"]', { timeout: 5_000 });
    await page.waitForSelector('button[aria-label="Close terminal 1"]', { timeout: 5_000 });
    await page.click('button[aria-label="Maximize terminal"]');
    await page.waitForSelector('button[aria-label="Restore terminal"]', { timeout: 5_000 });
    await page.click('button[aria-label="Restore terminal"]');
    await page.click('button[aria-label="Hide terminal panel"]');
    await page.waitForSelector('button[aria-label="Hide terminal panel"]', {
      hidden: true,
      timeout: 5_000,
    });

    // Hiding must detach, not kill. Reopening should reuse the same session.
    await page.click('button[aria-label="Terminal"]');
    await page.waitForSelector('button[aria-label="Close terminal 1"]', { timeout: 5_000 });
    await page.click('button[aria-label="Close terminal 1"]');
    await page.click('button[aria-label="Hide terminal panel"]');
  }

  await openMenu('config');
  await page.click('[data-testid="nav-config"]');
  // The settings cards mount only after every config fetch resolves, so the
  // page heading and the schedule card prove the page is really loaded.
  try {
    await page.waitForSelector('[data-testid="config-heading"]', {
      visible: true,
      timeout: 15_000,
    });
    // The Schedule card only renders after every settings fetch resolves, so this
    // button proves the Config page finished loading.
    await page.waitForSelector('[data-testid="save-schedule"]', {
      visible: true,
      timeout: 15_000,
    });
  } catch (error) {
    throw new Error(`Config schedule card did not load: ${error.message}`, { cause: error });
  }
  if (mobile) {
    const menu = await sidebarBox();
    if (!menu || menu.open !== 'false') {
      throw new Error(`navigating should close the mobile menu: ${JSON.stringify(menu)}`);
    }
  }

  await openMenu('help');
  await page.click('[data-testid="nav-help"]');
  await page.waitForSelector('[role="dialog"][aria-label="Documentation"]', { timeout: 10_000 });
  await page.waitForSelector('[data-testid="help-article"][data-slug="getting-started"]', {
    visible: true,
    timeout: 15_000,
  });
  await waitForMermaidDiagram();
  if (!mobile) {
    await page.waitForSelector(
      '[data-testid="help-nav"] [data-testid="help-page-link"][data-slug="07-process-segments"]',
      { visible: true, timeout: 10_000 },
    );
    await page.click(
      '[data-testid="help-nav"] [data-testid="help-page-link"][data-slug="07-process-segments"]',
    );
    await page.waitForFunction(
      () => window.location.search.includes('help=07-process-segments'),
      { timeout: 5_000 },
    );
    await page.waitForSelector('[data-testid="help-article"][data-slug="07-process-segments"]', {
      visible: true,
      timeout: 10_000,
    });
  }
  await page.click('button[aria-label="Close help"]');
  await page.waitForSelector('[role="dialog"][aria-label="Documentation"]', {
    hidden: true,
    timeout: 5_000,
  });

  await openMenu('floor');
  await page.click('[data-testid="nav-floor"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid^="column-"]').length === 6,
    { timeout: 10_000 },
  );

  await removeArtifacts();

  const shot = process.env.UI_SHOT ?? (mobile ? '/tmp/sbox-ui-mobile.png' : '/tmp/sbox-ui-smoke.png');
  await page.screenshot({ path: shot, fullPage: true });

  if (errors.length > 0) throw new Error(`browser errors:\n${errors.join('\n')}`);
  await closeBrowser();
  if (cleanupFailed) {
    throw new Error('artifact cleanup failed; the smoke request or cell may still be on the board');
  }
  console.log(`ui smoke ok (${mobile ? 'mobile' : 'desktop'})`);
  console.log('root background:', background);
  console.log('request:', requestId);
  console.log('screenshot:', shot);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('ui smoke FAILED:', message);
  try {
    if (page && !page.isClosed()) {
      const text = await page.evaluate(() => document.body.innerText);
      console.error('page text:', text.slice(0, 800));
    }
  } catch {
    // A closed or crashed page must not hide the original failure.
  }
  if (errors.length > 0) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  try {
    await signalCleanup.run();
  } finally {
    signalCleanup.dispose();
    if (cleanupFailed && process.exitCode === undefined) process.exitCode = 1;
  }
}
