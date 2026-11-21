import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markdownDescription, walkFiles } from '../util/files.js';
import type { SkillInfo } from './types.js';

export interface SkillCatalogOptions {
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface SkillRoot {
  dir: string;
  source: string;
}

function ancestors(cwd: string): string[] {
  const found: string[] = [];
  let current = path.resolve(cwd);
  for (;;) {
    found.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return found.reverse();
}

function idFor(relative: string): string | null {
  const parts = relative.split(path.sep);
  if (parts[parts.length - 1] === 'SKILL.md') {
    return parts.length >= 2 ? (parts[parts.length - 2] ?? null) : null;
  }
  if (parts.length === 1 && relative.toLowerCase().endsWith('.md')) {
    return relative.slice(0, -3);
  }
  return null;
}

/**
 * Discover skills the agent CLIs can already see: the standard global directories
 * plus `.opencode`, `.claude`, and `.agents` in the brain project and its ancestors.
 * Project roots are processed later, so they win over global duplicates.
 */
export class SkillCatalog {
  private readonly home: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: SkillCatalogOptions = {}) {
    this.home = options.home ?? os.homedir();
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
  }

  private roots(): SkillRoot[] {
    const xdgConfig = this.env.XDG_CONFIG_HOME ?? path.join(this.home, '.config');
    const opencodeConfig =
      this.env.OPENCODE_CONFIG_DIR ?? path.join(xdgConfig, 'opencode');
    const roots: SkillRoot[] = [
      { dir: path.join(opencodeConfig, 'skills'), source: 'opencode' },
      { dir: path.join(this.home, '.claude', 'skills'), source: 'claude' },
      { dir: path.join(this.home, '.agents', 'skills'), source: 'agents' },
    ];

    const seen = new Set<string>();
    for (const ancestor of ancestors(this.cwd)) {
      for (const [dirName, source] of [
        ['.opencode', 'project'],
        ['.claude', 'project'],
        ['.agents', 'project'],
      ] as const) {
        const dir = path.join(ancestor, dirName, 'skills');
        if (seen.has(dir)) continue;
        seen.add(dir);
        roots.push({ dir, source });
      }
    }
    return roots;
  }

  list(): SkillInfo[] {
    const skills = new Map<string, SkillInfo>();
    for (const root of this.roots()) {
      for (const relative of walkFiles(root.dir)) {
        const name = idFor(relative);
        if (!name) continue;
        const file = path.join(root.dir, relative);
        let description = '';
        try {
          description = markdownDescription(readFileSync(file, 'utf8'));
        } catch {
          // An unreadable skill is not a catalog failure.
        }
        skills.set(name, {
          name,
          description: description || `Skill ${name}`,
          source: root.source,
          path: file,
        });
      }
    }
    return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Cheap existence check used by callers that only need the count. */
  has(name: string): boolean {
    return this.list().some((skill) => skill.name === name);
  }
}
