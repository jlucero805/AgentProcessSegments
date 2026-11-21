import os from 'node:os';
import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  webDir: string;
  dataDir: string;
  pluginsDir: string;
  brainUrl: string;
  claudeBin: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const home = os.homedir();
  const dataDir = env.SBOX_DATA_DIR ?? path.join(home, '.sandbox-harness');
  const port = Number(env.SBOX_PORT ?? 7391);

  return {
    host: env.SBOX_HOST ?? '127.0.0.1',
    port,
    dbPath: env.SBOX_DB ?? path.join(cwd, 'sandbox-harness.sqlite'),
    webDir: env.SBOX_WEB_DIR ?? path.join(cwd, 'src', 'web', 'dist'),
    dataDir,
    pluginsDir: env.SBOX_PLUGINS_DIR ?? path.join(dataDir, 'plugins'),
    brainUrl: env.SBOX_BRAIN_URL ?? `http://127.0.0.1:${port}`,
    claudeBin: env.SBOX_CLAUDE_BIN ?? 'claude',
  };
}

export function requestDir(config: Config, id: string): string {
  return path.join(config.dataDir, 'requests', id);
}
