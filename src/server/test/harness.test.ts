import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS } from '../src/domain/request.js';
import { ClaudeHarness } from '../src/clarify/harnesses/claude.js';
import {
  OpencodeHarness,
  OpencodeProcess,
  probeOpencodeModels,
} from '../src/clarify/harnesses/opencode.js';
import { createHarnessRegistry } from '../src/clarify/harnesses/index.js';
import {
  HARDCODED_MODELS,
  HarnessModelCatalog,
  ModelCatalog,
} from '../src/clarify/models.js';
import { loadConfig } from '../src/config.js';

function workspace() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'sbox-harness-'));
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'repo');
  const dir = path.join(base, 'request');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { base, home, cwd, dir };
}

describe('ClaudeHarness', () => {
  it('merges user, local, and project MCP servers into the generated config', async () => {
    const { home, cwd, dir } = workspace();
    writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { user: { type: 'stdio', command: 'node', args: ['user.js'], env: {} } },
        projects: {
          [cwd]: { mcpServers: { local: { command: 'node', args: ['local.js'] } } },
        },
      }),
    );
    writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { project: { command: 'node', args: ['project.js'] } } }),
    );

    const harness = new ClaudeHarness('claude', 'http://brain:7391', home);
    const command = await harness.prepare({
      scope: 'request',
      requestId: 'req-1',
      dir,
      cwd,
      sessionId: 'sess-9',
      model: 'claude-opus-5-5',
      effort: 'high',
      pluginDirs: ['/plugins/a'],
    });

    const config = JSON.parse(readFileSync(path.join(dir, 'mcp-config.json'), 'utf8'));
    expect(Object.keys(config.mcpServers)).toEqual(
      expect.arrayContaining(['harness', 'user', 'local', 'project']),
    );
    expect(config.mcpServers.harness.env).toEqual({
      SBOX_BRAIN_URL: 'http://brain:7391',
      SBOX_REQUEST_ID: 'req-1',
      SBOX_SESSION_SCOPE: 'request',
    });

    const allowed = command.args[command.args.indexOf('--allowedTools') + 1];
    expect(allowed).toContain('Bash');
    expect(allowed).toContain('mcp__harness__update_request');
    expect(allowed).toContain('mcp__user__*');
    expect(allowed).toContain('mcp__local__*');
    expect(allowed).toContain('mcp__project__*');
    expect(command.args).toEqual(
      expect.arrayContaining([
        '--mcp-config',
        path.join(dir, 'mcp-config.json'),
        '--strict-mcp-config',
        '--resume',
        'sess-9',
        '--model',
        'claude-opus-5-5',
        '--effort',
        'high',
        '--plugin-dir',
        '/plugins/a',
      ]),
    );
    expect(command.cwd).toBe(cwd);
    expect(command.env).toMatchObject({ CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' });
  });

  it('gives the master read-only board tools and no user servers', async () => {
    const { home, cwd, dir } = workspace();
    writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { user: { command: 'node', args: ['user.js'] } } }),
    );
    const harness = new ClaudeHarness('claude', 'http://brain:7391', home);

    const command = await harness.prepare({
      scope: 'master',
      requestId: '',
      dir,
      cwd,
      sessionId: null,
      model: null,
      effort: null,
      pluginDirs: [],
    });

    const allowed = command.args[command.args.indexOf('--allowedTools') + 1];
    expect(allowed).toContain('mcp__harness__list_requests');
    expect(allowed).toContain('mcp__harness__get_request');
    expect(allowed).not.toContain('Bash');
    expect(allowed).not.toContain('mcp__user__*');

    const config = JSON.parse(readFileSync(path.join(dir, 'mcp-config.json'), 'utf8'));
    expect(config.mcpServers.harness.env.SBOX_SESSION_SCOPE).toBe('master');
    expect(config.mcpServers.user).toBeUndefined();
  });

  it('keeps the KB session read-only and scoped to an empty request id', async () => {
    const { home, cwd, dir } = workspace();
    writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { user: { command: 'node', args: ['user.js'] } } }),
    );
    const harness = new ClaudeHarness('claude', 'http://brain:7391', home);

    const command = await harness.prepare({
      scope: 'kb',
      requestId: '',
      dir,
      cwd,
      sessionId: null,
      model: null,
      effort: null,
      pluginDirs: [],
    });

    const allowed = command.args[command.args.indexOf('--allowedTools') + 1];
    expect(allowed).toContain('mcp__harness__search_kb');
    expect(allowed).not.toContain('Bash');
    expect(allowed).not.toContain('Write');
    expect(allowed).not.toContain('mcp__user__*');
    expect(command.args).not.toContain('--plugin-dir');

    const config = JSON.parse(readFileSync(path.join(dir, 'mcp-config.json'), 'utf8'));
    expect(config.mcpServers.harness.env.SBOX_REQUEST_ID).toBe('');
    expect(config.mcpServers.user).toBeUndefined();
  });
});

describe('OpencodeHarness', () => {
  it('merges user MCP servers and points OpenCode at the generated config dir', async () => {
    const { home, cwd, dir } = workspace();
    mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(
      path.join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        mcp: {
          user: { type: 'remote', url: 'https://mcp.example.test/sse' },
          disabled: { type: 'local', command: ['node', 'x.js'], enabled: false },
        },
        permission: { bash: 'ask' },
      }),
    );

    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {});
    const command = await harness.prepare({
      scope: 'request',
      requestId: 'req-2',
      dir,
      cwd,
      sessionId: 'ses_1',
      model: 'opencode-go/deepseek-v4.1-flash',
      effort: 'high',
      pluginDirs: [],
    });

    expect(command.env).toEqual({ OPENCODE_CONFIG_DIR: path.join(dir, 'opencode') });
    expect(command.args).toEqual([
      'run',
      '--format',
      'json',
      '--auto',
      '--standalone',
      '--archived',
      '--model',
      'opencode-go/deepseek-v4.1-flash',
    ]);
    expect(command.sessionId).toBe('ses_1');

    const config = JSON.parse(readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'));
    expect(config.mcp.harness.type).toBe('local');
    expect(config.mcp.harness.codemode).toBe(false);
    expect(config.mcp.harness.environment.SBOX_REQUEST_ID).toBe('req-2');
    expect(config.mcp.user.url).toBe('https://mcp.example.test/sse');
    expect(config.mcp.disabled.enabled).toBe(false);
    // Request sessions keep the user's permission posture, minus interactive questions.
    expect(config.permission).toEqual({ bash: 'ask', question: 'deny' });
  });

  it('denies the interactive question tool for every non-interactive scope', async () => {
    const { home, cwd, dir } = workspace();
    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {});

    for (const scope of ['request', 'setup', 'master', 'kb'] as const) {
      await harness.prepare({
        scope,
        requestId: scope === 'request' ? 'req-1' : '',
        ...(scope === 'setup' ? { draftId: 'draft-1' } : {}),
        dir,
        cwd,
        sessionId: null,
        model: null,
        effort: null,
        pluginDirs: [],
      });
      const config = JSON.parse(
        readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'),
      ) as { permission?: { question?: string } };
      expect(config.permission?.question).toBe('deny');
    }
  });

  it('forces the KB session to read-only permissions and drops user MCP servers', async () => {
    const { home, cwd, dir } = workspace();
    mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(
      path.join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        permission: { bash: 'ask', read: 'deny' },
        mcp: { user: { type: 'remote', url: 'https://mcp.example.test/sse' } },
      }),
    );

    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {});
    await harness.prepare({
      scope: 'kb',
      requestId: '',
      dir,
      cwd,
      sessionId: null,
      model: null,
      effort: null,
      pluginDirs: [],
    });

    const config = JSON.parse(readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'));
    expect(config.permission).toMatchObject({
      read: 'allow',
      edit: 'deny',
      bash: 'deny',
      webfetch: 'deny',
      external_directory: 'deny',
    });
    expect(config.mcp.harness.environment.SBOX_REQUEST_ID).toBe('');
    expect(config.mcp.user).toBeUndefined();
  });

  it('maps installed plugin skills and commands into the OpenCode config', async () => {
    const { base, home, cwd, dir } = workspace();
    const plugin = path.join(base, 'plugins', 'demo');
    mkdirSync(path.join(plugin, 'commands', 'ns'), { recursive: true });
    mkdirSync(path.join(plugin, 'skills', 'greeter'), { recursive: true });
    writeFileSync(
      path.join(plugin, 'commands', 'hello.md'),
      '---\ndescription: Say hello\n---\nReply with exactly PLUGINOK.\n',
    );
    writeFileSync(path.join(plugin, 'commands', 'ns', 'deep.md'), 'Deep template.\n');
    writeFileSync(
      path.join(plugin, 'skills', 'greeter', 'SKILL.md'),
      '---\nname: greeter\ndescription: Greets people.\n---\nBe nice.\n',
    );
    mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(
      path.join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        commands: { 'user-cmd': { template: 'User template', description: 'User' } },
        skills: { paths: ['/user/skill'], urls: ['https://example.test/skills'] },
      }),
    );

    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {});
    await harness.prepare({
      scope: 'request',
      requestId: 'req-3',
      dir,
      cwd,
      sessionId: null,
      model: null,
      effort: null,
      pluginDirs: [plugin],
    });

    const config = JSON.parse(readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'));
    expect(config.commands['demo:hello']).toEqual({
      template: 'Reply with exactly PLUGINOK.',
      description: 'Say hello',
    });
    expect(config.commands['demo:ns:deep']).toEqual({ template: 'Deep template.' });
    expect(config.commands['demo:greeter'].template).toContain('greeter skill');
    expect(config.commands['demo:greeter'].description).toBe('Greets people.');
    expect(config.commands['user-cmd'].template).toBe('User template');
    expect(config.skills.paths).toEqual(
      expect.arrayContaining(['/user/skill', path.join(plugin, 'skills', 'greeter')]),
    );
    expect(config.skills.urls).toEqual(['https://example.test/skills']);
  });

  it('does not add plugin assets to the KB session', async () => {
    const { base, home, cwd, dir } = workspace();
    const plugin = path.join(base, 'plugins', 'demo');
    mkdirSync(path.join(plugin, 'commands'), { recursive: true });
    writeFileSync(path.join(plugin, 'commands', 'hello.md'), 'Reply with PLUGINOK.\n');

    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {});
    await harness.prepare({
      scope: 'kb',
      requestId: '',
      dir,
      cwd,
      sessionId: null,
      model: null,
      effort: null,
      pluginDirs: [plugin],
    });

    const config = JSON.parse(readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'));
    expect(config.commands?.['demo:hello']).toBeUndefined();
    expect(config.skills).toBeUndefined();
  });

  it('pins the child PWD to the session cwd', async () => {
    const { base, cwd } = workspace();
    const script = path.join(base, 'probe.mjs');
    writeFileSync(
      script,
      "console.log(JSON.stringify({ type: 'text', part: { text: JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD }) } }));\n",
    );

    const proc = new OpencodeProcess({
      cmd: process.execPath,
      args: [script],
      env: {},
      cwd,
      sessionId: null,
    });
    const lines: Array<Record<string, unknown>> = [];
    proc.onLine((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
    const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()));
    proc.writeUserMessage('hello');
    await exited;

    const part = lines[0]?.part as { text?: string } | undefined;
    expect(JSON.parse(part?.text ?? '{}')).toEqual({ cwd, pwd: cwd });
  });

  it('makes the master session read-only with no user MCP or plugins', async () => {
    const { home, cwd, dir } = workspace();
    mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(
      path.join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        permission: { bash: 'allow' },
        plugin: ['./plugin.js'],
        agent: { build: { prompt: 'write everything' } },
        commands: { deploy: { template: 'ship it' } },
        skills: ['/tmp/skills'],
        mcp: { user: { type: 'remote', url: 'https://mcp.example.test/sse' } },
      }),
    );

    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {});
    await harness.prepare({
      scope: 'master',
      requestId: '',
      dir,
      cwd,
      sessionId: null,
      model: null,
      effort: null,
      pluginDirs: [],
    });

    const config = JSON.parse(readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'));
    expect(config.permission).toMatchObject({ edit: 'deny', bash: 'deny' });
    expect(config.mcp.harness.environment.SBOX_SESSION_SCOPE).toBe('master');
    expect(config.mcp.user).toBeUndefined();
    expect(config.plugin).toBeUndefined();
    expect(config.agent).toBeUndefined();
    expect(config.commands).toBeUndefined();
    expect(config.skills).toBeUndefined();
  });

  it('probes models from the CLI output', async () => {
    const { base } = workspace();
    const bin = path.join(base, 'fake-opencode');
    writeFileSync(bin, '#!/bin/sh\necho opencode-go/model-a\necho opencode-go/model-b\n');
    chmodSync(bin, 0o755);

    expect(await probeOpencodeModels(bin)).toEqual([
      { id: 'opencode-go/model-a', label: 'opencode-go/model-a' },
      { id: 'opencode-go/model-b', label: 'opencode-go/model-b' },
    ]);
    expect(await probeOpencodeModels(path.join(base, 'missing'))).toBeNull();
  });
});

describe('HarnessRegistry', () => {
  it('caches one adapter per harness and keeps the configured default', () => {
    const { base } = workspace();
    const config = loadConfig(
      { SBOX_CLAUDE_BIN: '/opt/claude', SBOX_OPENCODE_BIN: '/opt/opencode' },
      base,
    );
    const registry = createHarnessRegistry(config);
    expect(registry.defaultId).toBe('claude');
    expect(registry.get('claude')).toBe(registry.get('claude'));
    expect(registry.get('opencode')).toBe(registry.get('opencode'));
    expect(registry.get('claude')).not.toBe(registry.get('opencode'));
    expect(registry.get('claude').id).toBe('claude');
    expect(registry.get('opencode').id).toBe('opencode');
  });
});

describe('HarnessModelCatalog', () => {
  it('keeps probe caches and fallback lists separate per harness', async () => {
    let claudeCalls = 0;
    let openCalls = 0;
    const catalogs = new HarnessModelCatalog({
      claude: {
        probeModels: async () => {
          claudeCalls += 1;
          return [{ id: 'claude-model', label: 'Claude model' }];
        },
        fallbackModels: [{ id: 'claude-fallback', label: 'Claude fallback' }],
      },
      opencode: {
        probeModels: async () => {
          openCalls += 1;
          return null;
        },
        fallbackModels: [{ id: 'open-model', label: 'Open model' }],
      },
    });

    const first = await catalogs.list('claude');
    const second = await catalogs.list('claude');
    expect(first).toMatchObject({ source: 'probe' });
    expect(second).toMatchObject({ source: 'probe' });
    expect(claudeCalls).toBe(1);

    const open = await catalogs.list('opencode');
    expect(open.source).toBe('fallback');
    expect(open.models).toEqual([{ id: 'open-model', label: 'Open model' }]);
    expect(openCalls).toBe(1);
    expect(claudeCalls).toBe(1);
  });
});

describe('ModelCatalog', () => {
  it('uses the harness probe and falls back to its list', async () => {
    const probed = new ModelCatalog({
      probeModels: async () => [{ id: 'provider/model', label: 'provider/model' }],
      fallbackModels: [],
    });
    const probeResult = await probed.list();
    expect(probeResult.source).toBe('probe');
    expect(probeResult.models).toEqual([{ id: 'provider/model', label: 'provider/model' }]);

    const fallback = new ModelCatalog({
      probeModels: async () => null,
      fallbackModels: HARDCODED_MODELS,
    });
    const fallbackResult = await fallback.list();
    expect(fallbackResult.source).toBe('fallback');
    expect(fallbackResult.models).toEqual(HARDCODED_MODELS);
    expect(EFFORT_LEVELS).toContain('high');
  });
});
