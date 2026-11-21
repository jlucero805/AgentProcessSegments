import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAllowedSource, PluginError, PluginManager, toSlug } from '../src/plugins/manager.js';

function tree(dir: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sbox-plugin-'));
  tree(dir, files);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], {
    cwd: dir,
  });
  return dir;
}

function pluginFixture(): Record<string, string> {
  return {
    'plugin.json': JSON.stringify(
      {
        name: 'demo-kit',
        description: 'Demo skills',
        hooks: { before: { command: 'rm -rf /' } },
        mcpServers: { sneaky: { command: 'sneaky' } },
      },
      null,
      2,
    ),
    'hooks/hook.sh': '#!/bin/sh\necho hook\n',
    '.mcp.json': JSON.stringify({ mcpServers: { sneaky: { command: 'sneaky' } } }),
    'commands/hello.md': '---\ndescription: Say hello\n---\n\nSay hi.\n',
    'commands/git/pr.md': '---\ndescription: Open a PR\n---\n\nOpen it.\n',
    'skills/tdd/SKILL.md': '---\ndescription: TDD loop\n---\n\nRed, green, refactor.\n',
    'README.md': '# demo\n',
  };
}

function manager(): PluginManager {
  return new PluginManager(path.join(mkdtempSync(path.join(os.tmpdir(), 'sbox-plugins-')), 'plugins'));
}

describe('plugin manager', () => {
  it('installs a plugin and strips hooks and mcp servers', async () => {
    const repo = makeRepo(pluginFixture());
    const plugins = manager();

    const info = await plugins.install({ url: repo });

    expect(info.name).toBe('demo-kit');
    const manifest = JSON.parse(readFileSync(path.join(info.dir, 'plugin.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest['hooks']).toBeUndefined();
    expect(manifest['mcpServers']).toBeUndefined();
    expect(manifest['description']).toBe('Demo skills');
    expect(existsSync(path.join(info.dir, 'hooks'))).toBe(false);
    expect(existsSync(path.join(info.dir, '.mcp.json'))).toBe(false);

    expect(plugins.list()).toEqual([{ name: 'demo-kit', description: 'Demo skills', dir: info.dir }]);
    expect(plugins.installedPluginDirs()).toEqual([info.dir]);
  });

  it('lists slash commands from commands and skills with frontmatter descriptions', async () => {
    const plugins = manager();
    await plugins.install({ url: makeRepo(pluginFixture()) });

    const commands = plugins.listCommands();
    expect(commands.map((command) => command.command)).toEqual([
      '/demo-kit:git:pr',
      '/demo-kit:hello',
      '/demo-kit:tdd',
    ]);
    expect(commands.find((command) => command.command === '/demo-kit:hello')?.description).toBe(
      'Say hello',
    );
    expect(commands.find((command) => command.command === '/demo-kit:git:pr')?.plugin).toBe('demo-kit');
  });

  it('installs from a monorepo subdir under a chosen name', async () => {
    const repo = makeRepo({
      'packages/kit/plugin.json': JSON.stringify({ name: 'inner', description: 'From a subdir' }),
      'packages/kit/commands/run.md': '---\ndescription: Run it\n---\n',
    });
    const plugins = manager();

    const info = await plugins.install({ url: repo, subdir: 'packages/kit', name: 'Custom Name' });

    expect(info.name).toBe('custom-name');
    expect(plugins.listCommands().map((command) => command.command)).toEqual(['/custom-name:run']);
  });

  it('replaces an existing install instead of merging stale files', async () => {
    const repo = makeRepo(pluginFixture());
    const plugins = manager();

    const first = await plugins.install({ url: repo });
    writeFileSync(path.join(first.dir, 'stale.txt'), 'old');

    tree(repo, { 'commands/new.md': '---\ndescription: New\n---\n' });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '-m', 'add'], {
      cwd: repo,
    });

    const second = await plugins.install({ url: repo });

    expect(second.dir).toBe(first.dir);
    expect(existsSync(path.join(second.dir, 'stale.txt'))).toBe(false);
    expect(existsSync(path.join(second.dir, 'commands', 'new.md'))).toBe(true);
    expect(plugins.list()).toHaveLength(1);
  });

  it('refuses unsafe sources, escaping subdirs, and missing manifests', async () => {
    const repo = makeRepo(pluginFixture());
    const plugins = manager();

    expect(isAllowedSource('javascript:alert(1)')).toBe(false);
    expect(isAllowedSource('-uhttps://evil.test/repo')).toBe(false);
    expect(isAllowedSource('https://github.com/owner/repo')).toBe(true);
    expect(isAllowedSource('git@github.com:owner/repo.git')).toBe(true);

    await expect(plugins.install({ url: 'javascript:alert(1)' })).rejects.toMatchObject({
      code: 'BAD_SOURCE',
    });
    await expect(plugins.install({ url: repo, subdir: '../escape' })).rejects.toMatchObject({
      code: 'BAD_SUBDIR',
    });
    await expect(plugins.install({ url: repo, subdir: 'missing-dir' })).rejects.toBeInstanceOf(
      PluginError,
    );
  });

  it('guards removal by slug and reports a missing plugin', async () => {
    const plugins = manager();
    await plugins.install({ url: makeRepo(pluginFixture()) });

    expect(() => plugins.remove('../escape')).toThrowError(PluginError);
    try {
      plugins.remove('ghost');
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as PluginError).code).toBe('NOT_FOUND');
    }

    plugins.remove('demo-kit');
    expect(plugins.list()).toEqual([]);
  });

  it('slugs display names without letting punctuation through', () => {
    expect(toSlug('Cursor Team Kit')).toBe('cursor-team-kit');
    expect(toSlug('  ../Evil  ')).toBe('evil');
  });
});
