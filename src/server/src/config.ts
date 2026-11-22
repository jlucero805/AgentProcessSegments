import os from 'node:os';
import path from 'node:path';

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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const home = os.homedir();
  const dataDir = env.SBOX_DATA_DIR ?? path.join(home, '.sandbox-harness');
  const port = Number(env.SBOX_PORT ?? 7391);
  const harness: HarnessId = env.SBOX_HARNESS === 'opencode' ? 'opencode' : 'claude';
  const defaultBin =
    harness === 'opencode' ? 'opencode' : (env.SBOX_CLAUDE_BIN ?? 'claude');

  return {
    host: env.SBOX_HOST ?? '127.0.0.1',
    port,
    dbPath: env.SBOX_DB ?? path.join(cwd, 'sandbox-harness.sqlite'),
    webDir: env.SBOX_WEB_DIR ?? path.join(cwd, 'src', 'web', 'dist'),
    // The in-app Help surface reads the repo's Markdown and screenshots.
    docsDir: env.SBOX_DOCS_DIR ?? path.join(cwd, 'docs'),
    dataDir,
    pluginsDir: env.SBOX_PLUGINS_DIR ?? path.join(dataDir, 'plugins'),
    brainUrl: env.SBOX_BRAIN_URL ?? `http://127.0.0.1:${port}`,
    harness,
    harnessBin: env.SBOX_HARNESS_BIN ?? defaultBin,
    configPath:
      env.SBOX_CONFIG ??
      path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'sandbox-harness', 'config.json'),
    processPath:
      env.SBOX_PROCESS ??
      path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'sandbox-harness', 'process.json'),
    errorLogPath:
      env.SBOX_ERROR_LOG ??
      path.join(
        env.XDG_STATE_HOME ?? path.join(home, '.local', 'state'),
        'sandbox-harness',
        'errors.log',
      ),
    errorLogMaxBytes: (() => {
      const value = Number(env.SBOX_ERROR_LOG_MAX_BYTES ?? 2 * 1024 * 1024);
      return Number.isFinite(value) && value > 0 ? value : 2 * 1024 * 1024;
    })(),
    // A live but silent CLI must not hold a request open forever. Ten minutes
    // is the default; override with SBOX_TURN_TIMEOUT_MS.
    turnTimeoutMs: (() => {
      const value = Number(env.SBOX_TURN_TIMEOUT_MS ?? 10 * 60 * 1000);
      return Number.isFinite(value) && value > 0 ? value : 10 * 60 * 1000;
    })(),
    // OpenCode's own default is a slow free tier. Prefer the configured fast
    // model when no request or cell overrides it.
    defaultModel:
      env.SBOX_DEFAULT_MODEL === ''
        ? null
        : (env.SBOX_DEFAULT_MODEL ??
          (harness === 'opencode' ? 'opencode-go/deepseek-v4.1-flash' : null)),
    // The browser terminal is a direct shell, separate from agent sessions.
    // Disable with SBOX_TERMINAL=0 when the brain is exposed beyond loopback.
    terminalEnabled: env.SBOX_TERMINAL !== '0',
    terminalCwd: env.SBOX_TERMINAL_CWD ?? cwd,
  };
}

export function requestDir(config: Config, id: string): string {
  return path.join(config.dataDir, 'requests', id);
}
