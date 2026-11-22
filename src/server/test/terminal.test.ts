import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TerminalError, TerminalService } from '../src/terminal/service.js';
import type { TerminalEvent } from '../src/terminal/types.js';

describe('TerminalService', () => {
  it('reports availability, lists sessions, and refuses to create when disabled', () => {
    const service = new TerminalService(false, os.tmpdir());
    expect(service.status().available).toBe(false);
    expect(service.list()).toEqual([]);
    expect(() => service.create()).toThrowError(TerminalError);
  });

  it('keeps a shell alive across detach/attach and replays scrollback', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'sbox-terminal-'));
    const service = new TerminalService(true, cwd);
    const created = service.create({ cols: 80, rows: 24 });
    expect(service.list()).toHaveLength(1);
    expect(created.cwd).toBe(cwd);

    const firstEvents: TerminalEvent[] = [];
    const first = service.attach(created.id, (event) => firstEvents.push(event));
    expect(first).not.toBeNull();
    service.write(created.id, 'printf "TERMINAL_OK\\n"\n');
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(firstEvents.some((event) => event.t === 'data' && event.data.includes('TERMINAL_OK'))).toBe(
      true,
    );
    first?.detach();

    const secondEvents: TerminalEvent[] = [];
    const second = service.attach(created.id, (event) => secondEvents.push(event));
    expect(second?.buffer).toContain('TERMINAL_OK');
    expect(second?.session.alive).toBe(true);
    second?.detach();

    service.write(created.id, 'exit\n');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(service.list()[0]?.alive).toBe(false);
    expect(service.close(created.id)).toBe(true);
    expect(service.list()).toEqual([]);
  });

  it('caps the number of visible sessions', () => {
    const service = new TerminalService(true, os.tmpdir());
    for (let index = 0; index < 4; index += 1) service.create();
    expect(() => service.create()).toThrowError(/too many terminals/);
    service.closeAll();
  });
});
