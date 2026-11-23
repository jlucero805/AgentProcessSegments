#!/usr/bin/env node
// End-to-end API workflow against a real built brain and a deterministic mock
// Claude CLI. Everything lives in a temp DB/data dir and one dedicated E2E cell;
// nothing is written to the live database or the knowledge base.
//
// The brain's env is built from scratch by `buildE2eEnv` (scripts/e2e/env.mjs):
// host APS_*/SBOX_* settings and API credentials are ignored so the mock always
// runs, and HOME/NODE_ENV/plugins/brain URL are pinned to the temp run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { buildE2eEnv, buildE2ePins } from './e2e/env.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = mkdtempSync(path.join(os.tmpdir(), 'sbox-e2e-'));
const home = path.join(temp, 'home');
const pluginsDir = path.join(temp, 'plugins');
const mock = path.join(root, 'scripts', 'e2e', 'mock-claude.mjs');
const dbPath = path.join(temp, 'e2e.sqlite');
const logs = [];
let server = null;

function log(message) {
  console.log(message);
}

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

async function waitFor(check, label, timeout = 30_000) {
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

function makeClient(base) {
  return async function call(method, route, body) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    if (text !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      throw new Error(`${method} ${route} -> ${response.status}: ${text}`);
    }
    return data;
  };
}

async function ageRequest(id, ageMs) {
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.prepare("UPDATE requests SET agent_status = 'idle', updated_at = ? WHERE id = ?").run(
    Date.now() - ageMs,
    id,
  );
  db.close();
}

async function setWorking(id, working) {
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.prepare('UPDATE requests SET agent_status = ? WHERE id = ?').run(
    working ? 'working' : 'idle',
    id,
  );
  db.close();
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const call = makeClient(base);

  chmodSync(mock, 0o755);
  mkdirSync(home, { recursive: true });
  server = spawn(process.execPath, ['src/server/dist/app.js'], {
    cwd: root,
    env: buildE2eEnv(
      process.env,
      buildE2ePins({ root, mock, home, temp, dbPath, port, base, pluginsDir }),
    ),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  server.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  await waitFor(async () => {
    const response = await fetch(`${base}/health`);
    return response.ok;
  }, 'brain health');

  const global = await call('GET', '/api/process');
  const segments = global.segments.map((segment) => ({
    ...segment,
    followUps: { ...segment.followUps },
  }));
  const implement = segments.find((segment) => segment.id === 'implement');
  assert.ok(implement, 'implement segment exists');
  implement.enabled = true;
  implement.idleMinutes = 1;
  implement.maxPerCycle = 1;
  implement.readyMarker = 'READY FOR REVIEW';
  implement.advanceTo = 'review';
  implement.followUps.enabled = true;

  const cell = await call('POST', '/api/cells', {
    name: 'E2E',
    process: { version: 1, segments },
    maxConcurrent: 1,
    masterIntervalMinutes: 5,
  });
  assert.equal(cell.name, 'E2E');
  assert.equal(cell.maxConcurrent, 1);
  log(`cell: ${cell.id}`);

  const request = await call('POST', '/api/requests', {
    title: 'E2E workflow',
    body: 'Exercise the API workflow with the mock agent.',
    cellId: cell.id,
  });

  await call('POST', `/api/requests/${request.id}/clarify/start?detach=1`);
  await waitFor(async () => {
    const current = await call('GET', `/api/requests/${request.id}`);
    const clarify = await call('GET', `/api/requests/${request.id}/clarify`);
    return current.agentStatus === 'idle' && current.clarifyStarted && !clarify.active;
  }, 'clarify start');
  await call('POST', `/api/requests/${request.id}/clarify/send`, {
    text: 'Use the E2E path.',
  });
  const clarify = await call('GET', `/api/requests/${request.id}/clarify`);
  assert.ok(
    clarify.transcript.some((message) => message.text.includes('Clarification turn complete')),
    'clarify transcript contains the mock turn',
  );

  await call('POST', `/api/requests/${request.id}/transition`, { to: 'dispatch' });
  await ageRequest(request.id, 2 * 60_000);

  const cycle = await call('POST', `/api/master/run?cellId=${encodeURIComponent(cell.id)}`);
  assert.equal(cycle.prodded, 1, 'master prodded the dispatch request');
  assert.equal(cycle.dispatch, 1, 'master selected the dispatch request');

  await waitFor(async () => {
    const current = await call('GET', `/api/requests/${request.id}`);
    const events = await call('GET', `/api/master/events?cellId=${encodeURIComponent(cell.id)}`);
    const cellRequests = await call('GET', `/api/requests?cellId=${encodeURIComponent(cell.id)}`);
    return (
      current.state === 'review' &&
      events.some((event) => event.action === 'followup') &&
      cellRequests.some((item) => item.title === 'E2E follow-up')
    );
  }, 'master background settlement');

  const reviewed = await call('GET', `/api/requests/${request.id}`);
  assert.equal(reviewed.state, 'review');

  const cellRequests = await call('GET', `/api/requests?cellId=${encodeURIComponent(cell.id)}`);
  const followUp = cellRequests.find((item) => item.title === 'E2E follow-up');
  assert.ok(followUp, 'follow-up request exists');
  assert.equal(followUp.cellId, cell.id, 'follow-up stays in the E2E cell');

  const events = await call('GET', `/api/master/events?cellId=${encodeURIComponent(cell.id)}`);
  assert.ok(events.some((event) => event.action === 'followup'));
  assert.ok(events.some((event) => event.action === 'advance' || event.action === 'review'));

  // Per-cell master chat uses its own reserved session.
  const masterSession = `__master__:${cell.id}`;
  const encodedMaster = encodeURIComponent(masterSession);
  await call('POST', `/api/requests/${encodedMaster}/clarify/send`, {
    text: 'What are you watching?',
  });
  const master = await call('GET', `/api/requests/${encodedMaster}/clarify`);
  assert.ok(
    master.transcript.some((message) => message.text.includes('E2E cell master')),
    'per-cell master chat answered',
  );

  // The concurrency cap blocks a new prod while another request is working.
  const blocked = await call('POST', '/api/requests', {
    title: 'E2E concurrency guard',
    body: 'must not be prodded while the cell is busy',
    cellId: cell.id,
  });
  await call('POST', `/api/requests/${blocked.id}/transition`, { to: 'dispatch' });
  await setWorking(blocked.id, true);
  await ageRequest(blocked.id, 2 * 60_000);
  // ageRequest reset the status; set it back to working.
  await setWorking(blocked.id, true);
  const blockedCycle = await call('POST', `/api/master/run?cellId=${encodeURIComponent(cell.id)}`);
  assert.equal(blockedCycle.prodded, 0, 'master respects the concurrency cap');
  const blockedEvents = await call('GET', `/api/master/events?cellId=${encodeURIComponent(cell.id)}`);
  assert.ok(
    blockedEvents.some((event) => event.detail.includes('concurrency limit')),
    'concurrency skip is logged',
  );

  // Finalize is allowed, but the E2E suite never indexes into the KB.
  await call('POST', `/api/requests/${request.id}/transition`, { to: 'finalize' });
  await call('POST', `/api/requests/${request.id}/finalize?detach=1`);
  await waitFor(async () => {
    const current = await call('GET', `/api/requests/${request.id}`);
    return current.agentStatus === 'idle';
  }, 'finalize turn');
  const kb = await call('GET', '/api/kb');
  assert.equal(kb.length, 0, 'E2E leaves the knowledge base empty');

  log('e2e ok: cell, clarify, dispatch/prod/review, follow-up, master chat, concurrency guard');
}

try {
  await main();
} catch (error) {
  console.error('e2e FAILED:', error.message);
  if (logs.length > 0) console.error(logs.join('').slice(-4000));
  process.exitCode = 1;
} finally {
  if (server) {
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      server.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  rmSync(temp, { recursive: true, force: true });
  if (!existsSync(temp)) log('temp cleaned');
}
