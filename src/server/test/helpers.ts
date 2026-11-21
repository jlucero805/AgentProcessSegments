import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CellRepository } from '../src/cells/repository.js';
import { Engine } from '../src/clarify/engine.js';
import { FakeTransport } from '../src/clarify/transport.js';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, type Db } from '../src/db.js';
import { KbRepository } from '../src/kb/repository.js';
import { PluginManager } from '../src/plugins/manager.js';
import { RequestRepository } from '../src/requests/repository.js';

export function testConfig(): Config {
  const base = mkdtempSync(path.join(os.tmpdir(), 'sbox-test-'));
  return {
    ...loadConfig({}, base),
    dbPath: path.join(base, 'harness.sqlite'),
    dataDir: path.join(base, 'data'),
    webDir: path.join(base, 'no-web-build'),
    pluginsDir: path.join(base, 'data', 'plugins'),
  };
}

export function line(value: unknown): string {
  return JSON.stringify(value);
}

export function initLine(sessionId = 'session-1'): string {
  return line({ type: 'system', subtype: 'init', session_id: sessionId });
}

export function textLine(text: string): string {
  return line({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  });
}

export function resultLine(text = 'ok'): string {
  return line({ type: 'result', subtype: 'success', is_error: false, result: text });
}

export function defaultScript(): string[] {
  return [initLine(), textLine('Ready '), textLine('to groom.'), resultLine()];
}

export interface Harness {
  config: Config;
  db: Db;
  repo: RequestRepository;
  cells: CellRepository;
  kb: KbRepository;
  plugins: PluginManager;
  transport: FakeTransport;
  engine: Engine;
}

export function createHarness(script: (text: string) => string[] = defaultScript): Harness {
  const config = testConfig();
  const db = openDb(config.dbPath);
  const repo = new RequestRepository(db);
  const cells = new CellRepository(db);
  const kb = new KbRepository(db);
  const plugins = new PluginManager(config.pluginsDir);
  const transport = new FakeTransport(script);
  const engine = new Engine({
    repo,
    transport,
    config,
    pluginDirs: () => plugins.installedPluginDirs(),
  });
  return { config, db, repo, cells, kb, plugins, transport, engine };
}

/** Let queued microtasks (and the turn's finally block) run. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
