import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnv } from './env.js';

export type HarnessId = 'claude' | 'opencode';

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  webDir: string;
  docsDir: string;
  dataDir: string;
  pluginsDir: string;
  brainUrl: string;
  harness: HarnessId;
  harnessBin: string;
  configPath: string;
  processPath: string;
  errorLogPath: string;
  errorLogMaxBytes: number;
  /** Hard ceiling for one agent turn; a silent child is killed with an error. */
  turnTimeoutMs: number;
  /** Model used when neither the request nor its cell names one. */
  defaultModel: string | null;
  terminalEnabled: boolean;
  terminalCwd: string;
  /** Legacy default paths still in use; `app.ts` warns and points at the migration. */
  legacyPaths: string[];
}

interface PathChoice {
  path: string;
  legacy: boolean;
}

function preferExisting(canonical: string, legacy: string): PathChoice {
  if (existsSync(canonical)) return { path: canonical, legacy: false };
  if (existsSync(legacy)) return { path: legacy, legacy: true };
  return { path: canonical, legacy: false };
}

function resolvePath(
  env: NodeJS.ProcessEnv,
  name: string,
  canonical: string,
  legacy: string,
): PathChoice {
  const explicit = readEnv(env, name);
  if (explicit !== undefined) return { path: explicit, legacy: false };
  return preferExisting(canonical, legacy);
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  home = os.homedir(),
): Config {
  const xdgConfig = env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  const xdgState = env.XDG_STATE_HOME ?? path.join(home, '.local', 'state');

  const data = resolvePath(
    env,
    'DATA_DIR',
    path.join(home, '.agent-process-segments'),
    path.join(home, '.sandbox-harness'),
  );
  const config = resolvePath(
    env,
    'CONFIG',
    path.join(xdgConfig, 'agent-process-segments', 'config.json'),
    path.join(xdgConfig, 'sandbox-harness', 'config.json'),
  );
  const process = resolvePath(
    env,
    'PROCESS',
    path.join(xdgConfig, 'agent-process-segments', 'process.json'),
    path.join(xdgConfig, 'sandbox-harness', 'process.json'),
  );
  const errorLog = resolvePath(
    env,
    'ERROR_LOG',
    path.join(xdgState, 'agent-process-segments', 'errors.log'),
    path.join(xdgState, 'sandbox-harness', 'errors.log'),
  );
  const db = resolvePath(
    env,
    'DB',
    path.join(cwd, 'agent-process-segments.sqlite'),
    path.join(cwd, 'sandbox-harness.sqlite'),
  );

  const legacyPaths = [data, config, process, errorLog, db]
    .filter((choice) => choice.legacy)
    .map((choice) => choice.path);

  const port = Number(readEnv(env, 'PORT') ?? 7391);
  const harness: HarnessId = readEnv(env, 'HARNESS') === 'opencode' ? 'opencode' : 'claude';
  const defaultBin =
    harness === 'opencode' ? 'opencode' : (readEnv(env, 'CLAUDE_BIN') ?? 'claude');
  const configuredModel = readEnv(env, 'DEFAULT_MODEL');

  return {
    host: readEnv(env, 'HOST') ?? '127.0.0.1',
    port,
    dbPath: db.path,
    webDir: readEnv(env, 'WEB_DIR') ?? path.join(cwd, 'src', 'web', 'dist'),
    // The in-app Help surface reads the repo's Markdown and screenshots.
    docsDir: readEnv(env, 'DOCS_DIR') ?? path.join(cwd, 'docs'),
    dataDir: data.path,
    pluginsDir: readEnv(env, 'PLUGINS_DIR') ?? path.join(data.path, 'plugins'),
    brainUrl: readEnv(env, 'BRAIN_URL') ?? `http://127.0.0.1:${port}`,
    harness,
    harnessBin: readEnv(env, 'HARNESS_BIN') ?? defaultBin,
    configPath: config.path,
    processPath: process.path,
    errorLogPath: errorLog.path,
    errorLogMaxBytes: (() => {
      const value = Number(readEnv(env, 'ERROR_LOG_MAX_BYTES') ?? 2 * 1024 * 1024);
      return Number.isFinite(value) && value > 0 ? value : 2 * 1024 * 1024;
    })(),
    // A live but silent CLI must not hold a request open forever. Ten minutes
    // is the default; override with APS_TURN_TIMEOUT_MS.
    turnTimeoutMs: (() => {
      const value = Number(readEnv(env, 'TURN_TIMEOUT_MS') ?? 10 * 60 * 1000);
      return Number.isFinite(value) && value > 0 ? value : 10 * 60 * 1000;
    })(),
    // OpenCode's own default is a slow free tier. Prefer the configured fast
    // model when no request or cell overrides it.
    defaultModel:
      configuredModel === ''
        ? null
        : (configuredModel ??
          (harness === 'opencode' ? 'opencode-go/deepseek-v4.1-flash' : null)),
    // The browser terminal is a direct shell, separate from agent sessions.
    // Disable with APS_TERMINAL=0 when the brain is exposed beyond loopback.
    terminalEnabled: readEnv(env, 'TERMINAL') !== '0',
    terminalCwd: readEnv(env, 'TERMINAL_CWD') ?? cwd,
    legacyPaths,
  };
}

export function legacyPathWarning(paths: string[]): string | null {
  if (paths.length === 0) return null;
  return (
    `using legacy Sandbox Harness paths: ${paths.join(', ')}. ` +
    'Run `npm run migrate:paths` to move them to the new names.'
  );
}

export function requestDir(config: Config, id: string): string {
  return path.join(config.dataDir, 'requests', id);
}
