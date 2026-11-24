import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  blankPathEnvNames,
  blankPathWarning,
  legacyPathWarning,
  loadConfig,
  requestDir,
} from '../src/config.js';

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

const BLANK_PATH_ENV = {
  APS_DATA_DIR: '',
  APS_CONFIG: '',
  APS_PROCESS: '',
  APS_ERROR_LOG: '',
  APS_DB: '',
  APS_WEB_DIR: '',
  APS_DOCS_DIR: '',
  APS_PLUGINS_DIR: '',
  APS_TERMINAL_CWD: '',
  APS_HARNESS_BIN: '',
  APS_CLAUDE_BIN: '',
  APS_OPENCODE_BIN: '',
};

describe('harness config', () => {
  it('defaults to Claude and keeps the OpenCode fast model for later cells', () => {
    const { base, home } = workspace();
    const config = loadConfig({}, base, home);

    expect(config.harness).toBe('claude');
    expect(config.harnessBin).toBe('claude');
    expect(config.harnessBins).toEqual({ claude: 'claude', opencode: 'opencode' });
    expect(config.defaultModels).toEqual({
      claude: null,
      opencode: 'opencode-go/deepseek-v4.1-flash',
    });
    expect(config.defaultModel).toBeNull();
  });

  it('accepts OpenCode as the process default', () => {
    const { base, home } = workspace();
    const config = loadConfig({ APS_HARNESS: 'opencode' }, base, home);

    expect(config.harness).toBe('opencode');
    expect(config.harnessBin).toBe('opencode');
    expect(config.defaultModel).toBe('opencode-go/deepseek-v4.1-flash');
  });

  it('rejects an unknown harness instead of silently choosing Claude', () => {
    const { base, home } = workspace();

    expect(() => loadConfig({ APS_HARNESS: 'claud' }, base, home)).toThrowError(
      /unknown APS_HARNESS "claud"/,
    );
  });

  it('targets each adapter binary and keeps the legacy default-only override', () => {
    const { base, home } = workspace();
    const config = loadConfig(
      {
        APS_CLAUDE_BIN: '/opt/claude',
        APS_OPENCODE_BIN: '/opt/opencode',
        APS_HARNESS_BIN: '/opt/default',
      },
      base,
      home,
    );
    expect(config.harnessBins).toEqual({
      claude: '/opt/claude',
      opencode: '/opt/opencode',
    });
    expect(config.harnessBin).toBe('/opt/claude');

    const legacy = loadConfig({ SBOX_HARNESS_BIN: '/opt/default' }, base, home);
    expect(legacy.harnessBins).toEqual({
      claude: '/opt/default',
      opencode: 'opencode',
    });
    expect(legacy.harnessBin).toBe('/opt/default');

    const open = loadConfig(
      {
        APS_HARNESS: 'opencode',
        APS_CLAUDE_BIN: '/opt/claude',
        APS_HARNESS_BIN: '/opt/default',
      },
      base,
      home,
    );
    expect(open.harnessBins).toEqual({
      claude: '/opt/claude',
      opencode: '/opt/default',
    });
  });

  it('applies APS_DEFAULT_MODEL only to the process-default harness', () => {
    const { base, home } = workspace();
    const claude = loadConfig({ APS_DEFAULT_MODEL: 'claude-opus-5-5' }, base, home);
    expect(claude.defaultModels).toEqual({
      claude: 'claude-opus-5-5',
      opencode: 'opencode-go/deepseek-v4.1-flash',
    });

    const open = loadConfig(
      { APS_HARNESS: 'opencode', APS_DEFAULT_MODEL: 'opencode-go/custom' },
      base,
      home,
    );
    expect(open.defaultModels).toEqual({
      claude: null,
      opencode: 'opencode-go/custom',
    });

    const disabled = loadConfig({ APS_DEFAULT_MODEL: '' }, base, home);
    expect(disabled.defaultModels.claude).toBeNull();
    expect(disabled.defaultModels.opencode).toBe('opencode-go/deepseek-v4.1-flash');
  });
});

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

describe('blank path env overrides', () => {
  const blankPathEnv = (value = '') =>
    Object.fromEntries(Object.keys(BLANK_PATH_ENV).map((key) => [key, value]));

  it('ignores every blank path override and falls back to the defaults', () => {
    const { base, home } = workspace();
    const expected = loadConfig({}, base, home);

    const config = loadConfig(BLANK_PATH_ENV, base, home);

    expect(config.dataDir).toBe(expected.dataDir);
    expect(config.pluginsDir).toBe(expected.pluginsDir);
    expect(config.dbPath).toBe(expected.dbPath);
    expect(config.webDir).toBe(expected.webDir);
    expect(config.docsDir).toBe(expected.docsDir);
    expect(config.configPath).toBe(expected.configPath);
    expect(config.processPath).toBe(expected.processPath);
    expect(config.errorLogPath).toBe(expected.errorLogPath);
    expect(config.terminalCwd).toBe(expected.terminalCwd);
    expect(config.harnessBins).toEqual(expected.harnessBins);
    expect(config.legacyPaths).toEqual([]);
    expect(config.dataDir).not.toBe('');
    expect(config.pluginsDir).toBe(path.join(config.dataDir, 'plugins'));
    expect(requestDir(config, 'r1')).toBe(
      path.join(config.dataDir, 'requests', 'r1'),
    );
    expect(blankPathEnvNames(BLANK_PATH_ENV)).toEqual([
      'APS_CLAUDE_BIN',
      'APS_CONFIG',
      'APS_DATA_DIR',
      'APS_DB',
      'APS_DOCS_DIR',
      'APS_ERROR_LOG',
      'APS_HARNESS_BIN',
      'APS_OPENCODE_BIN',
      'APS_PLUGINS_DIR',
      'APS_PROCESS',
      'APS_TERMINAL_CWD',
      'APS_WEB_DIR',
    ]);
  });

  it('ignores whitespace-only path overrides', () => {
    const { base, home } = workspace();
    const expected = loadConfig({}, base, home);

    const config = loadConfig(blankPathEnv('   '), base, home);

    expect(config.dataDir).toBe(expected.dataDir);
    expect(config.pluginsDir).toBe(expected.pluginsDir);
    expect(config.dbPath).toBe(expected.dbPath);
    expect(config.webDir).toBe(expected.webDir);
    expect(config.docsDir).toBe(expected.docsDir);
    expect(config.configPath).toBe(expected.configPath);
    expect(config.processPath).toBe(expected.processPath);
    expect(config.errorLogPath).toBe(expected.errorLogPath);
    expect(config.terminalCwd).toBe(expected.terminalCwd);
  });

  it('does not let a blank APS_* value block an existing legacy data dir', () => {
    const { base, home } = workspace();
    const legacyData = path.join(home, '.sandbox-harness');
    mkdirSync(legacyData, { recursive: true });

    const config = loadConfig({ APS_DATA_DIR: '' }, base, home);

    expect(config.dataDir).toBe(legacyData);
    expect(config.pluginsDir).toBe(path.join(legacyData, 'plugins'));
    expect(config.legacyPaths).toEqual([legacyData]);
  });

  it('falls through a blank APS_* value to a non-blank SBOX_* alias', () => {
    const { base, home } = workspace();

    const config = loadConfig(
      {
        APS_DATA_DIR: '',
        SBOX_DATA_DIR: '/legacy/data',
        APS_CONFIG: '',
        SBOX_CONFIG: '/legacy/config.json',
        APS_PROCESS: '',
        SBOX_PROCESS: '/legacy/process.json',
        APS_ERROR_LOG: '',
        SBOX_ERROR_LOG: '/legacy/errors.log',
        APS_DB: '',
        SBOX_DB: '/legacy/db.sqlite',
        APS_WEB_DIR: '',
        SBOX_WEB_DIR: '/legacy/web',
        APS_DOCS_DIR: '',
        SBOX_DOCS_DIR: '/legacy/docs',
        APS_PLUGINS_DIR: '',
        SBOX_PLUGINS_DIR: '/legacy/plugins',
        APS_TERMINAL_CWD: '',
        SBOX_TERMINAL_CWD: '/legacy/terminal',
        APS_CLAUDE_BIN: '',
        SBOX_CLAUDE_BIN: '/legacy/claude',
        APS_OPENCODE_BIN: '',
        SBOX_OPENCODE_BIN: '/legacy/opencode',
      },
      base,
      home,
    );

    expect(config.dataDir).toBe('/legacy/data');
    expect(config.configPath).toBe('/legacy/config.json');
    expect(config.processPath).toBe('/legacy/process.json');
    expect(config.errorLogPath).toBe('/legacy/errors.log');
    expect(config.dbPath).toBe('/legacy/db.sqlite');
    expect(config.webDir).toBe('/legacy/web');
    expect(config.docsDir).toBe('/legacy/docs');
    expect(config.pluginsDir).toBe('/legacy/plugins');
    expect(config.terminalCwd).toBe('/legacy/terminal');
    expect(config.harnessBins).toEqual({
      claude: '/legacy/claude',
      opencode: '/legacy/opencode',
    });
  });

  it('falls through a blank APS_HARNESS_BIN to the legacy alias', () => {
    const { base, home } = workspace();

    const config = loadConfig(
      { APS_HARNESS_BIN: '', SBOX_HARNESS_BIN: '/legacy/default' },
      base,
      home,
    );

    expect(config.harnessBin).toBe('/legacy/default');
    expect(config.harnessBins).toEqual({
      claude: '/legacy/default',
      opencode: 'opencode',
    });
  });

  it('keeps non-blank values verbatim', () => {
    const { base, home } = workspace();

    const config = loadConfig(
      {
        APS_DATA_DIR: 'data',
        APS_WEB_DIR: '/srv/My Web',
        APS_DOCS_DIR: 'docs',
        APS_DB: ':memory:',
      },
      base,
      home,
    );

    expect(config.dataDir).toBe('data');
    expect(config.pluginsDir).toBe(path.join('data', 'plugins'));
    expect(config.webDir).toBe('/srv/My Web');
    expect(config.docsDir).toBe('docs');
    expect(config.dbPath).toBe(':memory:');
    expect(
      blankPathEnvNames({
        APS_DATA_DIR: 'data',
        APS_WEB_DIR: '/srv/My Web',
        APS_DOCS_DIR: 'docs',
        APS_DB: ':memory:',
      }),
    ).toEqual([]);
  });

  it('reports only blank path names across both prefixes', () => {
    expect(
      blankPathEnvNames({
        APS_DATA_DIR: '',
        SBOX_DB: '   ',
        APS_WEB_DIR: '/web',
        APS_PORT: '',
        APS_DEFAULT_MODEL: '',
        APS_HARNESS: '',
        aps_data_dir: '',
        APS_CONFIG: undefined,
        PATH: '/usr/bin',
      }),
    ).toEqual(['APS_DATA_DIR', 'SBOX_DB']);
  });

  it('returns one warning line with names only', () => {
    expect(blankPathWarning([])).toBeNull();

    const warning = blankPathWarning(['APS_DATA_DIR', 'SBOX_DB']);

    expect(warning).toContain('APS_DATA_DIR, SBOX_DB');
    expect(warning).toContain('APS_*');
    expect(warning?.includes('\n')).toBe(false);
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
        SBOX_OPENCODE_BIN: '/legacy/opencode-specific',
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
    expect(config.harnessBin).toBe('/legacy/opencode-specific');
    expect(config.harnessBins).toEqual({
      claude: '/legacy/claude',
      opencode: '/legacy/opencode-specific',
    });
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
