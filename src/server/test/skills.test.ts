import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkillCatalog } from '../src/skills/catalog.js';

function writeSkill(file: string, description: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\ndescription: ${description}\n---\n\nInstructions.\n`);
}

describe('SkillCatalog', () => {
  it('discovers global, compatibility, and project skills with project precedence', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'sbox-skills-'));
    const home = path.join(base, 'home');
    const cwd = path.join(base, 'project');
    writeSkill(
      path.join(home, '.config', 'opencode', 'skills', 'poteto-mode', 'SKILL.md'),
      'Global poteto',
    );
    writeSkill(path.join(home, '.claude', 'skills', 'reviewer', 'SKILL.md'), 'Review code');
    writeSkill(
      path.join(cwd, '.opencode', 'skills', 'poteto-mode', 'SKILL.md'),
      'Project poteto override',
    );
    writeSkill(path.join(cwd, '.agents', 'skills', 'flat-skill.md'), 'Flat skill');

    const catalog = new SkillCatalog({
      home,
      cwd,
      env: { XDG_CONFIG_HOME: path.join(home, '.config') },
    });
    const skills = catalog.list();

    expect(skills.map((skill) => skill.name)).toEqual(['flat-skill', 'poteto-mode', 'reviewer']);
    expect(skills.find((skill) => skill.name === 'poteto-mode')).toMatchObject({
      description: 'Project poteto override',
      source: 'project',
    });
    expect(skills.find((skill) => skill.name === 'reviewer')?.source).toBe('claude');
    expect(skills.find((skill) => skill.name === 'flat-skill')?.source).toBe('project');
    expect(catalog.has('poteto-mode')).toBe(true);
  });

  it('returns an empty list when no skill roots exist', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'sbox-skills-empty-'));
    const catalog = new SkillCatalog({ home: base, cwd: base, env: {} });
    expect(catalog.list()).toEqual([]);
  });
});
