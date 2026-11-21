import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isRecord } from '../../util/json.js';
import { frontmatterField, splitMarkdown, walkFiles } from '../../util/files.js';

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

    for (const relative of walkFiles(path.join(dir, 'commands'))) {
      if (!relative.toLowerCase().endsWith('.md')) continue;
      const file = path.join(dir, 'commands', relative);
      const markdown = readFileSync(file, 'utf8');
      const { frontmatter, body } = splitMarkdown(markdown);
      const template = body.trim();
      if (template === '') continue;
      const name = relative.replace(/\.md$/i, '').split(path.sep).join(':');
      const description = frontmatterField(frontmatter, 'description');
      commands[`${plugin}:${name}`] = {
        template,
        ...(description ? { description } : {}),
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
      const named = frontmatterField(frontmatter, 'name') || entry.name;
      const description = frontmatterField(frontmatter, 'description');
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
