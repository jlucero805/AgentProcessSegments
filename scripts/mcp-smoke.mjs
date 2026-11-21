#!/usr/bin/env node
// End-to-end proof: real brain process, real stdio MCP server, real tool calls.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(import.meta.dirname, '..');
const work = mkdtempSync(path.join(os.tmpdir(), 'sbox-mcp-'));

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const brainUrl = `http://127.0.0.1:${port}`;

const brain = spawn(process.execPath, [path.join(root, 'src/server/dist/app.js')], {
  env: {
    ...process.env,
    SBOX_DB: path.join(work, 'harness.sqlite'),
    SBOX_DATA_DIR: path.join(work, 'data'),
    SBOX_PORT: String(port),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

// A failed write must never leave a brain listening on this port.
process.on('exit', () => brain.kill());
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    brain.kill();
    process.exit(1);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBrain() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${brainUrl}/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error('brain did not start');
}

function textOf(result) {
  const block = result.content?.[0];
  return block?.type === 'text' ? block.text : '';
}

try {
  await waitForBrain();

  const created = await fetch(`${brainUrl}/api/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'MCP smoke', body: 'stdio round trip' }),
  }).then((response) => response.json());

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'src/server/dist/mcp/server.js')],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      SBOX_BRAIN_URL: brainUrl,
      SBOX_REQUEST_ID: created.id,
    },
  });

  const client = new Client({ name: 'mcp-smoke', version: '1.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log('tools:', tools.map((tool) => tool.name).sort().join(', '));

  const read = await client.callTool({ name: 'get_request', arguments: {} });
  console.log('get_request:', textOf(read).includes(created.id) ? `ok ${created.id}` : 'MISSING ID');

  const updated = await client.callTool({
    name: 'update_request',
    arguments: { acceptanceCriteria: 'proxied over stdio', groomed: true },
  });
  console.log('update_request:', updated.isError ? 'ERROR' : 'ok');

  const stored = await client.callTool({
    name: 'index_to_kb',
    arguments: { content: 'the mcp server proxies to the loopback api' },
  });
  console.log('index_to_kb:', stored.isError ? 'ERROR' : 'ok');

  const after = await fetch(`${brainUrl}/api/requests/${created.id}`).then((response) => response.json());
  console.log('persisted groomed:', after.groomed, 'criteria:', JSON.stringify(after.acceptanceCriteria));

  const kb = await fetch(`${brainUrl}/api/kb`).then((response) => response.json());
  console.log('kb entries:', kb.length, kb[0]?.title);

  await client.close();

  // A keep-alive socket from a closed client must not pin the process open.
  brain.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => brain.once('exit', () => resolve(true))),
    sleep(3000).then(() => false),
  ]);
  console.log('brain exited on SIGTERM:', exited ? 'yes' : 'NO');
  if (!exited) throw new Error('brain did not exit on SIGTERM');
} finally {
  if (brain.exitCode === null) brain.kill('SIGKILL');
  rmSync(work, { recursive: true, force: true });
}
