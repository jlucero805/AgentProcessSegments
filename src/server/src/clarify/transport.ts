/** A running agent process that emits one JSON value per stdout line. */
export interface AgentProcess {
  writeUserMessage(text: string): void;
  kill(signal?: NodeJS.Signals): void;
  onLine(handler: (line: string) => void): void;
  onExit(handler: (code: number | null) => void): void;
  /** Recent stderr, used to explain an exit or watchdog timeout. */
  recentStderr(): string;
}
