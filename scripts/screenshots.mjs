#!/usr/bin/env node
// Regenerate the README/Help screenshots from a staged demo board.
//
// The images are committed, so this is a maintainer tool rather than a test. It
// needs a built SPA and Puppeteer, which is deliberately not a project dependency:
//   npm run build
//   npm install --no-save puppeteer
//   npx puppeteer browsers install chrome
//   node scripts/screenshots.mjs [--allow-missing-puppeteer]
//
// A missing Puppeteer fails the run: a skipped capture is not a refresh of the
// committed images. --allow-missing-puppeteer is the deliberate opt-out and
// prints the current image timestamps instead.
//
// Everything runs against a throwaway database, data dir, and config. The
// spawned server and the capture browser both get a pinned env from
// scripts/e2e/env.mjs, so host app settings, credentials, and locale cannot
// change the staged images. No agent turn starts: the master timer is longer
// than this script's deadline, and a current scorecard keeps the summary
// scheduler from catching up.
//
// Locate elements through the data-testid hooks, the Documentation aria-label, and
// the Getting started Help slug below, never through visible copy.
// scripts/screenshots.test.mjs fails when one used here is missing from the SPA or
// the Help manifest.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPinnedEnv,
  buildScreenshotPins,
  SCREENSHOT_BROWSER_PINS,
} from './e2e/env.mjs';
import { resolvePuppeteer } from './e2e/puppeteer.mjs';
import { createSignalCleanup } from './e2e/signal-cleanup.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = path.join(root, 'src', 'server', 'dist', 'app.js');
const webIndex = path.join(root, 'src', 'web', 'dist', 'index.html');
const shotsDir = path.join(root, 'docs', 'screenshots');
const boardShot = path.join(shotsDir, 'board.png');
const masterShot = path.join(shotsDir, 'master.png');
const helpShot = path.join(shotsDir, 'help-getting-started.png');
const DEADLINE_MS = 5 * 60_000;
const MASTER_INTERVAL_MINUTES = 15;
const HELP_VIEWPORT_WIDTH = 1440;
const HELP_MAX_HEIGHT = 3200;
const HELP_BOTTOM_MARGIN = 12;
const HELP_DIALOG = '[role="dialog"][aria-label="Documentation"]';
const HELP_MAIN = '[data-testid="help-main"]';
const HELP_ARTICLE = '[data-testid="help-article"][data-slug="getting-started"]';
const HELP_MERMAID = '[data-testid="help-article"] svg[id^="help-mermaid-"]';
const HELP_FENCE_MARKERS = ['flowchart TB', 'sequenceDiagram', 'flowchart LR'];
const BOARD_COLUMNS = ['intake', 'clarify', 'dispatch', 'review', 'merge', 'finalize'];

// The staged demo board. Titles live here only: seed(), markWorking(), the
// activity rows, and the readiness check all read this list, so the fixture and
// the assertions cannot drift apart. Column mapping: Requests is clarify+not
// started; Plan is clarify+started.
const STAGED_REQUESTS = [
  {
    key: 'ranking',
    title: 'Add ranking load test',
    state: 'clarify',
    started: 0,
    status: 'none',
    unchecked: 0,
    ageMs: 0,
  },
  {
    key: 'export',
    title: 'Add export endpoint',
    state: 'clarify',
    started: 0,
    status: 'idle',
    unchecked: 0,
    ageMs: 14 * 60_000,
  },
  {
    key: 'photos',
    title: 'Weekend photo workflow',
    state: 'clarify',
    started: 0,
    status: 'idle',
    unchecked: 0,
    ageMs: 20 * 60_000,
  },
  {
    key: 'auth',
    title: 'Refactor auth middleware',
    state: 'clarify',
    started: 1,
    status: 'idle',
    unchecked: 0,
    ageMs: 28 * 60_000,
  },
  {
    key: 'mobile',
    title: 'Mobile nav polish',
    state: 'clarify',
    started: 1,
    status: 'idle',
    unchecked: 0,
    ageMs: 45 * 60_000,
  },
  {
    key: 'working',
    title: 'Billing webhook retries',
    state: 'dispatch',
    started: 1,
    status: 'working',
    unchecked: 0,
    ageMs: 3 * 60_000,
  },
  {
    key: 'homelab',
    title: 'Home lab notes',
    state: 'dispatch',
    started: 1,
    status: 'idle',
    unchecked: 0,
    ageMs: 50 * 60_000,
  },
  {
    key: 'search',
    title: 'Search ranking',
    state: 'review',
    started: 1,
    status: 'idle',
    unchecked: 1,
    ageMs: 0,
  },
  {
    key: 'pagination',
    title: 'API pagination',
    state: 'review',
    started: 1,
    status: 'idle',
    unchecked: 1,
    ageMs: 60 * 60_000,
  },
  {
    key: 'worktree',
    title: 'Worktree cleanup',
    state: 'review',
    started: 1,
    status: 'idle',
    unchecked: 0,
    ageMs: 2 * 60 * 60_000,
  },
  {
    key: 'merge',
    title: 'Merge billing retries',
    state: 'merge',
    started: 1,
    status: 'idle',
    unchecked: 0,
    ageMs: 6 * 60_000,
  },
  {
    key: 'digest',
    title: 'Digest: queue semantics',
    state: 'finalize',
    started: 1,
    status: 'idle',
    unchecked: 0,
    ageMs: 3 * 60 * 60_000,
  },
];
const STAGED_BY_KEY = new Map(STAGED_REQUESTS.map((request) => [request.key, request]));

// The guard runs before the build check so --allow-missing-puppeteer also works
// on an unbuilt tree; a deliberate skip wins over "run npm run build first".
const guard = await resolvePuppeteer({
  argv: process.argv.slice(2),
  outputs: [
    { label: 'docs/screenshots/board.png', file: boardShot },
    { label: 'docs/screenshots/master.png', file: masterShot },
    { label: 'docs/screenshots/help-getting-started.png', file: helpShot },
  ],
});
if (!guard.ok) {
  for (const line of guard.lines) console.error(line);
  process.exit(guard.exitCode);
}
const puppeteer = guard.puppeteer;

if (!existsSync(appPath) || !existsSync(webIndex)) {
  console.error('screenshots: built app not found; run `npm run build` first');
  process.exit(1);
}

// The built modules own the schema and process defaults, so the seed cannot
// drift from the server.
const { openDb } = await import(path.join(root, 'src', 'server', 'dist', 'db.js'));
const { defaultProcess } = await import(
  path.join(root, 'src', 'server', 'dist', 'process', 'defaults.js')
);
const { DEFAULT_MASTER_PROMPT, DEFAULT_SUMMARY_PROMPT } = await import(
  path.join(root, 'src', 'server', 'dist', 'settings.js')
);
const Database = (await import('better-sqlite3')).default;

const temp = mkdtempSync(path.join(os.tmpdir(), 'aps-screenshots-'));
const dbPath = path.join(temp, 'screenshots.sqlite');
const dataDir = path.join(temp, 'data');
const configPath = path.join(temp, 'config.json');
const processPath = path.join(temp, 'process.json');
const errorLog = path.join(temp, 'errors.log');
const xdgConfig = path.join(temp, 'xdg-config');
const xdgState = path.join(temp, 'xdg-state');

const now = Date.now();
const day = 24 * 60 * 60_000;
const masterConfig = {
  enabled: true,
  intervalMinutes: MASTER_INTERVAL_MINUTES,
  idleMinutes: 10,
  autoReview: true,
  prompt: DEFAULT_MASTER_PROMPT,
};

let server = null;
let browser = null;
let helpCaptureHeight = 0;
const serverLogs = [];
const CLEANUP_TIMEOUT_MS = 3000;
let cleanupFailed = false;

async function closeBrowser() {
  const current = browser;
  if (!current) return;

  let timer;
  try {
    const needsKill = await Promise.race([
      Promise.resolve()
        .then(() => current.close())
        .then(
          () => false,
          () => true,
        ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(true), CLEANUP_TIMEOUT_MS);
      }),
    ]);

    if (needsKill) {
      try {
        current.process()?.kill('SIGKILL');
      } catch {
        // The browser already exited; nothing left to release.
      }
    }
  } finally {
    clearTimeout(timer);
    if (browser === current) browser = null;
  }
}

async function stopServer() {
  const current = server;
  if (!current) return;
  if (current.exitCode !== null || current.signalCode !== null) {
    server = null;
    return;
  }

  const exited = new Promise((resolve) => current.once('exit', resolve));
  current.kill('SIGTERM');
  let timer;
  try {
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          try {
            current.kill('SIGKILL');
          } catch {
            // The server exited between SIGTERM and the timeout.
          }
          resolve();
        }, CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (server === current) server = null;
  }
}

function removeTemp() {
  rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

async function cleanup() {
  const steps = [
    ['browser', closeBrowser],
    ['server', stopServer],
    ['temp dir', removeTemp],
  ];
  for (const [label, step] of steps) {
    try {
      await step();
    } catch (error) {
      cleanupFailed = true;
      console.error(
        `screenshots: ${label} cleanup failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

// A second signal cannot await cleanup, so release every handle synchronously
// and let the coordinator exit immediately.
function forceCleanup() {
  if (browser) {
    try {
      browser.process()?.kill('SIGKILL');
    } catch {
      // The browser already exited.
    }
    browser = null;
  }
  if (server) {
    try {
      server.kill('SIGKILL');
    } catch {
      // The server already exited.
    }
    server = null;
  }
  try {
    rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Best effort on the forced path; the coordinator exits anyway.
  }
}

// Installed before capture() can spawn the brain or browser, so Ctrl-C during
// startup still routes through the one cleanup path.
const signalCleanup = createSignalCleanup({ cleanup, force: forceCleanup });

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function seed() {
  const db = openDb(dbPath);
  try {
    const cellProcess = defaultProcess(masterConfig);
    // The demo drawer shows every segment enabled, like an operator who has
    // turned on the full pipeline for this cell.
    cellProcess.segments = cellProcess.segments.map((segment) => ({ ...segment, enabled: true }));

    const personalId = randomUUID();
    const workId = randomUUID();
    const insertCell = db.prepare(
      `INSERT INTO cells
         (id, name, master_enabled, master_interval_minutes, max_concurrent, harness, model,
          effort, process_json, created_at)
       VALUES (?, ?, 1, NULL, 3, NULL, NULL, NULL, ?, ?)`,
    );
    insertCell.run(personalId, 'Personal', null, now - 30 * day);
    insertCell.run(workId, 'Work repo', JSON.stringify(cellProcess), now - 30 * day);

    const insertRequest = db.prepare(
      `INSERT INTO requests
         (id, title, body, state, groomed, clarify_started, agent_status, unchecked, cell_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const ids = new Map();
    for (const request of STAGED_REQUESTS) {
      const id = randomUUID();
      ids.set(request.key, id);
      const updatedAt = now - request.ageMs;
      insertRequest.run(
        id,
        request.title,
        `Staged demo request for the ${request.state} segment.`,
        request.state,
        request.started,
        request.started,
        request.status,
        request.unchecked,
        workId,
        updatedAt - 2 * 60 * 60_000,
        updatedAt,
      );
    }

    const insertEvent = db.prepare(
      `INSERT INTO master_events (id, cell_id, request_id, action, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const events = [
      [
        'cycle',
        null,
        0,
        JSON.stringify({
          dispatch: 4,
          started: 1,
          prodded: 1,
          advanced: 1,
          followUps: 1,
          skipped: 1,
        }),
      ],
      ['prod', 'search', 20_000, `${STAGED_BY_KEY.get('search').title} in Review`],
      ['review', 'search', 14_000, `${STAGED_BY_KEY.get('search').title} ready for review`],
      ['advance', 'merge', 9_000, `${STAGED_BY_KEY.get('merge').title} → Finalize`],
      ['followup', 'ranking', 5_000, STAGED_BY_KEY.get('ranking').title],
      ['skip', 'working', 2_000, `${STAGED_BY_KEY.get('working').title} still working`],
    ];
    for (const [action, key, ageMs, detail] of events) {
      insertEvent.run(
        randomUUID(),
        workId,
        key ? (ids.get(key) ?? null) : null,
        action,
        detail,
        now - ageMs,
      );
    }

    // A current scorecard keeps the summary scheduler from generating one (and
    // starting a model turn) during capture.
    const stats = {
      windowStart: now - 6 * 60 * 60_000,
      windowEnd: now,
      windowMinutes: 360,
      cell: { id: workId, name: 'Work repo' },
      requests: {
        total: 12,
        byState: {
          clarify: 5,
          dispatch: 2,
          review: 3,
          merge: 1,
          finalize: 1,
          done: 0,
          dropped: 0,
        },
        created: 4,
        updated: 12,
        completed: 0,
        dropped: 0,
        stalled: [],
        unchecked: 2,
        agentStatus: { none: 1, idle: 10, working: 1, blocked: 0, error: 0 },
      },
      activity: {
        cycles: 3,
        started: 2,
        prodded: 4,
        reviewed: 3,
        advanced: 2,
        followUps: 1,
        skipped: 1,
        followUpTitles: [STAGED_BY_KEY.get('ranking').title],
        skipReasons: [`${STAGED_BY_KEY.get('working').title} still working`],
      },
      previous: {
        created: 2,
        completed: 1,
        dropped: 0,
        activity: {
          cycles: 2,
          started: 1,
          prodded: 2,
          reviewed: 1,
          advanced: 1,
          followUps: 0,
          skipped: 0,
        },
      },
    };
    db.prepare(
      `INSERT INTO cell_summaries
         (id, cell_id, window_start, window_end, window_minutes, content, stats_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      workId,
      stats.windowStart,
      stats.windowEnd,
      stats.windowMinutes,
      [
        '## Summary',
        'A steady window: work moved through Review and Merge with one follow-up.',
        '',
        '## Throughput',
        '- 4 created, 0 completed, 0 dropped',
        '- 12 requests updated in the window',
        '',
        '## Pipeline',
        '- 5 in Requests/Plan, 2 in Implement, 3 in Review',
        '- 1 in Merge, 1 in Finalize, 2 unchecked',
        '',
        '## Automation',
        '- 3 cycles · 2 started · 4 prodded · 3 reviewed',
        '- 2 advanced · 1 follow-up · 1 skipped',
        '',
        '## Risks',
        '- Billing webhook retries is still working.',
        '',
        '## Trend',
        'More activity than the previous window.',
      ].join('\n'),
      JSON.stringify(stats),
      now,
    );

    const masterDir = path.join(dataDir, 'requests', `__master__:${workId}`);
    mkdirSync(masterDir, { recursive: true });
    writeFileSync(
      path.join(masterDir, 'transcript.json'),
      JSON.stringify(
        [
          {
            role: 'you',
            kind: 'text',
            text: 'Give me a quick status for this cell.',
            ts: now - 120_000,
          },
          {
            role: 'agent',
            kind: 'text',
            text:
              'Last cycle: 1 prodded, 1 advanced, 1 follow-up, 1 skipped. ' +
              'Search ranking is in Review after the agent reported READY FOR REVIEW. ' +
              'Merge billing retries is queued for Finalize.',
            ts: now - 110_000,
          },
        ],
        null,
        2,
      ),
    );

    return { personalId, workId };
  } finally {
    db.close();
  }
}

function writeConfig() {
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        master: masterConfig,
        summary: {
          enabled: true,
          intervalMinutes: 6 * 60,
          windowMinutes: 6 * 60,
          prompt: DEFAULT_SUMMARY_PROMPT,
        },
      },
      null,
      2,
    )}\n`,
  );
}

function startServer(port) {
  return spawn(process.execPath, [appPath], {
    cwd: root,
    env: buildPinnedEnv(
      process.env,
      buildScreenshotPins({
        root,
        temp,
        dbPath,
        dataDir,
        configPath,
        processPath,
        errorLogPath: errorLog,
        xdgConfig,
        xdgState,
        port,
      }),
    ),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function markWorking() {
  const db = new Database(dbPath);
  try {
    db.pragma('busy_timeout = 5000');
    const row = db
      .prepare('SELECT id FROM requests WHERE title = ?')
      .get(STAGED_BY_KEY.get('working').title);
    assert(row, 'staged working request is missing');
    db.prepare("UPDATE requests SET agent_status = 'working' WHERE id = ?").run(row.id);
  } finally {
    db.close();
  }
}

async function helpDiagramState(page) {
  return page.evaluate(
    ({ articleSelector, mermaidSelector, markers }) => {
      const article = document.querySelector(articleSelector);
      if (!article) return { found: false, svgs: 0, spinner: false, fences: [], text: '' };

      const text = article.innerText;
      const svgs = [...document.querySelectorAll(mermaidSelector)];
      return {
        found: true,
        svgs: svgs.length,
        spinner: text.includes('Rendering diagram…'),
        fences: markers.filter((marker) => text.includes(marker)),
        text: text.slice(0, 300),
        rects: svgs.map((svg) => {
          // The wrapper carries the diagram's padding; measure it so the
          // capture includes the full bordered card.
          const rect = (svg.parentElement ?? svg).getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
        }),
      };
    },
    { articleSelector: HELP_ARTICLE, mermaidSelector: HELP_MERMAID, markers: HELP_FENCE_MARKERS },
  );
}

function describeHelpState(state) {
  if (!state?.found) return 'the Help article is missing';
  const details = [`${state.svgs} Mermaid SVG(s)`];
  if (state.spinner) details.push('a diagram is still loading');
  if (state.fences.length > 0) details.push(`source fallback markers: ${state.fences.join(', ')}`);
  return `${details.join('; ')}; article text: ${state.text}`;
}

async function waitForHelpDiagrams(page) {
  try {
    await waitFor(
      async () => {
        const state = await helpDiagramState(page);
        return state.found && state.svgs === 3 && !state.spinner;
      },
      'the three Getting started Mermaid diagrams',
      30_000,
    );
  } catch (error) {
    const state = await helpDiagramState(page).catch(() => null);
    throw new Error(
      `Help Getting started did not render three Mermaid diagrams ` +
        `(${describeHelpState(state)}): ${error.message}`,
      { cause: error },
    );
  }

  const state = await helpDiagramState(page);
  assert.equal(
    state.svgs,
    3,
    `expected 3 Getting started Mermaid diagrams (${describeHelpState(state)})`,
  );
  assert(!state.spinner, `a Getting started diagram is still loading (${describeHelpState(state)})`);
  return state;
}

function assertHelpDiagramsInView(state, height) {
  for (const [index, rect] of state.rects.entries()) {
    assert(
      rect.left >= 0 && rect.right <= HELP_VIEWPORT_WIDTH,
      `Help diagram ${index + 1} is outside the ${HELP_VIEWPORT_WIDTH}px capture width`,
    );
    assert(
      rect.top >= 0 && rect.bottom <= height,
      `Help diagram ${index + 1} bottom ${Math.ceil(rect.bottom)}px exceeds the ${height}px capture height`,
    );
  }
}

async function fitHelpViewport(page) {
  let height = page.viewport()?.height ?? 950;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.evaluate((selector) => {
      const scroll = document.querySelector(selector);
      if (scroll) scroll.scrollTop = 0;
    }, HELP_MAIN);

    const state = await helpDiagramState(page);
    assert.equal(
      state.svgs,
      3,
      `expected 3 Getting started Mermaid diagrams (${describeHelpState(state)})`,
    );

    const needed = Math.ceil(
      Math.max(...state.rects.map((rect) => rect.bottom)) + HELP_BOTTOM_MARGIN,
    );
    if (needed > HELP_MAX_HEIGHT) {
      throw new Error(
        `Help diagrams need ${needed}px of capture height; the limit is ${HELP_MAX_HEIGHT}px. ` +
          'Reduce the Getting started content or raise HELP_MAX_HEIGHT deliberately.',
      );
    }
    if (needed <= height) {
      assertHelpDiagramsInView(state, height);
      return height;
    }

    height = needed;
    await page.setViewport({
      width: HELP_VIEWPORT_WIDTH,
      height,
      deviceScaleFactor: 2,
    });
  }

  throw new Error(`Help diagrams did not fit within ${HELP_MAX_HEIGHT}px after resizing`);
}

function pngSize(file) {
  const bytes = readFileSync(file);
  assert(bytes.length > 24, `${file} is not a PNG`);
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG', `${file} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function capture() {
  const { workId } = seed();
  writeConfig();
  mkdirSync(shotsDir, { recursive: true });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = startServer(port);
  server.stdout.on('data', (chunk) => serverLogs.push(chunk.toString()));
  server.stderr.on('data', (chunk) => serverLogs.push(chunk.toString()));

  await waitFor(async () => {
    try {
      return (await fetch(`${base}/health`)).ok;
    } catch {
      return false;
    }
  }, 'the brain to listen');

  // Startup reconcile rewrites persisted `working` to `idle`; apply the staged
  // working card once the server is up.
  markWorking();

  browser = await puppeteer.launch({
    headless: true,
    // Puppeteer's default handlers call process.exit(130/143) as soon as the
    // signal arrives, which would skip our async cleanup. Let the coordinator
    // own both signals instead.
    handleSIGINT: false,
    handleSIGTERM: false,
    env: buildPinnedEnv(process.env, SCREENSHOT_BROWSER_PINS),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=en-US'],
  }).catch((error) => {
    throw new Error(
      `${error.message}\n  hint: run \`npx puppeteer browsers install chrome\` ` +
        '(or set PUPPETEER_EXECUTABLE_PATH)',
    );
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 2 });

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('favicon')) {
      pageErrors.push(`console: ${message.text()}`);
    }
  });

  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('[data-testid="new-request"]', { visible: true, timeout: 15_000 });
  await waitFor(
    async () => {
      const columns = await page.$$eval('[data-testid^="column-"]', (nodes) =>
        nodes.map((node) => node.getAttribute('data-testid')),
      );
      const expected = BOARD_COLUMNS.map((column) => `column-${column}`);
      return columns.join(',') === expected.join(',');
    },
    'the board shell',
  );

  for (const request of STAGED_REQUESTS) {
    await waitFor(
      () =>
        page.evaluate(
          (label) =>
            [...document.querySelectorAll('[data-testid="request-card"]')].some((card) =>
              card.textContent?.includes(label),
            ),
          request.title,
        ),
      `board card ${request.title}`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.screenshot({ path: boardShot, captureBeyondViewport: false });

  const cellOption = `[data-testid="cell-option"][data-cell-id="${workId}"]`;
  await page.waitForSelector(cellOption, { visible: true, timeout: 10_000 });
  await page.click(cellOption);
  await page.click('[data-testid="nav-master"]');
  await page.waitForSelector(`[data-testid="master-detail"][data-cell-id="${workId}"]`, {
    visible: true,
    timeout: 15_000,
  });
  await page.waitForSelector('[data-testid="master-policy"]', { visible: true, timeout: 10_000 });
  await page.waitForSelector('[data-testid="master-cron-loop"]', { visible: true, timeout: 10_000 });
  await page.waitForSelector(
    '[data-testid="master-schedule"][data-interval-minutes="15"][data-enabled="true"]',
    { visible: true, timeout: 10_000 },
  );
  await page.waitForSelector('[data-testid="master-chat"]', { visible: true, timeout: 10_000 });
  await waitFor(
    () =>
      page.evaluate(
        () =>
          document
            .querySelector('[data-testid="chat-thread"]')
            ?.textContent?.includes('Give me a quick status for this cell.') ?? false,
      ),
    'the staged master chat',
  );

  // Let the drawer's first layout/paint settle before capturing the viewport.
  await new Promise((resolve) => setTimeout(resolve, 750));
  await page.screenshot({ path: masterShot, captureBeyondViewport: false });

  await page.click('[data-testid="nav-help"]');
  await page.waitForSelector(HELP_DIALOG, { visible: true, timeout: 10_000 });
  await page.waitForSelector(HELP_ARTICLE, { visible: true, timeout: 15_000 });
  await waitForHelpDiagrams(page);
  helpCaptureHeight = await fitHelpViewport(page);

  // Let the resized Help layout paint before capturing.
  await new Promise((resolve) => setTimeout(resolve, 250));
  await page.screenshot({ path: helpShot, captureBeyondViewport: false });

  if (pageErrors.length > 0) throw new Error(`browser errors:\n${pageErrors.join('\n')}`);
}

const deadline = new Promise((_, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`screenshot capture exceeded ${DEADLINE_MS / 60_000} minutes`)),
    DEADLINE_MS,
  );
  timer.unref();
});

try {
  await Promise.race([capture(), deadline]);
  assert.deepEqual(pngSize(boardShot), { width: 2880, height: 1900 });
  assert.deepEqual(pngSize(masterShot), { width: 2880, height: 1900 });
  assert.deepEqual(pngSize(helpShot), { width: 2880, height: helpCaptureHeight * 2 });
  console.log(`wrote ${path.relative(root, boardShot)}`);
  console.log(`wrote ${path.relative(root, masterShot)}`);
  console.log(`wrote ${path.relative(root, helpShot)}`);
} catch (error) {
  console.error('screenshot capture failed:', error.message);
  if (serverLogs.length > 0) {
    console.error('server log:');
    console.error(serverLogs.join('').trim().split('\n').slice(-20).join('\n'));
  }
  process.exitCode = 1;
} finally {
  await signalCleanup.run();
  signalCleanup.dispose();
  if (cleanupFailed && process.exitCode === undefined) process.exitCode = 1;
}
