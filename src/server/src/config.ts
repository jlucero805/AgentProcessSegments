import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARNESS_IDS, isHarnessId, type HarnessId } from './domain/harness.js';
import { readEnv, readNonBlankEnv, readNonEmptyEnv } from './env.js';

export type { HarnessId };

const IMPLICIT_DEFAULT_MODELS: Record<HarnessId, string | null> = {
  claude: null,
  // OpenCode's own default is a slow free tier; prefer the configured fast model.
  opencode: 'opencode-go/deepseek-v4.1-flash',
};

function parseHarness(raw: string | undefined): HarnessId {
  if (raw === undefined || raw === '') return 'claude';
  if (!isHarnessId(raw)) {
    throw new Error(
      `unknown APS_HARNESS "${raw}"; expected one of ${HARNESS_IDS.join(', ')}`,
    );
  }
  return raw;
}

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
  /** The default adapter's binary; kept for callers that only need one. */
  harnessBin: string;
  /** One binary per adapter, so a mixed-harness brain can find both CLIs. */
  harnessBins: Record<HarnessId, string>;
  configPath: string;
  processPath: string;
  errorLogPath: string;
  errorLogMaxBytes: number;
  /** Hard ceiling for one agent turn; a silent child is killed with an error. */
  turnTimeoutMs: number;
  /** Model used by the process-default harness when nothing else names one. */
  defaultModel: string | null;
  /** Default model per adapter; APS_DEFAULT_MODEL only overrides the default adapter. */
  defaultModels: Record<HarnessId, string | null>;
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
  const explicit = readNonEmptyEnv(env, name);
  if (explicit !== undefined) return { path: explicit, legacy: false };
  return preferExisting(canonical, legacy);
}

/** Env names that are filesystem paths in `Config`; a blank value is a mistake. */
const PATH_ENV_NAMES = [
  'DATA_DIR',
  'CONFIG',
  'PROCESS',
  'ERROR_LOG',
  'DB',
  'WEB_DIR',
  'DOCS_DIR',
  'PLUGINS_DIR',
  'TERMINAL_CWD',
  'HARNESS_BIN',
  'CLAUDE_BIN',
  'OPENCODE_BIN',
] as const;

/** Path env names without an APS/SBOX alias. A blank value is a mistake too. */
const BASE_PATH_ENV_NAMES = ['XDG_CONFIG_HOME', 'XDG_STATE_HOME'] as const;

/**
 * Names of blank path overrides, sorted for a stable startup message. Both
 * APS/SBOX prefixes are reported because either is the variable the operator
 * meant to set, and the XDG base directories are reported by their exact names.
 * Only the blank check reads the value; it never reaches a log.
 */
export function blankPathEnvNames(env: NodeJS.ProcessEnv): string[] {
  const names: string[] = [];
  for (const name of PATH_ENV_NAMES) {
    for (const prefix of ['APS_', 'SBOX_']) {
      const key = `${prefix}${name}`;
      const value = env[key];
      if (value !== undefined && value.trim() === '') names.push(key);
    }
  }
  for (const key of BASE_PATH_ENV_NAMES) {
    const value = env[key];
    if (value !== undefined && value.trim() === '') names.push(key);
  }
  return names.sort();
}

/** One startup warning for blank path overrides, or `null` when there is nothing to report. */
export function blankPathWarning(names: string[]): string | null {
  if (names.length === 0) return null;
  return (
    `ignoring blank path environment variables: ${names.join(', ')}. ` +
    'Set a non-empty value or unset them; the built-in default or legacy location is in use.'
  );
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  home = os.homedir(),
): Config {
  const xdgConfig =
    readNonBlankEnv(env, 'XDG_CONFIG_HOME') ?? path.join(home, '.config');
  const xdgState =
    readNonBlankEnv(env, 'XDG_STATE_HOME') ??
    path.join(home, '.local', 'state');

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
  const harness = parseHarness(readEnv(env, 'HARNESS'));
  // Adapter-specific binaries win. APS_HARNESS_BIN (and its SBOX_* alias) is the
  // legacy fallback for the default adapter only, never for the other adapter.
  const legacyBin = readNonEmptyEnv(env, 'HARNESS_BIN');
  const harnessBins: Record<HarnessId, string> = {
    claude:
      readNonEmptyEnv(env, 'CLAUDE_BIN') ??
      (harness === 'claude' ? legacyBin : undefined) ??
      'claude',
    opencode:
      readNonEmptyEnv(env, 'OPENCODE_BIN') ??
      (harness === 'opencode' ? legacyBin : undefined) ??
      'opencode',
  };

  const explicitDefault = readEnv(env, 'DEFAULT_MODEL');
  const defaultModels: Record<HarnessId, string | null> = {
    claude:
      harness === 'claude'
        ? explicitDefault === undefined
          ? IMPLICIT_DEFAULT_MODELS.claude
          : explicitDefault === ''
            ? null
            : explicitDefault
        : IMPLICIT_DEFAULT_MODELS.claude,
    opencode:
      harness === 'opencode'
        ? explicitDefault === undefined
          ? IMPLICIT_DEFAULT_MODELS.opencode
          : explicitDefault === ''
            ? null
            : explicitDefault
        : IMPLICIT_DEFAULT_MODELS.opencode,
  };

  return {
    host: readEnv(env, 'HOST') ?? '127.0.0.1',
    port,
    dbPath: db.path,
    webDir: readNonEmptyEnv(env, 'WEB_DIR') ?? path.join(cwd, 'src', 'web', 'dist'),
    // The in-app Help surface reads the repo's Markdown and screenshots.
    docsDir: readNonEmptyEnv(env, 'DOCS_DIR') ?? path.join(cwd, 'docs'),
    dataDir: data.path,
    pluginsDir:
      readNonEmptyEnv(env, 'PLUGINS_DIR') ?? path.join(data.path, 'plugins'),
    brainUrl: readEnv(env, 'BRAIN_URL') ?? `http://127.0.0.1:${port}`,
    harness,
    harnessBin: harnessBins[harness],
    harnessBins,
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
    defaultModel: defaultModels[harness],
    defaultModels,
    // The browser terminal is a direct shell, separate from agent sessions.
    // Disable with APS_TERMINAL=0 when the brain is exposed beyond loopback.
    terminalEnabled: readEnv(env, 'TERMINAL') !== '0',
    terminalCwd: readNonEmptyEnv(env, 'TERMINAL_CWD') ?? cwd,
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

export function requestsDir(dataDir: string): string {
  return path.join(dataDir, 'requests');
}

export function requestDir(config: Config, id: string): string {
  return path.join(requestsDir(config.dataDir), id);
}
