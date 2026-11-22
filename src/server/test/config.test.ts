import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const CWD = '/tmp/sbox-config-test';

describe('harness config', () => {
  it('defaults to Claude and keeps the OpenCode fast model for later cells', () => {
    const config = loadConfig({}, CWD);
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
    const config = loadConfig({ SBOX_HARNESS: 'opencode' }, CWD);
    expect(config.harness).toBe('opencode');
    expect(config.harnessBin).toBe('opencode');
    expect(config.defaultModel).toBe('opencode-go/deepseek-v4.1-flash');
  });

  it('rejects an unknown harness instead of silently choosing Claude', () => {
    expect(() => loadConfig({ SBOX_HARNESS: 'claud' }, CWD)).toThrowError(
      /unknown SBOX_HARNESS "claud"/,
    );
  });

  it('targets each adapter binary and keeps the legacy default-only override', () => {
    const config = loadConfig(
      {
        SBOX_CLAUDE_BIN: '/opt/claude',
        SBOX_OPENCODE_BIN: '/opt/opencode',
        SBOX_HARNESS_BIN: '/opt/default',
      },
      CWD,
    );
    expect(config.harnessBins).toEqual({
      claude: '/opt/claude',
      opencode: '/opt/opencode',
    });
    expect(config.harnessBin).toBe('/opt/claude');

    const legacy = loadConfig({ SBOX_HARNESS_BIN: '/opt/default' }, CWD);
    expect(legacy.harnessBins).toEqual({
      claude: '/opt/default',
      opencode: 'opencode',
    });
    expect(legacy.harnessBin).toBe('/opt/default');

    const open = loadConfig(
      {
        SBOX_HARNESS: 'opencode',
        SBOX_CLAUDE_BIN: '/opt/claude',
        SBOX_HARNESS_BIN: '/opt/default',
      },
      CWD,
    );
    expect(open.harnessBins).toEqual({
      claude: '/opt/claude',
      opencode: '/opt/default',
    });
  });

  it('applies SBOX_DEFAULT_MODEL only to the process-default harness', () => {
    const claude = loadConfig({ SBOX_DEFAULT_MODEL: 'claude-opus-5-5' }, CWD);
    expect(claude.defaultModels).toEqual({
      claude: 'claude-opus-5-5',
      opencode: 'opencode-go/deepseek-v4.1-flash',
    });

    const open = loadConfig(
      { SBOX_HARNESS: 'opencode', SBOX_DEFAULT_MODEL: 'opencode-go/custom' },
      CWD,
    );
    expect(open.defaultModels).toEqual({
      claude: null,
      opencode: 'opencode-go/custom',
    });

    const disabled = loadConfig({ SBOX_DEFAULT_MODEL: '' }, CWD);
    expect(disabled.defaultModels.claude).toBeNull();
    expect(disabled.defaultModels.opencode).toBe('opencode-go/deepseek-v4.1-flash');
  });
});
