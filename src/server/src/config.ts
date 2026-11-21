import os from 'node:os';
import path from 'node:path';

export type HarnessId = 'claude' | 'opencode';

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  webDir: string;
  dataDir: string;
  pluginsDir: string;
  brainUrl: string;
  harness: HarnessId;
  harnessBin: string;
  configPath: string;
  processPath: string;
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
  };
}

export function requestDir(config: Config, id: string): string {
  return path.join(config.dataDir, 'requests', id);
}
