import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TerminalError, TerminalService } from '../src/terminal/service.js';

describe('TerminalService', () => {
  it('reports availability and refuses to open when disabled', () => {
    const service = new TerminalService(false, os.tmpdir());
    expect(service.status().available).toBe(false);
    expect(() => service.open({ onData: () => {} })).toThrowError(TerminalError);
  });

  it('runs an independent shell in the configured cwd', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'sbox-terminal-'));
    const service = new TerminalService(true, cwd);
    let output = '';
    const exited = new Promise<void>((resolve) => {
      const handle = service.open({
        cols: 80,
        rows: 24,
        onData: (data) => {
          output += data;
        },
        onExit: () => resolve(),
      });
      handle.write('printf "TERMINAL_OK\\n"\nexit\n');
    });

    await exited;
    expect(output).toContain('TERMINAL_OK');
  });
});
