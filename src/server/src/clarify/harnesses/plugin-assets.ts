import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isRecord } from '../harness.js';

export interface PluginCommand {
  template: string;
  description?: string;
}

export interface PluginAssets {
  /** Absolute skill folders, each containing SKILL.md. */
  skills: string[];
  /** OpenCode command name -> template. */
  commands: Record<string, PluginCommand>;
}

function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, base));
    else if (entry.isFile()) found.push(path.relative(base, full));
  }
  return found;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function splitMarkdown(markdown: string): { frontmatter: string; body: string } {
  const match = FRONTMATTER.exec(markdown);
  if (!match) return { frontmatter: '', body: markdown };
  return { frontmatter: match[1] ?? '', body: markdown.slice(match[0].length) };
}

function field(frontmatter: string, key: string): string {
  const line = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(frontmatter);
  return line?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
}

function unquote(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Reads installed plugins (Claude-style `commands/**` and `skills/*\/SKILL.md`)
 * into OpenCode's command map and skill path list. Names keep the plugin prefix so
 * the SPA slash menu and OpenCode expose the same names.
 */
export function readPluginAssets(pluginDirs: readonly string[]): PluginAssets {
  const skills = new Set<string>();
  const commands: Record<string, PluginCommand> = {};

  for (const dir of pluginDirs) {
    const plugin = path.basename(dir);

    for (const relative of walk(path.join(dir, 'commands'))) {
      if (!relative.toLowerCase().endsWith('.md')) continue;
      const file = path.join(dir, 'commands', relative);
      const markdown = readFileSync(file, 'utf8');
      const { frontmatter, body } = splitMarkdown(markdown);
      const template = body.trim();
      if (template === '') continue;
      const name = relative.replace(/\.md$/i, '').split(path.sep).join(':');
      commands[`${plugin}:${name}`] = {
        template,
        ...(field(frontmatter, 'description')
          ? { description: field(frontmatter, 'description') }
          : {}),
      };
    }

    const skillsDir = path.join(dir, 'skills');
    if (!existsSync(skillsDir)) continue;
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(skillsDir, entry.name);
      const skillFile = path.join(skillDir, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const { frontmatter } = splitMarkdown(readFileSync(skillFile, 'utf8'));
      const named = unquote(field(frontmatter, 'name')) ?? entry.name;
      const description = field(frontmatter, 'description');
      skills.add(skillDir);
      commands[`${plugin}:${entry.name}`] = {
        template: `Use the ${named} skill now and follow its instructions.`,
        description: description || `Skill ${entry.name}`,
      };
    }
  }

  return { skills: [...skills], commands };
}

/** Merges plugin skill paths into the user's array or `{paths, urls}` form. */
export function mergeSkillPaths(
  existing: unknown,
  extra: readonly string[],
): string[] | { paths: string[]; urls: string[] } {
  const paths: string[] = [];
  let urls: string[] = [];

  if (Array.isArray(existing)) {
    for (const entry of existing) if (typeof entry === 'string') paths.push(entry);
  } else if (isRecord(existing)) {
    if (Array.isArray(existing.paths)) {
      for (const entry of existing.paths) if (typeof entry === 'string') paths.push(entry);
    }
    if (Array.isArray(existing.urls)) {
      urls = existing.urls.filter((entry): entry is string => typeof entry === 'string');
    }
  }

  const merged = [...new Set([...paths, ...extra])];
  return urls.length > 0 ? { paths: merged, urls } : merged;
}
