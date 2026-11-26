import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from './tmp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EFFORT_LEVELS } from '../src/domain/request.js';
import type { HarnessSession } from '../src/clarify/harness.js';
import { ClaudeHarness, claudeUserMcpServers } from '../src/clarify/harnesses/claude.js';
import {
  OpencodeHarness,
  OpencodeProcess,
  probeOpencodeModels,
  scrubOpencodeConfigEnv,
} from '../src/clarify/harnesses/opencode.js';
import { createHarnessRegistry } from '../src/clarify/harnesses/index.js';
import {
  HARDCODED_MODELS,
  HarnessModelCatalog,
  ModelCatalog,
} from '../src/clarify/models.js';
import { loadConfig } from '../src/config.js';

function workspace() {
  const base = tmpDir('harness');
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'repo');
  const dir = path.join(base, 'request');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { base, home, cwd, dir };
}

function requestSession(dir: string, cwd: string): HarnessSession {
  return {
    scope: 'request',
    requestId: 'req-1',
    dir,
    cwd,
    sessionId: null,
    model: null,
    effort: null,
    pluginDirs: [],
  };
}

function errorSink() {
  return { error: vi.fn() };
}

function opencodeConfigDir(home: string): string {
  return path.join(home, '.config', 'opencode');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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
      expect.arrayContaining(['aps', 'user', 'local', 'project']),
    );
    expect(config.mcpServers.aps.env).toEqual({
      APS_BRAIN_URL: 'http://brain:7391',
      APS_REQUEST_ID: 'req-1',
      APS_SESSION_SCOPE: 'request',
    });
    expect(Object.keys(config.mcpServers.aps.env).some((key) => key.startsWith('SBOX_'))).toBe(
      false,
    );

    const allowed = command.args[command.args.indexOf('--allowedTools') + 1];
    expect(allowed).toContain('Bash');
    expect(allowed).toContain('mcp__aps__update_request');
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

  it('keeps the bundled aps server when the user also defines one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { home, cwd, dir } = workspace();
    const userFile = path.join(home, '.claude.json');
    writeFileSync(
      userFile,
      JSON.stringify({
        mcpServers: {
          aps: { command: 'user-aps', args: ['user.js'] },
          user: { command: 'node', args: ['user.js'] },
        },
      }),
    );
    const harness = new ClaudeHarness('claude', 'http://brain:7391', home);

    await harness.prepare({
      scope: 'request',
      requestId: 'req-1',
      dir,
      cwd,
      sessionId: null,
      model: null,
      effort: null,
      pluginDirs: [],
    });

    const config = JSON.parse(readFileSync(path.join(dir, 'mcp-config.json'), 'utf8'));
    expect(config.mcpServers.aps.command).toBe(process.execPath);
    expect(config.mcpServers.aps.args[0]).toContain('mcp/server.js');
    expect(config.mcpServers.user.command).toBe('node');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('aps');
    expect(warn.mock.calls[0]?.[0]).toContain(userFile);
    expect(warn.mock.calls[0]?.[0]).toContain('user MCP server');
  });

  it('names the config file that supplied the overridden aps server', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { home, cwd, dir } = workspace();
    writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { aps: { command: 'user-aps' } } }),
    );
    const projectFile = path.join(cwd, '.mcp.json');
    writeFileSync(
      projectFile,
      JSON.stringify({ mcpServers: { aps: { command: 'project-aps' } } }),
    );
    const harness = new ClaudeHarness('claude', 'http://brain:7391', home);

    await harness.prepare({
      scope: 'request',
      requestId: 'req-1',
      dir,
      cwd,
      sessionId: null,
      model: null,
      effort: null,
      pluginDirs: [],
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(projectFile);
    expect(warn.mock.calls[0]?.[0]).toContain('project MCP server');
    expect(warn.mock.calls[0]?.[0]).not.toContain('user MCP server');
  });

  it('prefers local scope over project scope for a same-named server', () => {
    const { home, cwd } = workspace();
    const userFile = path.join(home, '.claude.json');
    writeFileSync(
      userFile,
      JSON.stringify({
        mcpServers: {
          shared: { command: 'user-shared' },
          'user-only': { command: 'user-only' },
        },
        projects: {
          [cwd]: { mcpServers: { shared: { command: 'local-shared' } } },
        },
      }),
    );
    writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'project-shared' } } }),
    );

    const loaded = claudeUserMcpServers(home, cwd);

    expect(loaded.servers['shared']).toEqual({ command: 'local-shared' });
    expect(loaded.sources.get('shared')).toEqual({ file: userFile, scope: 'local' });
    expect(loaded.servers['user-only']).toEqual({ command: 'user-only' });
    expect(loaded.sources.get('user-only')).toEqual({ file: userFile, scope: 'user' });
  });

  it('prefers project scope over user scope for a same-named server', () => {
    const { home, cwd } = workspace();
    const userFile = path.join(home, '.claude.json');
    writeFileSync(
      userFile,
      JSON.stringify({ mcpServers: { shared: { command: 'user-shared' } } }),
    );
    const projectFile = path.join(cwd, '.mcp.json');
    writeFileSync(
      projectFile,
      JSON.stringify({ mcpServers: { shared: { command: 'project-shared' } } }),
    );

    const loaded = claudeUserMcpServers(home, cwd);

    expect(loaded.servers['shared']).toEqual({ command: 'project-shared' });
    expect(loaded.sources.get('shared')).toEqual({ file: projectFile, scope: 'project' });
  });

  it('names the winning local file when a local aps entry beats the project one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { home, cwd, dir } = workspace();
    const userFile = path.join(home, '.claude.json');
    writeFileSync(
      userFile,
      JSON.stringify({
        projects: { [cwd]: { mcpServers: { aps: { command: 'local-aps' } } } },
      }),
    );
    const projectFile = path.join(cwd, '.mcp.json');
    writeFileSync(
      projectFile,
      JSON.stringify({ mcpServers: { aps: { command: 'project-aps' } } }),
    );
    const harness = new ClaudeHarness('claude', 'http://brain:7391', home);

    await harness.prepare(requestSession(dir, cwd));

    const config = JSON.parse(readFileSync(path.join(dir, 'mcp-config.json'), 'utf8'));
    expect(config.mcpServers.aps.command).toBe(process.execPath);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('aps');
    expect(warn.mock.calls[0]?.[0]).toContain(userFile);
    expect(warn.mock.calls[0]?.[0]).toContain('local MCP server');
    expect(warn.mock.calls[0]?.[0]).not.toContain('user MCP server');
    expect(warn.mock.calls[0]?.[0]).not.toContain(projectFile);
  });

  it('warns only once per config file across turns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { home, cwd, dir } = workspace();
    writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { aps: { command: 'user-aps' } } }),
    );
    const harness = new ClaudeHarness('claude', 'http://brain:7391', home);
    const session = {
      scope: 'request' as const,
      requestId: 'req-1',
      dir,
      cwd,
      sessionId: null,
      model: null,
      effort: null,
      pluginDirs: [],
    };

    await harness.prepare(session);
    await harness.prepare(session);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn when the user defines other MCP servers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { home, cwd, dir } = workspace();
    writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { user: { command: 'node', args: ['user.js'] } } }),
    );
    const harness = new ClaudeHarness('claude', 'http://brain:7391', home);

    await harness.prepare({
      scope: 'request',
      requestId: 'req-1',
      dir,
      cwd,
      sessionId: null,
      model: null,
      effort: null,
      pluginDirs: [],
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn for read-only or setup scopes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { home, cwd, dir } = workspace();
    writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { aps: { command: 'user-aps' } } }),
    );
    const harness = new ClaudeHarness('claude', 'http://brain:7391', home);

    for (const scope of ['kb', 'master', 'setup'] as const) {
      await harness.prepare({
        scope,
        requestId: '',
        ...(scope === 'setup' ? { draftId: 'draft-1' } : {}),
        dir,
        cwd,
        sessionId: null,
        model: null,
        effort: null,
        pluginDirs: [],
      });
    }

    expect(warn).not.toHaveBeenCalled();
  });

  it('reports an invalid user config and keeps the other MCP sources', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = errorSink();
    const { home, cwd, dir } = workspace();
    const userFile = path.join(home, '.claude.json');
    writeFileSync(userFile, '{"mcpServers":');
    writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { project: { command: 'node', args: ['project.js'] } } }),
    );

    const harness = new ClaudeHarness('claude', 'http://brain:7391', home, errors);
    await harness.prepare(requestSession(dir, cwd));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(userFile);
    expect(warn.mock.calls[0]?.[0]).toContain('claude');
    expect(warn.mock.calls[0]?.[0]).toContain('invalid JSON');
    expect(errors.error).toHaveBeenCalledTimes(1);
    expect(errors.error).toHaveBeenCalledWith('harness.mcpConfig', expect.any(Error), {
      harness: 'claude',
      path: userFile,
      reason: 'invalid JSON',
    });
    expect(String(errors.error.mock.calls[0]?.[1])).toBe('Error: invalid JSON');

    const config = JSON.parse(readFileSync(path.join(dir, 'mcp-config.json'), 'utf8'));
    expect(config.mcpServers.aps).toBeDefined();
    expect(config.mcpServers.project).toBeDefined();
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'reports a user config that cannot be read',
    async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errors = errorSink();
      const { home, cwd, dir } = workspace();
      const userFile = path.join(home, '.claude.json');
      writeFileSync(
        userFile,
        JSON.stringify({ mcpServers: { user: { command: 'node', args: ['user.js'] } } }),
      );
      chmodSync(userFile, 0o000);

      const harness = new ClaudeHarness('claude', 'http://brain:7391', home, errors);
      await harness.prepare(requestSession(dir, cwd));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(userFile);
      expect(warn.mock.calls[0]?.[0]).toContain('unreadable: EACCES');
      expect(errors.error).toHaveBeenCalledWith('harness.mcpConfig', expect.any(Error), {
        harness: 'claude',
        path: userFile,
        reason: 'unreadable: EACCES',
      });
    },
  );

  it('reports a user config path that is not a regular file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = errorSink();
    const { home, cwd, dir } = workspace();
    const userFile = path.join(home, '.claude.json');
    mkdirSync(userFile);

    const harness = new ClaudeHarness('claude', 'http://brain:7391', home, errors);
    await harness.prepare(requestSession(dir, cwd));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('unreadable: EISDIR');
    expect(errors.error).toHaveBeenCalledWith('harness.mcpConfig', expect.any(Error), {
      harness: 'claude',
      path: userFile,
      reason: 'unreadable: EISDIR',
    });
  });

  it('reports a config file that is not a JSON object', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = errorSink();
    const { home, cwd, dir } = workspace();
    const userFile = path.join(home, '.claude.json');
    writeFileSync(userFile, JSON.stringify(['not', 'an', 'object']));

    const harness = new ClaudeHarness('claude', 'http://brain:7391', home, errors);
    await harness.prepare(requestSession(dir, cwd));

    expect(warn.mock.calls[0]?.[0]).toContain('not a JSON object');
    expect(errors.error).toHaveBeenCalledWith('harness.mcpConfig', expect.any(Error), {
      harness: 'claude',
      path: userFile,
      reason: 'not a JSON object',
    });
  });

  it('reports a wrong-typed MCP container without dropping other sources', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = errorSink();
    const { home, cwd, dir } = workspace();
    const userFile = path.join(home, '.claude.json');
    writeFileSync(userFile, JSON.stringify({ mcpServers: 'not a map' }));
    writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { project: { command: 'node', args: ['project.js'] } } }),
    );

    const harness = new ClaudeHarness('claude', 'http://brain:7391', home, errors);
    await harness.prepare(requestSession(dir, cwd));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('mcpServers is not an object');
    expect(errors.error).toHaveBeenCalledWith('harness.mcpConfig', expect.any(Error), {
      harness: 'claude',
      path: userFile,
      reason: 'mcpServers is not an object',
    });
    const config = JSON.parse(readFileSync(path.join(dir, 'mcp-config.json'), 'utf8'));
    expect(config.mcpServers.project).toBeDefined();
  });

  it('stays quiet when the user config files are missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = errorSink();
    const { home, cwd, dir } = workspace();

    const harness = new ClaudeHarness('claude', 'http://brain:7391', home, errors);
    await harness.prepare(requestSession(dir, cwd));

    expect(warn).not.toHaveBeenCalled();
    expect(errors.error).not.toHaveBeenCalled();
  });

  it('reports a broken user config once across turns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = errorSink();
    const { home, cwd, dir } = workspace();
    writeFileSync(path.join(home, '.claude.json'), '{broken');

    const harness = new ClaudeHarness('claude', 'http://brain:7391', home, errors);
    const session = requestSession(dir, cwd);
    await harness.prepare(session);
    await harness.prepare(session);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(errors.error).toHaveBeenCalledTimes(1);
  });

  it('does not report a broken user config outside the request scope', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = errorSink();
    const { home, cwd, dir } = workspace();
    writeFileSync(path.join(home, '.claude.json'), '{broken');

    const harness = new ClaudeHarness('claude', 'http://brain:7391', home, errors);
    for (const scope of ['kb', 'master', 'setup'] as const) {
      await harness.prepare({
        scope,
        requestId: '',
        ...(scope === 'setup' ? { draftId: 'draft-1' } : {}),
        dir,
        cwd,
        sessionId: null,
        model: null,
        effort: null,
        pluginDirs: [],
      });
    }

    expect(warn).not.toHaveBeenCalled();
    expect(errors.error).not.toHaveBeenCalled();
  });

  it('sets the request auto-compaction threshold and leaves other scopes alone', async () => {
    const { home, cwd, dir } = workspace();
    const harness = new ClaudeHarness('claude', 'http://brain:7391', home);

    const requestCommand = await harness.prepare({
      scope: 'request',
      requestId: 'req-1',
      dir,
      cwd,
      sessionId: null,
      model: null,
      effort: null,
      autocompactPercent: 60,
      pluginDirs: [],
    });
    expect(requestCommand.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('60');
    expect(requestCommand.args).toEqual(
      expect.arrayContaining([
        '--settings',
        JSON.stringify({ autoCompactEnabled: true }),
      ]),
    );

    const masterCommand = await harness.prepare({
      scope: 'master',
      requestId: '',
      dir,
      cwd,
      sessionId: null,
      model: null,
      effort: null,
      autocompactPercent: 60,
      pluginDirs: [],
    });
    expect(masterCommand.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBeUndefined();
    expect(masterCommand.args).not.toContain('--settings');
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
    expect(allowed).toContain('mcp__aps__list_requests');
    expect(allowed).toContain('mcp__aps__get_request');
    expect(allowed).not.toContain('Bash');
    expect(allowed).not.toContain('mcp__user__*');

    const config = JSON.parse(readFileSync(path.join(dir, 'mcp-config.json'), 'utf8'));
    expect(config.mcpServers.aps.env.APS_SESSION_SCOPE).toBe('master');
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
    expect(allowed).toContain('mcp__aps__search_kb');
    expect(allowed).not.toContain('Bash');
    expect(allowed).not.toContain('Write');
    expect(allowed).not.toContain('mcp__user__*');
    expect(command.args).not.toContain('--plugin-dir');

    const config = JSON.parse(readFileSync(path.join(dir, 'mcp-config.json'), 'utf8'));
    expect(config.mcpServers.aps.env.APS_REQUEST_ID).toBe('');
    expect(config.mcpServers.user).toBeUndefined();
  });

  it('fails the turn instead of crashing when the child exits before the first write', async () => {
    const { cwd } = workspace();
    const proc = new ClaudeHarness(process.execPath).spawn({
      cmd: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: {},
      cwd,
      sessionId: null,
    });
    const lines: string[] = [];
    proc.onLine((line) => lines.push(line));
    const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()));
    await exited;
    // Let the child's stdin teardown settle so the write takes the guard path.
    await new Promise((resolve) => setImmediate(resolve));

    expect(() => proc.writeUserMessage('hello')).not.toThrow();
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(event).toMatchObject({ type: 'result', subtype: 'error', is_error: true });
    expect(String(event['result'])).toContain('claude stdin is closed');
  });

  it('captures an asynchronous EPIPE when the child closes stdin but stays alive', async () => {
    const { cwd } = workspace();
    const proc = new ClaudeHarness(process.execPath).spawn({
      cmd: process.execPath,
      args: ['-e', "require('node:fs').closeSync(0); setInterval(() => {}, 1000);"],
      env: {},
      cwd,
      sessionId: null,
    });
    const lines: string[] = [];
    const failed = new Promise<void>((resolve, reject) => {
      // Fail fast instead of hanging if the child never reports the stdin failure.
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for the stdin failure')),
        2_000,
      );
      proc.onLine((line) => {
        lines.push(line);
        clearTimeout(timer);
        resolve();
      });
    });
    const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()));

    try {
      proc.writeUserMessage('x'.repeat(1024 * 1024));
      await failed;
      expect(lines).toHaveLength(1);
      const event = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
      expect(event['is_error']).toBe(true);
      expect(String(event['result'])).toContain('write EPIPE');
    } finally {
      proc.kill('SIGKILL');
      await exited;
    }
    expect(lines).toHaveLength(1);
  });

  it('writes the user message payload to a live child unchanged', async () => {
    const { cwd } = workspace();
    const proc = new ClaudeHarness(process.execPath).spawn({
      cmd: process.execPath,
      args: [
        '-e',
        "process.stdin.on('data', (chunk) => process.stdout.write(chunk)); setInterval(() => {}, 1000);",
      ],
      env: {},
      cwd,
      sessionId: null,
    });
    const lines: string[] = [];
    const echoed = new Promise<string>((resolve, reject) => {
      // Fail fast instead of hanging if the child never echoes the message.
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for the echoed message')),
        2_000,
      );
      proc.onLine((line) => {
        lines.push(line);
        clearTimeout(timer);
        resolve(line);
      });
    });
    const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()));

    try {
      proc.writeUserMessage('hello');
      const line = await echoed;
      expect(JSON.parse(line)).toEqual({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      });
      expect(lines).toHaveLength(1);
    } finally {
      proc.kill('SIGKILL');
      await exited;
    }
  });

  it('reports a closed stdin only once across repeated writes', async () => {
    const { cwd } = workspace();
    const proc = new ClaudeHarness(process.execPath).spawn({
      cmd: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: {},
      cwd,
      sessionId: null,
    });
    const lines: string[] = [];
    proc.onLine((line) => lines.push(line));
    const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()));
    await exited;
    await new Promise((resolve) => setImmediate(resolve));

    proc.writeUserMessage('one');
    proc.writeUserMessage('two');
    expect(lines).toHaveLength(1);
  });
});

describe('OpencodeHarness', () => {
  it('strips config env overrides without mutating the input', () => {
    const input = {
      PATH: '/bin',
      PWD: '/work',
      OPENCODE_CONFIG_DIR: '/cfg',
      OPENCODE_CONFIG: '/tmp/custom.json',
      OPENCODE_CONFIG_CONTENT: '{"model":"x"}',
    };

    expect(scrubOpencodeConfigEnv(input)).toEqual({
      PATH: '/bin',
      PWD: '/work',
      OPENCODE_CONFIG_DIR: '/cfg',
    });
    expect(input.OPENCODE_CONFIG).toBe('/tmp/custom.json');
    expect(input.OPENCODE_CONFIG_CONTENT).toBe('{"model":"x"}');
  });

  it('warns once for config env overrides without naming their values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { home, cwd, dir } = workspace();

    const blank = new OpencodeHarness('opencode', 'http://brain:7391', home, {
      OPENCODE_CONFIG: '',
      OPENCODE_CONFIG_CONTENT: '',
    });
    await blank.prepare(requestSession(dir, cwd));
    expect(warn).not.toHaveBeenCalled();

    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {
      OPENCODE_CONFIG: '/tmp/host-config.json',
      OPENCODE_CONFIG_CONTENT: '{"model":"secret/model"}',
    });
    await harness.prepare({ ...requestSession(dir, cwd), scope: 'kb' });
    expect(warn).toHaveBeenCalledTimes(2);
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes('OPENCODE_CONFIG'))).toBe(true);
    expect(messages.some((message) => message.includes('OPENCODE_CONFIG_CONTENT'))).toBe(true);
    for (const message of messages) {
      expect(message).not.toContain('/tmp/host-config.json');
      expect(message).not.toContain('secret/model');
    }

    warn.mockClear();
    await harness.prepare(requestSession(dir, cwd));
    expect(warn).not.toHaveBeenCalled();
  });

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
    expect(config.mcp.aps.type).toBe('local');
    expect(config.mcp.aps.codemode).toBe(false);
    expect(config.mcp.aps.environment.APS_REQUEST_ID).toBe('req-2');
    expect(config.mcp.user.url).toBe('https://mcp.example.test/sse');
    expect(config.mcp.disabled.enabled).toBe(false);
    // Request sessions keep the user's permission posture, minus interactive questions.
    expect(config.permission).toEqual({ bash: 'ask', question: 'deny' });
  });

  it('keeps the bundled aps server when the user also defines one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { home, cwd, dir } = workspace();
    mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    const configFile = path.join(home, '.config', 'opencode', 'opencode.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        mcp: {
          aps: { type: 'remote', url: 'https://user.example.test/sse' },
          user: { type: 'remote', url: 'https://mcp.example.test/sse' },
        },
      }),
    );

    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {});
    await harness.prepare({
      scope: 'request',
      requestId: 'req-2',
      dir,
      cwd,
      sessionId: null,
      model: null,
      effort: null,
      pluginDirs: [],
    });

    const config = JSON.parse(readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'));
    expect(config.mcp.aps.type).toBe('local');
    expect(config.mcp.aps.command[0]).toBe(process.execPath);
    expect(config.mcp.user.url).toBe('https://mcp.example.test/sse');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('aps');
    expect(warn.mock.calls[0]?.[0]).toContain(configFile);
  });

  it('warns for an aps server in the encoded mcp.servers shape', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { home, cwd, dir } = workspace();
    mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    const configFile = path.join(home, '.config', 'opencode', 'opencode.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        mcp: { servers: { aps: { type: 'remote', url: 'https://user.example.test/sse' } } },
      }),
    );

    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {});
    await harness.prepare({
      scope: 'request',
      requestId: 'req-2',
      dir,
      cwd,
      sessionId: null,
      model: null,
      effort: null,
      pluginDirs: [],
    });

    const config = JSON.parse(readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'));
    expect(config.mcp.aps.type).toBe('local');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(configFile);
  });

  it('does not warn for read-only scopes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { home, cwd, dir } = workspace();
    mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(
      path.join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({ mcp: { aps: { type: 'remote', url: 'https://user.example.test/sse' } } }),
    );
    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {});

    for (const scope of ['kb', 'master'] as const) {
      await harness.prepare({
        scope,
        requestId: '',
        dir,
        cwd,
        sessionId: null,
        model: null,
        effort: null,
        pluginDirs: [],
      });
    }

    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a commented opencode.jsonc config', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = errorSink();
    const { home, cwd, dir } = workspace();
    const configDir = opencodeConfigDir(home);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, 'opencode.jsonc'),
      `{
        // Local tools the user wants in every request.
        "model": "user/model",
        "permission": { "bash": "ask" },
        "mcp": {
          "user": {
            "type": "remote",
            "url": "https://mcp.example.test/a//b",
          },
          "local": {
            "type": "local",
            "command": ["node", "tool.js",], /* trailing comma */
          },
        },
      }`,
    );

    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {}, errors);
    await harness.prepare(requestSession(dir, cwd));

    expect(warn).not.toHaveBeenCalled();
    expect(errors.error).not.toHaveBeenCalled();

    const config = JSON.parse(readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'));
    expect(config.model).toBe('user/model');
    expect(config.permission).toEqual({ bash: 'ask', question: 'deny' });
    expect(config.mcp.user.url).toBe('https://mcp.example.test/a//b');
    expect(config.mcp.local.command).toEqual(['node', 'tool.js']);
    expect(config.mcp.aps.type).toBe('local');
  });

  it('reads a commented opencode.json config', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = errorSink();
    const { home, cwd, dir } = workspace();
    const configDir = opencodeConfigDir(home);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, 'opencode.json'),
      `{
        // Comments are accepted in .json too.
        "mcp": { "user": { "type": "local", "command": ["node", "user.js"] } },
      }`,
    );

    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {}, errors);
    await harness.prepare(requestSession(dir, cwd));

    expect(warn).not.toHaveBeenCalled();
    expect(errors.error).not.toHaveBeenCalled();

    const config = JSON.parse(readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'));
    expect(config.mcp.user.command).toEqual(['node', 'user.js']);
    expect(config.mcp.aps.type).toBe('local');
  });

  it('reports malformed JSONC and still writes the bundled server', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = errorSink();
    const { home, cwd, dir } = workspace();
    const configDir = opencodeConfigDir(home);
    mkdirSync(configDir, { recursive: true });
    const jsoncFile = path.join(configDir, 'opencode.jsonc');
    writeFileSync(jsoncFile, '{ "mcp": { /* never closed');

    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {}, errors);
    await harness.prepare(requestSession(dir, cwd));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(jsoncFile);
    expect(warn.mock.calls[0]?.[0]).toContain('invalid JSON');
    expect(errors.error).toHaveBeenCalledWith('harness.mcpConfig', expect.any(Error), {
      harness: 'opencode',
      path: jsoncFile,
      reason: 'invalid JSON',
    });
    expect(String(errors.error.mock.calls[0]?.[1])).toBe('Error: invalid JSON');

    const config = JSON.parse(readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'));
    expect(config.mcp.aps.type).toBe('local');
  });

  it('reports a broken config and still uses the next candidate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = errorSink();
    const { home, cwd, dir } = workspace();
    const configDir = opencodeConfigDir(home);
    mkdirSync(configDir, { recursive: true });
    const jsonFile = path.join(configDir, 'opencode.json');
    writeFileSync(jsonFile, '{broken');
    writeFileSync(
      path.join(configDir, 'opencode.jsonc'),
      JSON.stringify({ mcp: { user: { type: 'local', command: ['node', 'user.js'] } } }),
    );

    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {}, errors);
    await harness.prepare(requestSession(dir, cwd));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(jsonFile);
    expect(warn.mock.calls[0]?.[0]).toContain('opencode');
    expect(warn.mock.calls[0]?.[0]).toContain('invalid JSON');
    expect(errors.error).toHaveBeenCalledWith('harness.mcpConfig', expect.any(Error), {
      harness: 'opencode',
      path: jsonFile,
      reason: 'invalid JSON',
    });

    const config = JSON.parse(readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'));
    expect(config.mcp.user).toBeDefined();
    expect(config.mcp.aps).toBeDefined();
  });

  it('reports every broken candidate and still writes the bundled server', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = errorSink();
    const { home, cwd, dir } = workspace();
    const configDir = opencodeConfigDir(home);
    mkdirSync(configDir, { recursive: true });
    const jsonFile = path.join(configDir, 'opencode.json');
    const jsoncFile = path.join(configDir, 'opencode.jsonc');
    writeFileSync(jsonFile, '{broken');
    writeFileSync(jsoncFile, '{also broken');

    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {}, errors);
    await harness.prepare(requestSession(dir, cwd));

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((call) => call[0]).join('\n')).toContain(jsonFile);
    expect(warn.mock.calls.map((call) => call[0]).join('\n')).toContain(jsoncFile);
    expect(errors.error).toHaveBeenCalledTimes(2);

    const config = JSON.parse(readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'));
    expect(config.mcp.aps.type).toBe('local');
  });

  it('reports a wrong-typed mcp container and keeps the other user settings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = errorSink();
    const { home, cwd, dir } = workspace();
    const configDir = opencodeConfigDir(home);
    mkdirSync(configDir, { recursive: true });
    const configFile = path.join(configDir, 'opencode.json');
    writeFileSync(configFile, JSON.stringify({ mcp: 'not a map', permission: { bash: 'ask' } }));

    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {}, errors);
    await harness.prepare(requestSession(dir, cwd));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('mcp is not an object');
    expect(errors.error).toHaveBeenCalledWith('harness.mcpConfig', expect.any(Error), {
      harness: 'opencode',
      path: configFile,
      reason: 'mcp is not an object',
    });

    const config = JSON.parse(readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'));
    expect(config.mcp.aps).toBeDefined();
    expect(config.permission.bash).toBe('ask');
  });

  it('stays quiet when there is no user OpenCode config', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = errorSink();
    const { home, cwd, dir } = workspace();

    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {}, errors);
    await harness.prepare(requestSession(dir, cwd));

    expect(warn).not.toHaveBeenCalled();
    expect(errors.error).not.toHaveBeenCalled();
  });

  it('does not report a broken config outside the request scope', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = errorSink();
    const { home, cwd, dir } = workspace();
    const configDir = opencodeConfigDir(home);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, 'opencode.json'), '{broken');

    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {}, errors);
    for (const scope of ['kb', 'master', 'setup'] as const) {
      await harness.prepare({
        scope,
        requestId: '',
        ...(scope === 'setup' ? { draftId: 'draft-1' } : {}),
        dir,
        cwd,
        sessionId: null,
        model: null,
        effort: null,
        pluginDirs: [],
      });
    }

    expect(warn).not.toHaveBeenCalled();
    expect(errors.error).not.toHaveBeenCalled();
  });

  it('writes request compaction from the cell percentage', async () => {
    const { home, cwd, dir } = workspace();
    mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(
      path.join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        compaction: { keep: { tokens: 12_000 }, prune: true, reserved: 9_000 },
      }),
    );

    const harness = new OpencodeHarness('opencode', 'http://brain:7391', home, {});
    await harness.prepare({
      scope: 'request',
      requestId: 'req-compact',
      dir,
      cwd,
      sessionId: null,
      model: null,
      effort: null,
      autocompactPercent: 60,
      pluginDirs: [],
    });

    const config = JSON.parse(readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'));
    expect(config.compaction).toEqual({
      keep: { tokens: 12_000 },
      prune: true,
      auto: true,
      buffer: '40%',
    });

    await harness.prepare({
      scope: 'request',
      requestId: 'req-default',
      dir,
      cwd,
      sessionId: null,
      model: null,
      effort: null,
      autocompactPercent: 80,
      pluginDirs: [],
    });
    const defaultConfig = JSON.parse(
      readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'),
    );
    expect(defaultConfig.compaction.buffer).toBe('20%');

    await harness.prepare({
      scope: 'master',
      requestId: '',
      dir,
      cwd,
      sessionId: null,
      model: null,
      effort: null,
      autocompactPercent: 60,
      pluginDirs: [],
    });
    const master = JSON.parse(readFileSync(path.join(dir, 'opencode', 'opencode.json'), 'utf8'));
    expect(master.compaction).toEqual({
      keep: { tokens: 12_000 },
      prune: true,
      reserved: 9_000,
    });
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
    expect(config.mcp.aps.environment.APS_REQUEST_ID).toBe('');
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

  it('strips config env overrides from the spawned child environment', async () => {
    const { base, cwd } = workspace();
    const script = path.join(base, 'probe-env.mjs');
    writeFileSync(
      script,
      "console.log(JSON.stringify({ type: 'text', part: { text: JSON.stringify({ " +
        "config: process.env.OPENCODE_CONFIG ?? null, content: process.env.OPENCODE_CONFIG_CONTENT ?? null, " +
        "pwd: process.env.PWD ?? null, keep: process.env.APS_KEEP_ME ?? null }) } }));\n",
    );

    vi.stubEnv('OPENCODE_CONFIG', '/tmp/host-config.json');
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', '{"mcp":{"servers":{"aps":{"type":"remote"}}}}');
    vi.stubEnv('APS_KEEP_ME', 'keep');

    const proc = new OpencodeProcess({
      cmd: process.execPath,
      args: [script],
      env: { OPENCODE_CONFIG: '/tmp/command-config.json' },
      cwd,
      sessionId: null,
    });
    const lines: Array<Record<string, unknown>> = [];
    proc.onLine((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
    const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()));
    proc.writeUserMessage('hello');
    await exited;

    const part = lines[0]?.part as { text?: string } | undefined;
    expect(JSON.parse(part?.text ?? '{}')).toEqual({
      config: null,
      content: null,
      pwd: cwd,
      keep: 'keep',
    });
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
    expect(config.mcp.aps.environment.APS_SESSION_SCOPE).toBe('master');
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

  it('probes models without config env overrides', async () => {
    const { base } = workspace();
    const bin = path.join(base, 'fake-opencode-env');
    writeFileSync(
      bin,
      '#!/bin/sh\n' +
        'if [ -n "$OPENCODE_CONFIG" ] || [ -n "$OPENCODE_CONFIG_CONTENT" ]; then exit 1; fi\n' +
        'echo opencode-go/model-a\n',
    );
    chmodSync(bin, 0o755);

    expect(
      await probeOpencodeModels(bin, {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        OPENCODE_CONFIG: '/tmp/host-config.json',
        OPENCODE_CONFIG_CONTENT: '{"model":"x"}',
      }),
    ).toEqual([{ id: 'opencode-go/model-a', label: 'opencode-go/model-a' }]);
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
