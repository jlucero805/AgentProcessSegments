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
// page, drops the request through the API, and fails on page or console errors.
// A missing Puppeteer fails the run; --allow-missing-puppeteer skips it
// deliberately and prints SKIPPED (a skip is not a pass).
import { resolveUiSmokePuppeteer } from './e2e/puppeteer.mjs';

const guard = await resolveUiSmokePuppeteer({ argv: process.argv.slice(2) });
if (!guard.ok) {
  for (const line of guard.lines) console.error(line);
  process.exit(guard.exitCode);
}
const puppeteer = guard.puppeteer;

const base = process.env.UI_BASE ?? 'http://127.0.0.1:7391';
const mobile = process.env.UI_MOBILE === '1';
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

async function hasText(text) {
  return page.evaluate(
    (label) => document.body.innerText.toLowerCase().includes(label.toLowerCase()),
    text,
  );
}

async function clickText(text) {
  const found = await page.evaluate((label) => {
    const elements = [...document.querySelectorAll('button, a')];
    const element = elements.find((candidate) => candidate.textContent?.trim() === label);
    if (!element) return false;
    element.click();
    return true;
  }, text);
  if (!found) throw new Error(`button not found: ${text}`);
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
    () => document.body.innerText.toLowerCase().includes('agent process segments'),
    { timeout: 15_000 },
  );

  const background = await page.evaluate(() => {
    const root = document.getElementById('root')?.firstElementChild;
    return getComputedStyle(root ?? document.body).backgroundColor;
  });
  if (background === 'rgba(0, 0, 0, 0)' || background === 'rgb(255, 255, 255)') {
    throw new Error(`Tailwind did not apply; root background is ${background}`);
  }

  for (const label of ['Requests', 'Plan', 'Implement', 'Review', 'Merge', 'Finalize']) {
    if (!(await hasText(label))) throw new Error(`board column missing: ${label}`);
  }

  if (mobile) {
    const closed = await sidebarBox();
    if (!closed || closed.x >= 0 || closed.open !== 'false') {
      throw new Error(`menu should start off-canvas: ${JSON.stringify(closed)}`);
    }
    const scroll = await page.evaluate(() => {
      const column = document.querySelector('[data-testid="column-intake"]');
      const board = column?.parentElement;
      return board ? { scrollWidth: board.scrollWidth, clientWidth: board.clientWidth } : null;
    });
    if (!scroll || scroll.scrollWidth <= scroll.clientWidth) {
      throw new Error(`board is not horizontally scrollable: ${JSON.stringify(scroll)}`);
    }
  }

  await openMenu('create');
  await clickText('+ New request');
  await page.waitForSelector('input[placeholder="What should the agent do?"]', { timeout: 10_000 });
  await page.type('input[placeholder="What should the agent do?"]', 'Browser smoke');
  await page.type(
    'textarea[placeholder^="Context, links"]',
    'Created by a real Chromium against the running brain.',
  );
  await clickText('Create request');

  await page.waitForFunction(
    () => document.body.innerText.toLowerCase().includes('finalize digest'),
    { timeout: 15_000 },
  );
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('harness:'), {
    timeout: 15_000,
  });
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('send'), {
    timeout: 10_000,
  });

  if (mobile) {
    const drawer = await page.evaluate(() => {
      const aside = [...document.querySelectorAll('aside')].find((element) =>
        element.textContent?.includes('Finalize digest'),
      );
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
  await page.waitForFunction(
    () => document.body.innerText.toLowerCase().includes('browser smoke'),
    { timeout: 10_000 },
  );

  await openMenu('cell');
  await page.click('button[aria-label="New cell"]');
  await page.waitForFunction(
    () => document.body.innerText.toLowerCase().includes('cell process segments'),
    { timeout: 15_000 },
  );
  await page.type('input[placeholder="e.g. Work repo"]', 'Smoke cell');
  await clickText('Create cell');
  await page.waitForFunction(
    () => document.body.innerText.includes('Smoke cell'),
    { timeout: 15_000 },
  );
  const cells = await (await fetch(`${base}/api/cells`)).json();
  const smokeCell = cells.find((cell) => cell.name === 'Smoke cell');

  await openMenu('master');
  await clickText('Cell master');
  await page.waitForFunction(
    () =>
      document.body.innerText.toLowerCase().includes('process automation') &&
      document.body.innerText.toLowerCase().includes('cron loop'),
    { timeout: 15_000 },
  );
  if (smokeCell) {
    await page.waitForFunction(
      () =>
        document.body.innerText.includes('Smoke cell') &&
        document.body.innerText.toLowerCase().includes('cell policy'),
      { timeout: 10_000 },
    );
  }
  await page.waitForFunction(
    () => document.body.innerText.toLowerCase().includes('master chat'),
    { timeout: 10_000 },
  );
  await page.evaluate(() => {
    const close = [...document.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === 'Close master detail',
    );
    close?.click();
  });
  await page.waitForFunction(
    () => !document.body.innerText.toLowerCase().includes('process automation'),
    { timeout: 5_000 },
  );

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
  await clickText('Config');
  await page.waitForFunction(
    () => document.body.innerText.toLowerCase().includes('cell master'),
    { timeout: 15_000 },
  );
  await page.waitForFunction(
    () => document.body.innerText.toLowerCase().includes('run master now'),
    { timeout: 10_000 },
  );
  if (mobile) {
    const menu = await sidebarBox();
    if (!menu || menu.open !== 'false') {
      throw new Error(`navigating should close the mobile menu: ${JSON.stringify(menu)}`);
    }
  }

  await openMenu('help');
  await clickText('Help');
  await page.waitForSelector('[role="dialog"][aria-label="Documentation"]', { timeout: 10_000 });
  await page.waitForFunction(
    () =>
      document.body.innerText.toLowerCase().includes('getting started') &&
      document.body.innerText.toLowerCase().includes('agent process segments'),
    { timeout: 10_000 },
  );
  if (!mobile) {
    await clickText('Process segments');
    await page.waitForFunction(
      () => window.location.search.includes('help=07-process-segments'),
      { timeout: 5_000 },
    );
  }
  await page.click('button[aria-label="Close help"]');
  await page.waitForSelector('[role="dialog"][aria-label="Documentation"]', {
    hidden: true,
    timeout: 5_000,
  });

  await openMenu('floor');
  await clickText('Floor');
  await page.waitForFunction(
    () => document.body.innerText.toLowerCase().includes('requests'),
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
