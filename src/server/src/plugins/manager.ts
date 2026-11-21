import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { markdownDescription, walkFiles } from '../util/files.js';
import type { CommandInfo, InstallInput, PluginInfo } from './types.js';

export type { CommandInfo, InstallInput, PluginInfo } from './types.js';

const exec = promisify(execFile);

export type PluginErrorCode = 'BAD_SOURCE' | 'BAD_SUBDIR' | 'INVALID_PLUGIN' | 'NOT_FOUND' | 'BAD_NAME';

export class PluginError extends Error {
  constructor(
    readonly code: PluginErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginError';
  }
}

export interface PluginManifest {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Accept remote git transports, plus a local directory. A local path is still passed
 * as a single argv element to `git clone`, never through a shell, and a leading dash
 * is refused so it cannot be read as an option.
 */
export function isAllowedSource(source: string): boolean {
  if (source.trim() === '' || source.startsWith('-') || /[\r\n]/.test(source)) return false;
  if (/^(https?|git|ssh):\/\/.+/i.test(source)) return true;
  if (/^git@[^:]+:.+/.test(source)) return true;
  return existsSync(source);
}

export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

function readManifest(file: string): PluginManifest {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new PluginError('INVALID_PLUGIN', `${file} is not a JSON object`);
    }
    return parsed as PluginManifest;
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError('INVALID_PLUGIN', `${file} is missing or not valid JSON`);
  }
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export class PluginManager {
  constructor(private readonly pluginsDir: string) {}

  private manifestPath(dir: string): string {
    return path.join(dir, 'plugin.json');
  }

  /** Install copies only skills, commands, and subagents. Hooks and MCP servers are stripped. */
  async install(input: InstallInput): Promise<PluginInfo> {
    if (!isAllowedSource(input.url)) {
      throw new PluginError('BAD_SOURCE', `refusing plugin source: ${input.url}`);
    }

    mkdirSync(this.pluginsDir, { recursive: true });
    const staging = path.join(this.pluginsDir, `.staging-${Date.now()}-${process.pid}`);

    try {
      await exec('git', ['clone', '--depth', '1', input.url, staging], {
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });

      let source = staging;
      if (input.subdir) {
        const candidate = path.resolve(staging, input.subdir);
        if (!inside(staging, candidate)) {
          throw new PluginError('BAD_SUBDIR', `subdir escapes the clone: ${input.subdir}`);
        }
        source = candidate;
      }

      if (!existsSync(this.manifestPath(source))) {
        throw new PluginError('INVALID_PLUGIN', 'plugin.json not found at the plugin root');
      }

      const manifest = readManifest(this.manifestPath(source));
      const name = input.name ?? manifest.name ?? path.basename(source);
      const slug = toSlug(name);
      if (!SLUG.test(slug)) throw new PluginError('BAD_NAME', `invalid plugin name: ${name}`);

      const target = path.join(this.pluginsDir, slug);
      rmSync(target, { recursive: true, force: true });
      cpSync(source, target, { recursive: true });

      this.stripExtras(target);
      return { name: slug, description: manifest.description ?? '', dir: target };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  private stripExtras(dir: string): void {
    const manifest = readManifest(this.manifestPath(dir));
    delete manifest.hooks;
    delete manifest.mcpServers;
    writeFileSync(this.manifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`);
    rmSync(path.join(dir, 'hooks'), { recursive: true, force: true });
    rmSync(path.join(dir, '.mcp.json'), { force: true });
  }

  list(): PluginInfo[] {
    if (!existsSync(this.pluginsDir)) return [];

    const plugins: PluginInfo[] = [];
    for (const entry of readdirSync(this.pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SLUG.test(entry.name)) continue;
      const dir = path.join(this.pluginsDir, entry.name);
      const manifestFile = this.manifestPath(dir);
      if (!existsSync(manifestFile)) continue;
      try {
        const manifest = readManifest(manifestFile);
        plugins.push({
          name: entry.name,
          description: manifest.description ?? '',
          dir,
        });
      } catch {
        // A corrupt manifest is a broken install, not a reason to fail the list.
      }
    }

    return plugins.sort((a, b) => a.name.localeCompare(b.name));
  }

  remove(name: string): void {
    if (!SLUG.test(name)) throw new PluginError('BAD_NAME', `invalid plugin name: ${name}`);
    const target = path.join(this.pluginsDir, name);
    if (!existsSync(target)) throw new PluginError('NOT_FOUND', `plugin ${name} is not installed`);
    rmSync(target, { recursive: true, force: true });
  }

  /** One `--plugin-dir` per installed plugin on every request session spawn. */
  installedPluginDirs(): string[] {
    return this.list().map((plugin) => plugin.dir);
  }

  listCommands(): CommandInfo[] {
    const commands: CommandInfo[] = [];

    for (const plugin of this.list()) {
      for (const relative of walkFiles(path.join(plugin.dir, 'commands'))) {
        if (!relative.endsWith('.md')) continue;
        const file = path.join(plugin.dir, 'commands', relative);
        const name = relative.replace(/\.md$/i, '').split(path.sep).join(':');
        commands.push({
          command: `/${plugin.name}:${name}`,
          description: markdownDescription(readFileSync(file, 'utf8')),
          plugin: plugin.name,
        });
      }

      const skillsDir = path.join(plugin.dir, 'skills');
      if (!existsSync(skillsDir)) continue;
      for (const skill of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!skill.isDirectory()) continue;
        const file = path.join(skillsDir, skill.name, 'SKILL.md');
        if (!existsSync(file)) continue;
        commands.push({
          command: `/${plugin.name}:${skill.name}`,
          description: markdownDescription(readFileSync(file, 'utf8')),
          plugin: plugin.name,
          kind: 'skill',
          invoke: `Use the ${skill.name} skill now and follow its instructions.`,
        });
      }
    }

    return commands.sort((a, b) => a.command.localeCompare(b.command));
  }
}
