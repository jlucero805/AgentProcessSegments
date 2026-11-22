import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { legacyPathWarning, loadConfig, requestDir } from '../src/config.js';

function workspace() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'aps-config-'));
  const home = path.join(base, 'home');
  mkdirSync(home, { recursive: true });
  return { base, home };
}

function writeFile(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{}');
}

describe('loadConfig paths', () => {
  it('uses canonical defaults when neither name exists', () => {
    const { base, home } = workspace();

    const config = loadConfig({}, base, home);

    expect(config.dataDir).toBe(path.join(home, '.agent-process-segments'));
    expect(config.pluginsDir).toBe(path.join(home, '.agent-process-segments', 'plugins'));
    expect(config.configPath).toBe(
      path.join(home, '.config', 'agent-process-segments', 'config.json'),
    );
    expect(config.processPath).toBe(
      path.join(home, '.config', 'agent-process-segments', 'process.json'),
    );
    expect(config.errorLogPath).toBe(
      path.join(home, '.local', 'state', 'agent-process-segments', 'errors.log'),
    );
    expect(config.dbPath).toBe(path.join(base, 'agent-process-segments.sqlite'));
    expect(config.legacyPaths).toEqual([]);
  });

  it('prefers an existing legacy default and records it', () => {
    const { base, home } = workspace();
    const legacyData = path.join(home, '.sandbox-harness');
    const legacyConfig = path.join(home, '.config', 'sandbox-harness', 'config.json');
    const legacyProcess = path.join(home, '.config', 'sandbox-harness', 'process.json');
    const legacyError = path.join(home, '.local', 'state', 'sandbox-harness', 'errors.log');
    const legacyDb = path.join(base, 'sandbox-harness.sqlite');
    mkdirSync(legacyData, { recursive: true });
    writeFile(legacyConfig);
    writeFile(legacyProcess);
    writeFile(legacyError);
    writeFile(legacyDb);

    const config = loadConfig({}, base, home);

    expect(config.dataDir).toBe(legacyData);
    expect(config.pluginsDir).toBe(path.join(legacyData, 'plugins'));
    expect(config.configPath).toBe(legacyConfig);
    expect(config.processPath).toBe(legacyProcess);
    expect(config.errorLogPath).toBe(legacyError);
    expect(config.dbPath).toBe(legacyDb);
    expect(config.legacyPaths).toEqual([
      legacyData,
      legacyConfig,
      legacyProcess,
      legacyError,
      legacyDb,
    ]);
  });

  it('prefers the canonical default when both names exist', () => {
    const { base, home } = workspace();
    mkdirSync(path.join(home, '.sandbox-harness'), { recursive: true });
    mkdirSync(path.join(home, '.agent-process-segments'), { recursive: true });
    writeFile(path.join(home, '.config', 'sandbox-harness', 'config.json'));
    writeFile(path.join(home, '.config', 'agent-process-segments', 'config.json'));
    writeFile(path.join(home, '.config', 'sandbox-harness', 'process.json'));
    writeFile(path.join(home, '.config', 'agent-process-segments', 'process.json'));
    writeFile(path.join(home, '.local', 'state', 'sandbox-harness', 'errors.log'));
    writeFile(path.join(home, '.local', 'state', 'agent-process-segments', 'errors.log'));
    writeFile(path.join(base, 'sandbox-harness.sqlite'));
    writeFile(path.join(base, 'agent-process-segments.sqlite'));

    const config = loadConfig({}, base, home);

    expect(config.dataDir).toBe(path.join(home, '.agent-process-segments'));
    expect(config.configPath).toBe(
      path.join(home, '.config', 'agent-process-segments', 'config.json'),
    );
    expect(config.processPath).toBe(
      path.join(home, '.config', 'agent-process-segments', 'process.json'),
    );
    expect(config.errorLogPath).toBe(
      path.join(home, '.local', 'state', 'agent-process-segments', 'errors.log'),
    );
    expect(config.dbPath).toBe(path.join(base, 'agent-process-segments.sqlite'));
    expect(config.legacyPaths).toEqual([]);
  });

  it('lets an explicit env path win over either default', () => {
    const { base, home } = workspace();
    writeFile(path.join(home, '.config', 'sandbox-harness', 'config.json'));

    const config = loadConfig(
      {
        APS_DATA_DIR: '/explicit/data',
        APS_DB: ':memory:',
        APS_CONFIG: '/explicit/config.json',
      },
      base,
      home,
    );

    expect(config.dataDir).toBe('/explicit/data');
    expect(config.pluginsDir).toBe('/explicit/data/plugins');
    expect(config.dbPath).toBe(':memory:');
    expect(config.configPath).toBe('/explicit/config.json');
    expect(config.legacyPaths).toEqual([]);
  });
});

describe('loadConfig environment precedence', () => {
  it('still reads every legacy SBOX_* variable', () => {
    const { base, home } = workspace();

    const config = loadConfig(
      {
        SBOX_HOST: '0.0.0.0',
        SBOX_PORT: '1234',
        SBOX_DB: '/legacy/db.sqlite',
        SBOX_WEB_DIR: '/legacy/web',
        SBOX_DOCS_DIR: '/legacy/docs',
        SBOX_DATA_DIR: '/legacy/data',
        SBOX_PLUGINS_DIR: '/legacy/plugins',
        SBOX_BRAIN_URL: 'http://legacy:7391',
        SBOX_HARNESS: 'opencode',
        SBOX_HARNESS_BIN: '/legacy/opencode',
        SBOX_CLAUDE_BIN: '/legacy/claude',
        SBOX_CONFIG: '/legacy/config.json',
        SBOX_PROCESS: '/legacy/process.json',
        SBOX_ERROR_LOG: '/legacy/errors.log',
        SBOX_ERROR_LOG_MAX_BYTES: '4096',
        SBOX_TURN_TIMEOUT_MS: '5000',
        SBOX_DEFAULT_MODEL: '',
        SBOX_TERMINAL: '0',
        SBOX_TERMINAL_CWD: '/legacy/terminal',
      },
      base,
      home,
    );

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(1234);
    expect(config.dbPath).toBe('/legacy/db.sqlite');
    expect(config.webDir).toBe('/legacy/web');
    expect(config.docsDir).toBe('/legacy/docs');
    expect(config.dataDir).toBe('/legacy/data');
    expect(config.pluginsDir).toBe('/legacy/plugins');
    expect(config.brainUrl).toBe('http://legacy:7391');
    expect(config.harness).toBe('opencode');
    expect(config.harnessBin).toBe('/legacy/opencode');
    expect(config.configPath).toBe('/legacy/config.json');
    expect(config.processPath).toBe('/legacy/process.json');
    expect(config.errorLogPath).toBe('/legacy/errors.log');
    expect(config.errorLogMaxBytes).toBe(4096);
    expect(config.turnTimeoutMs).toBe(5000);
    expect(config.defaultModel).toBeNull();
    expect(config.terminalEnabled).toBe(false);
    expect(config.terminalCwd).toBe('/legacy/terminal');
  });

  it('prefers APS_* when both prefixes are present, including an empty model', () => {
    const { base, home } = workspace();

    const config = loadConfig(
      {
        APS_PORT: '2000',
        SBOX_PORT: '1000',
        APS_HARNESS: 'claude',
        SBOX_HARNESS: 'opencode',
        APS_DEFAULT_MODEL: '',
        SBOX_DEFAULT_MODEL: 'legacy-model',
        APS_TERMINAL: '1',
        SBOX_TERMINAL: '0',
      },
      base,
      home,
    );

    expect(config.port).toBe(2000);
    expect(config.harness).toBe('claude');
    expect(config.harnessBin).toBe('claude');
    expect(config.defaultModel).toBeNull();
    expect(config.terminalEnabled).toBe(true);
  });

  it('builds request directories under the selected data dir', () => {
    const { base, home } = workspace();
    const config = loadConfig({ APS_DATA_DIR: '/data' }, base, home);

    expect(requestDir(config, 'req-1')).toBe(path.join('/data', 'requests', 'req-1'));
  });

  it('returns one migration warning for legacy paths', () => {
    expect(legacyPathWarning([])).toBeNull();
    expect(legacyPathWarning(['/old/data', '/old/config.json'])).toContain(
      '/old/data, /old/config.json',
    );
    expect(legacyPathWarning(['/old/data'])).toContain('npm run migrate:paths');
  });
});
