#!/usr/bin/env node
// Optional real-browser smoke for the built SPA.
//
// Requires Puppeteer, which is deliberately not a project dependency:
//   npm install --no-save puppeteer
//   npx puppeteer browsers install chrome
//   node scripts/ui-smoke.mjs
//
// Point UI_BASE at a running brain (default http://127.0.0.1:7391). The script
// creates a request through the UI, checks the drawer/chat and KB page, drops the
// request through the API, and fails on page or console errors. It skips when
// Puppeteer is not installed.

let puppeteer;
try {
  puppeteer = (await import('puppeteer')).default;
} catch {
  console.log('puppeteer not installed; skipping UI smoke');
  process.exit(0);
}

const base = process.env.UI_BASE ?? 'http://127.0.0.1:7391';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
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

try {
  await page.goto(base, { waitUntil: 'networkidle0', timeout: 30_000 });
  await page.waitForFunction(
    () => document.body.innerText.toLowerCase().includes('sandbox harness'),
    { timeout: 15_000 },
  );

  const background = await page.evaluate(() => {
    const root = document.getElementById('root')?.firstElementChild;
    return getComputedStyle(root ?? document.body).backgroundColor;
  });
  if (background === 'rgba(0, 0, 0, 0)' || background === 'rgb(255, 255, 255)') {
    throw new Error(`Tailwind did not apply; root background is ${background}`);
  }

  for (const label of ['Requests', 'Plan', 'Implement', 'Review', 'Finalize']) {
    if (!(await hasText(label))) throw new Error(`board column missing: ${label}`);
  }

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

  await clickText('Knowledge base');
  await page.waitForSelector('input[placeholder="Search entries..."]', { timeout: 10_000 });
  await page.waitForSelector('textarea[placeholder="Ask the knowledge base..."]', {
    timeout: 10_000,
  });
  await clickText('Floor');

  const list = await (await fetch(`${base}/api/requests?view=intake`)).json();
  const created = list.find((request) => request.title === 'Browser smoke');
  if (created) {
    await fetch(`${base}/api/requests/${created.id}/drop`, { method: 'POST' });
  }

  await page.screenshot({ path: process.env.UI_SHOT ?? '/tmp/sbox-ui-smoke.png', fullPage: true });

  if (errors.length > 0) throw new Error(`browser errors:\n${errors.join('\n')}`);
  console.log('ui smoke ok');
  console.log('root background:', background);
  console.log('request:', created?.id ?? 'not found');
} catch (error) {
  console.error('ui smoke FAILED:', error.message);
  console.error('page text:', (await page.evaluate(() => document.body.innerText)).slice(0, 800));
  if (errors.length > 0) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
