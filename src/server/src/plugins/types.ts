export interface PluginInfo {
  name: string;
  description: string;
  dir: string;
}

export type SlashKind = 'command' | 'skill';

export interface CommandInfo {
  command: string;
  description: string;
  plugin: string;
  /** Defaults to `command` for older entries. */
  kind?: SlashKind;
  /** Text the chat sends when a skill is chosen. */
  invoke?: string;
}

export interface InstallInput {
  url: string;
  subdir?: string | undefined;
  name?: string | undefined;
}
