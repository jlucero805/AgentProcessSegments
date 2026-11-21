export interface PluginInfo {
  name: string;
  description: string;
  dir: string;
}

export interface CommandInfo {
  command: string;
  description: string;
  plugin: string;
}

export interface InstallInput {
  url: string;
  subdir?: string | undefined;
  name?: string | undefined;
}
