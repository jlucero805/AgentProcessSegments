import type { CommandInfo, SkillInfo } from './types';

/** Merge plugin commands with discovered skills into one slash-menu list. */
export function mergeSlashCommands(
  commands: CommandInfo[],
  skills: SkillInfo[],
): CommandInfo[] {
  const merged = new Map<string, CommandInfo>();
  for (const command of commands) {
    merged.set(command.command, { ...command, kind: command.kind ?? 'command' });
  }
  for (const skill of skills) {
    const command = `/${skill.name}`;
    merged.set(command, {
      command,
      description: skill.description || `Skill ${skill.name}`,
      plugin: skill.source,
      kind: 'skill',
      invoke: `Use the ${skill.name} skill now and follow its instructions.`,
    });
  }
  return [...merged.values()].sort((a, b) => a.command.localeCompare(b.command));
}

/**
 * Skills are model-invoked, not CLI commands. If the user sends a skill's slash
 * label, translate it to an instruction the harness can act on. Extra text after
 * the label is appended verbatim.
 */
export function resolveSlashText(text: string, commands: CommandInfo[]): string {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return text;
  const command = commands.find(
    (entry) => entry.kind === 'skill' && entry.command === `/${match[1]}`,
  );
  if (!command) return text;
  const invoke = command.invoke ?? `Use the ${match[1]} skill now and follow its instructions.`;
  const extra = match[2]?.trim();
  return extra ? `${invoke}\n\n${extra}` : invoke;
}
