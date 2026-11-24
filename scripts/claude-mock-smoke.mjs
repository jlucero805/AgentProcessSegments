#!/usr/bin/env node
// Real-Claude verification without an Anthropic account.
//
// Starts a mock Anthropic Messages API that streams a tool_use for
// `mcp__aps__get_request`, then a text result. The built brain runs with
// APS_HARNESS=claude (and the legacy SBOX_HARNESS alias) and the real `claude`
// binary, so this exercises the CLI's stream-json contract, merged MCP
// config/allow rules, tool execution through the bundled `aps` MCP server, and
// `--resume` across a brain restart.
//
// Skips (exit 0) when no `claude` binary is available. Choose one with
// `--claude-bin <path>` or `CLAUDE_MOCK_SMOKE_BIN`; otherwise `claude` must be on
// PATH. Inherited APS_CLAUDE_BIN/SBOX_CLAUDE_BIN are ignored on purpose: the
// smoke's subject binary is not production config.

import { spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { buildClaudeSmokePins, buildPinnedEnv, resolveClaudeBin } from './e2e/env.mjs';

const root = path.resolve(import.meta.dirname, '..');

function isExecutableFile(file) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let claude;
try {
  claude = resolveClaudeBin({
    argv: process.argv.slice(2),
    env: process.env,
    isExecutable: isExecutableFile,
  });
} catch (error) {
  console.error(`claude mock smoke: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
if (!claude) {
  console.log(
    'claude not found (pass --claude-bin <path>, set CLAUDE_MOCK_SMOKE_BIN, or put claude on PATH); skipping Claude mock smoke',
  );
  process.exit(0);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'sbox-claude-'));
const home = path.join(tmp, 'home');
const dataDir = path.join(tmp, 'data');
const dbPath = path.join(tmp, 'brain.sqlite');
mkdirSync(home, { recursive: true });
// The brain pins explicit config paths, but the CLI itself may look at XDG.
mkdirSync(path.join(tmp, 'xdg-config'), { recursive: true });
mkdirSync(path.join(tmp, 'xdg-state'), { recursive: true });

const mockPort = await freePort();
const brainPort = await freePort();
const brainUrl = `http://127.0.0.1:${brainPort}`;
const mockUrl = `http://127.0.0.1:${mockPort}`;

const mcpServer = path.join(root, 'src/server/dist/mcp/server.js');
writeFileSync(
  path.join(home, '.claude.json'),
  `${JSON.stringify(
    {
      mcpServers: {
        userserver: {
          type: 'stdio',
          command: process.execPath,
          args: [mcpServer],
          env: { SBOX_BRAIN_URL: brainUrl, SBOX_REQUEST_ID: '' },
        },
      },
    },
    null,
    2,
  )}\n`,
);

const requests = [];
let toolCalls = 0;

function sse(res, events) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const [event, data] of events) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  res.end();
}

function messageStart(id, model) {
  return [
    'message_start',
    {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: model ?? 'claude-mock',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
  ];
}

function textReply(res, text, id = 'msg_mock_text') {
  sse(res, [
    messageStart(id),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

function toolReply(res) {
  toolCalls += 1;
  sse(res, [
    messageStart('msg_mock_tool'),
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_mock_1', name: 'mcp__aps__get_request', input: {} },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

const PROBE_MODELS = [
  { id: 'claude-mock-a', label: 'Mock A' },
  { id: 'claude-mock-b', label: 'Mock B' },
];

function structuredReply(res) {
  const input = JSON.stringify({ models: PROBE_MODELS });
  sse(res, [
    messageStart('msg_mock_probe'),
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_probe_1', name: 'StructuredOutput', input: {} },
      },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: input } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      // count_tokens requests may be empty.
    }
    requests.push({ url: req.url, body: parsed });

    if (req.url?.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    if (!req.url?.startsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    const serialized = JSON.stringify(messages);
    const hasAssistant = messages.some((message) => message?.role === 'assistant');
    const hasToolResult = serialized.includes('"tool_result"');
    const lastUser = [...messages].reverse().find((message) => message?.role === 'user');
    const carryingOn = JSON.stringify(lastUser ?? {}).includes('carry on');
    const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
    const wantsStructured = tools.some((tool) => tool?.name === 'StructuredOutput') && !hasToolResult;

    if (wantsStructured) {
      structuredReply(res);
    } else if (!hasAssistant) {
      toolReply(res);
    } else if (carryingOn) {
      // A resumed session carries the earlier assistant turn in its messages.
      textReply(res, 'RESUMED');
    } else if (hasToolResult) {
      textReply(res, 'TOOL DONE');
    } else {
      textReply(res, 'HELLO FROM MOCK');
    }
  });
});

await new Promise((resolve) => mock.listen(mockPort, '127.0.0.1', resolve));

let brain = null;
let brainLog = '';

function startBrain() {
  const child = spawn(process.execPath, [path.join(root, 'src/server/dist/app.js')], {
    env: buildPinnedEnv(
      process.env,
      buildClaudeSmokePins({
        root,
        claude,
        home,
        temp: tmp,
        dbPath,
        dataDir,
        port: brainPort,
        mockUrl,
      }),
    ),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => (brainLog += chunk.toString()));
  child.stderr.on('data', (chunk) => (brainLog += chunk.toString()));
  return child;
}

async function waitFor(predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}\n${brainLog}`);
}

async function api(method, pathname, body) {
  const response = await fetch(`${brainUrl}${pathname}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status} ${await response.text()}`);
  return response.json();
}

async function stream(pathname, body) {
  const response = await fetch(`${brainUrl}${pathname}`, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${pathname} -> ${response.status} ${await response.text()}`);
  const text = await response.text();
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function stopBrain() {
  if (!brain) return;
  const child = brain;
  brain = null;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

let requestId = null;
try {
  brain = startBrain();
  await waitFor(
    async () => {
      try {
        return (await fetch(`${brainUrl}/health`)).ok;
      } catch {
        return false;
      }
    },
    'brain health',
  );

  const request = await api('POST', '/api/requests', {
    title: 'Claude mock verification',
    body: 'The mock API drives a tool call and a reply.',
  });
  requestId = request.id;

  const first = await stream(`/api/requests/${requestId}/clarify/start`);
  const firstText = first.filter((event) => event.t === 'text').map((event) => event.text).join('');
  const tools = first.filter((event) => event.t === 'tool');
  const results = first.filter((event) => event.t === 'tool_result');

  assert(firstText.includes('TOOL DONE'), `expected the tool-round-trip text, got: ${firstText.slice(0, 300)}`);
  assert(
    tools.some((event) => event.name === 'mcp__aps__get_request'),
    `expected an mcp__aps__get_request tool card, got: ${JSON.stringify(tools).slice(0, 400)}`,
  );
  assert(results.some((event) => event.id === 'toolu_mock_1'), 'expected the tool result for toolu_mock_1');
  assert(first.some((event) => event.t === 'done'), 'expected the first turn to finish');

  const configPath = path.join(dataDir, 'requests', requestId, 'mcp-config.json');
  const mcpConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  assert(mcpConfig.mcpServers?.aps, 'generated config must include the aps server');
  assert(mcpConfig.mcpServers?.userserver, 'generated config must merge the user MCP server');

  const sessionPath = path.join(dataDir, 'requests', requestId, 'session.json');
  const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
  assert(typeof session.sessionId === 'string' && session.sessionId !== '', 'session id must persist');

  await stopBrain();
  brain = startBrain();
  await waitFor(
    async () => {
      try {
        return (await fetch(`${brainUrl}/health`)).ok;
      } catch {
        return false;
      }
    },
    'brain health after restart',
  );

  const second = await stream(`/api/requests/${requestId}/clarify/send`, { text: 'carry on' });
  const secondText = second.filter((event) => event.t === 'text').map((event) => event.text).join('');
  assert(secondText.includes('RESUMED'), `expected --resume evidence, got: ${secondText.slice(0, 300)}`);

  const resumedSession = JSON.parse(readFileSync(sessionPath, 'utf8'));
  assert(resumedSession.sessionId === session.sessionId, 'resume must reuse the saved session id');

  const catalog = await api('GET', '/api/models');
  assert(catalog.source === 'probe', `expected a probed model catalog, got ${catalog.source}`);
  assert(
    catalog.models.some((model) => model.id === 'claude-mock-a'),
    `expected the mock model list, got ${JSON.stringify(catalog.models).slice(0, 200)}`,
  );

  console.log('claude binary:', claude);
  console.log('session:', session.sessionId);
  console.log('mock requests:', requests.length, 'tool calls:', toolCalls);
  console.log('first turn: text + tool card + tool result + done');
  console.log('mcp config: harness + userserver');
  console.log('resume after brain restart: yes');
  console.log('model probe:', catalog.source, catalog.models.map((model) => model.id).join(', '));
  console.log('claude mock smoke: ok');
} catch (error) {
  console.error('claude mock smoke: FAILED');
  console.error(error instanceof Error ? error.message : error);
  if (requests.length) {
    console.error('last mock request:', JSON.stringify(requests.at(-1)).slice(0, 1500));
  }
  process.exitCode = 1;
} finally {
  await stopBrain();
  await new Promise((resolve) => mock.close(resolve));
  rmSync(tmp, { recursive: true, force: true });
}
