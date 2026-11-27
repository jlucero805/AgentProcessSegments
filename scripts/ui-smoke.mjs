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
// The script creates a request through the UI, checks the drawer/chat, the Config
// schedule card, drops the request through the API, and fails on page or console errors.
// A missing Puppeteer fails the run; --allow-missing-puppeteer skips it
// deliberately and prints SKIPPED (a skip is not a pass).
//
// Locate elements through the data-testid hooks, accessible aria-labels, and Help
// data-slugs below, never through visible copy. scripts/ui-smoke.test.mjs fails when
// one used here is missing from the SPA or the Help manifest.
import { resolveUiSmokePuppeteer } from './e2e/puppeteer.mjs';

const guard = await resolveUiSmokePuppeteer({ argv: process.argv.slice(2) });
if (!guard.ok) {
  for (const line of guard.lines) console.error(line);
  process.exit(guard.exitCode);
}
const puppeteer = guard.puppeteer;

const base = process.env.UI_BASE ?? 'http://127.0.0.1:7391';
const mobile = process.env.UI_MOBILE === '1';
const BOARD_COLUMNS = ['intake', 'clarify', 'dispatch', 'review', 'merge', 'finalize'];
let browser;
let page;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
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

  await openMenu('create');
  await page.click('[data-testid="new-request"]');
  await page.waitForSelector('[data-testid="create-title"]', { visible: true, timeout: 10_000 });
  await page.type('[data-testid="create-title"]', 'Browser smoke');
  await page.type(
    '[data-testid="create-body"]',
    'Created by a real Chromium against the running brain.',
  );
  await page.click('[data-testid="create-submit"]');

  await page.waitForSelector('[data-testid="request-detail"]', { timeout: 15_000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="request-title"]')?.textContent?.trim() === 'Browser smoke',
    { timeout: 15_000 },
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
    () =>
      [...document.querySelectorAll('[data-testid="request-card"]')].some((card) =>
        card.textContent?.includes('Browser smoke'),
      ),
    { timeout: 10_000 },
  );

  await openMenu('cell');
  await page.click('[data-testid="new-cell"]');
  await page.waitForSelector('[data-testid="cell-name"]', { visible: true, timeout: 15_000 });
  await page.type('[data-testid="cell-name"]', 'Smoke cell');
  // The submit button only enables after the cell draft's process has loaded.
  await page.waitForFunction(
    () => {
      const button = document.querySelector('[data-testid="cell-submit"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    { timeout: 15_000 },
  );
  await page.click('[data-testid="cell-submit"]');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-testid="cell-option"]')].some(
        (option) => option.textContent?.trim() === 'Smoke cell',
      ),
    { timeout: 15_000 },
  );
  const cells = await (await fetch(`${base}/api/cells`)).json();
  const smokeCell = cells.find((cell) => cell.name === 'Smoke cell');

  await openMenu('master');
  await page.click('[data-testid="nav-master"]');
  await page.waitForSelector('[data-testid="master-detail"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="master-cron-loop"]', { visible: true, timeout: 15_000 });
  await page.waitForSelector('[data-testid="master-title"]', { visible: true, timeout: 10_000 });
  if (smokeCell) {
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="master-title"]')?.textContent?.includes('Smoke cell'),
      { timeout: 10_000 },
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

  const list = await (await fetch(`${base}/api/requests?view=intake`)).json();
  const created = list.find((request) => request.title === 'Browser smoke');
  if (created) {
    await fetch(`${base}/api/requests/${created.id}/drop`, { method: 'POST' });
  }
  if (smokeCell) {
    await fetch(`${base}/api/cells/${smokeCell.id}`, { method: 'DELETE' });
  }

  const shot = process.env.UI_SHOT ?? (mobile ? '/tmp/sbox-ui-mobile.png' : '/tmp/sbox-ui-smoke.png');
  await page.screenshot({ path: shot, fullPage: true });

  if (errors.length > 0) throw new Error(`browser errors:\n${errors.join('\n')}`);
  console.log(`ui smoke ok (${mobile ? 'mobile' : 'desktop'})`);
  console.log('root background:', background);
  console.log('request:', created?.id ?? 'not found');
  console.log('screenshot:', shot);
} catch (error) {
  console.error('ui smoke FAILED:', error.message);
  console.error('page text:', (await page.evaluate(() => document.body.innerText)).slice(0, 800));
  if (errors.length > 0) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
