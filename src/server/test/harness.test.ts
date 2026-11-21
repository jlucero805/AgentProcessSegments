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
import { HARDCODED_MODELS, ModelCatalog } from '../src/clarify/models.js';

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

  it('keeps the KB session read-only and scoped to an empty request id', async () => {
    const { home, cwd, dir } = workspace();
    writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { user: { command: 'node', args: ['user.js'] } } }),
    );
    const harness = new ClaudeHarness('claude', 'http://brain:7391', home);

    const command = await harness.prepare({
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
    expect(config.mcp.harness.environment.SBOX_REQUEST_ID).toBe('req-2');
    expect(config.mcp.user.url).toBe('https://mcp.example.test/sse');
    expect(config.mcp.disabled.enabled).toBe(false);
    // Request sessions keep the user's permission posture.
    expect(config.permission).toEqual({ bash: 'ask' });
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
