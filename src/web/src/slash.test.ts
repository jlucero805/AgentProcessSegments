import { describe, expect, it } from 'vitest';
import { mergeSlashCommands, resolveSlashText } from './slash';
import type { CommandInfo, SkillInfo } from './types';

const command: CommandInfo = {
  command: '/demo:hello',
  description: 'Say hello',
  plugin: 'demo',
};

const skill: SkillInfo = {
  name: 'poteto-mode',
  description: 'Maximum focus',
  source: 'opencode',
  path: '/tmp/poteto-mode/SKILL.md',
};

describe('slash commands and skills', () => {
  it('merges discovered skills as slash entries with an invocation', () => {
    const merged = mergeSlashCommands([command], [skill]);
    expect(merged.map((entry) => entry.command)).toEqual(['/demo:hello', '/poteto-mode']);
    expect(merged.find((entry) => entry.command === '/poteto-mode')).toMatchObject({
      kind: 'skill',
      invoke: 'Use the poteto-mode skill now and follow its instructions.',
      description: 'Maximum focus',
    });
  });

  it('translates a sent skill label into an instruction and keeps extra text', () => {
    const merged = mergeSlashCommands([command], [skill]);
    expect(resolveSlashText('/poteto-mode', merged)).toBe(
      'Use the poteto-mode skill now and follow its instructions.',
    );
    expect(resolveSlashText('/poteto-mode focus on tests', merged)).toBe(
      'Use the poteto-mode skill now and follow its instructions.\n\nfocus on tests',
    );
    expect(resolveSlashText('/demo:hello', merged)).toBe('/demo:hello');
    expect(resolveSlashText('plain text', merged)).toBe('plain text');
  });
});
