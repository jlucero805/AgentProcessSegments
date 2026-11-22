export interface TerminalSessionInfo {
  id: string;
  pid: number;
  shell: string;
  cwd: string;
  createdAt: number;
  lastActivityAt: number;
  attached: number;
  alive: boolean;
  exitCode: number | null;
}

export type TerminalEvent =
  | { t: 'data'; data: string }
  | { t: 'exit'; code: number | null }
  | { t: 'closed' };
