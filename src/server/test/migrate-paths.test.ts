import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './tmp.js';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { legacyPathWarning, loadConfig } from '../src/config.js';

const script = fileURLToPath(new URL('../../../scripts/migrate-paths.mjs', import.meta.url));
const HOLDER_READY_TIMEOUT_MS = 5000;

interface RunOptions {
  active?: string[];
  systemctl?: boolean;
}

function workspace() {
  const root = tmpDir('migrate');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'repo');
  const configHome = path.join(root, 'config');
  const stateHome = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  const emptyBin = path.join(root, 'empty-bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(emptyBin, { recursive: true });
  writeSystemctl(bin);
  return { root, home, cwd, configHome, stateHome, bin, emptyBin };
}

function writeSystemctl(bin: string): void {
  const file = path.join(bin, 'systemctl');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      'scope=system',
      'if [ "$1" = "--user" ]; then scope=user; shift; fi',
      'for last; do :; done',
      'for entry in $SYSTEMCTL_ACTIVE; do',
      '  if [ "$entry" = "$scope:$last" ]; then exit 0; fi',
      'done',
      'exit 3',
      '',
    ].join('\n'),
  );
  chmodSync(file, 0o755);
}

function run(
  paths: ReturnType<typeof workspace>,
  args: string[] = [],
  options: RunOptions = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [script, '--home', paths.home, '--cwd', paths.cwd, ...args], {
    cwd: paths.root,
    env: {
      PATH: options.systemctl === false ? paths.emptyBin : paths.bin,
      HOME: paths.home,
      XDG_CONFIG_HOME: paths.configHome,
      XDG_STATE_HOME: paths.stateHome,
      SYSTEMCTL_ACTIVE: (options.active ?? []).join(' '),
    },
    encoding: 'utf8',
  });
}

async function waitForHolder(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('holder process did not become ready'));
    }, HOLDER_READY_TIMEOUT_MS);
    timer.unref();
    const onData = (chunk: Buffer | string) => {
      if (!String(chunk).includes('ready')) return;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      resolve();
    };
    child.stdout?.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`holder process exited early with code ${code}`));
    });
  });
}

async function stopHolder(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

/** Hold a file descriptor open in a separate process until the test stops it. */
async function holdFile(file: string): Promise<ChildProcess> {
  const code = [
    "const fs = require('node:fs');",
    `fs.openSync(${JSON.stringify(file)}, 'r');`,
    "process.stdout.write('ready');",
    'setInterval(() => {}, 1000);',
  ].join(' ');
  const child = spawn(process.execPath, ['-e', code], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    await waitForHolder(child);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  return child;
}

/** Start a separate process with a cwd inside the migration source. */
async function holdCwd(cwd: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000);"],
    { cwd, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  try {
    await waitForHolder(child);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  return child;
}

function write(file: string, body = 'x'): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function seedLegacy(paths: ReturnType<typeof workspace>) {
  const data = path.join(paths.home, '.sandbox-harness');
  const config = path.join(paths.configHome, 'sandbox-harness');
  const state = path.join(paths.stateHome, 'sandbox-harness');
  write(path.join(data, 'requests', 'req-1', 'session.json'), '{"sessionId":"s1"}');
  write(path.join(config, 'config.json'), '{"master":{}}');
  write(path.join(config, 'process.json'), '{"version":1}');
  write(path.join(state, 'errors.log'), '{"source":"old"}\n');
  const db = path.join(paths.cwd, 'sandbox-harness.sqlite');
  write(db, 'db');
  write(`${db}-wal`, 'wal');
  write(`${db}-shm`, 'shm');
  return { data, config, state, db };
}

describe('migrate-paths script', () => {
  it('reports planned moves without changing anything in dry-run mode', () => {
    const paths = workspace();
    const legacy = seedLegacy(paths);

    const result = run(paths, ['--dry-run']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('would move data directory');
    expect(result.stdout).toContain('would move config directory');
    expect(result.stdout).toContain('would move state directory');
    expect(result.stdout).toContain('would move database');
    expect(result.stdout).toContain('would move database-wal');
    expect(result.stdout).toContain('would move database-shm');
    expect(result.stdout).toContain('dry run: no files were changed');
    expect(existsSync(legacy.data)).toBe(true);
    expect(existsSync(path.join(paths.home, '.agent-process-segments'))).toBe(false);
  });

  it('moves every default location, including SQLite sidecars', () => {
    const paths = workspace();
    const legacy = seedLegacy(paths);

    const result = run(paths);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('migration complete');
    expect(existsSync(legacy.data)).toBe(false);
    expect(existsSync(legacy.config)).toBe(false);
    expect(existsSync(legacy.state)).toBe(false);
    expect(existsSync(legacy.db)).toBe(false);
    expect(
      readFileSync(
        path.join(paths.home, '.agent-process-segments', 'requests', 'req-1', 'session.json'),
        'utf8',
      ),
    ).toContain('s1');
    expect(
      readFileSync(path.join(paths.configHome, 'agent-process-segments', 'config.json'), 'utf8'),
    ).toContain('master');
    expect(
      readFileSync(path.join(paths.stateHome, 'agent-process-segments', 'errors.log'), 'utf8'),
    ).toContain('old');
    expect(readFileSync(path.join(paths.cwd, 'agent-process-segments.sqlite'), 'utf8')).toBe('db');
    expect(readFileSync(path.join(paths.cwd, 'agent-process-segments.sqlite-wal'), 'utf8')).toBe(
      'wal',
    );
    expect(readFileSync(path.join(paths.cwd, 'agent-process-segments.sqlite-shm'), 'utf8')).toBe(
      'shm',
    );
  });

  it('never overwrites an existing destination', () => {
    const paths = workspace();
    const legacy = seedLegacy(paths);
    write(path.join(paths.home, '.agent-process-segments', 'keep.txt'), 'new');

    const result = run(paths);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('skip data directory');
    expect(existsSync(path.join(legacy.data, 'requests', 'req-1', 'session.json'))).toBe(true);
    expect(
      readFileSync(path.join(paths.home, '.agent-process-segments', 'keep.txt'), 'utf8'),
    ).toBe('new');
  });

  it('is a no-op on a second run', () => {
    const paths = workspace();
    seedLegacy(paths);
    expect(run(paths).status).toBe(0);

    const result = run(paths);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('nothing to migrate');
  });

  it('refuses to move while the renamed brain unit is active', () => {
    const paths = workspace();
    const legacy = seedLegacy(paths);

    const result = run(paths, [], { active: ['user:agent-process-segments.service'] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('agent-process-segments.service');
    expect(result.stderr).toContain('--allow-running');
    expect(result.stderr).toContain('systemctl --user stop agent-process-segments.service');
    expect(existsSync(legacy.data)).toBe(true);
    expect(existsSync(legacy.config)).toBe(true);
    expect(existsSync(legacy.state)).toBe(true);
    expect(existsSync(legacy.db)).toBe(true);
    expect(existsSync(`${legacy.db}-wal`)).toBe(true);
    expect(existsSync(`${legacy.db}-shm`)).toBe(true);
    expect(existsSync(path.join(paths.home, '.agent-process-segments'))).toBe(false);
    expect(existsSync(path.join(paths.cwd, 'agent-process-segments.sqlite'))).toBe(false);
  });

  it('refuses to move while the legacy system unit is active', () => {
    const paths = workspace();
    seedLegacy(paths);

    const result = run(paths, [], { active: ['system:sandbox-harness.service'] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('sandbox-harness.service (system)');
    expect(result.stderr).toContain('sudo systemctl stop sandbox-harness.service');
  });

  it('names both units when both are active', () => {
    const paths = workspace();
    seedLegacy(paths);

    const result = run(paths, [], {
      active: ['user:agent-process-segments.service', 'user:sandbox-harness.service'],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('agent-process-segments.service (user)');
    expect(result.stderr).toContain('sandbox-harness.service (user)');
  });

  it('warns but still previews in dry-run mode while a unit is active', () => {
    const paths = workspace();
    const legacy = seedLegacy(paths);

    const result = run(paths, ['--dry-run'], {
      active: ['user:agent-process-segments.service'],
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('a real run would refuse');
    expect(result.stdout).toContain('would move data directory');
    expect(result.stdout).toContain('dry run: no files were changed');
    expect(existsSync(legacy.data)).toBe(true);
    expect(existsSync(path.join(paths.home, '.agent-process-segments'))).toBe(false);
  });

  it('warns and previews with --allow-running in dry-run mode', () => {
    const paths = workspace();
    const legacy = seedLegacy(paths);

    const result = run(paths, ['--dry-run', '--allow-running'], {
      active: ['user:agent-process-segments.service'],
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('would move files under a live brain');
    expect(result.stdout).toContain('would move data directory');
    expect(result.stdout).toContain('dry run: no files were changed');
    expect(existsSync(legacy.data)).toBe(true);
  });

  it('moves with --allow-running and warns about corruption', () => {
    const paths = workspace();
    const legacy = seedLegacy(paths);

    const result = run(paths, ['--allow-running'], {
      active: ['user:agent-process-segments.service'],
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('can corrupt the database');
    expect(result.stdout).toContain('migration complete');
    expect(existsSync(legacy.data)).toBe(false);
    expect(existsSync(path.join(paths.home, '.agent-process-segments'))).toBe(true);
    expect(readFileSync(path.join(paths.cwd, 'agent-process-segments.sqlite-wal'), 'utf8')).toBe(
      'wal',
    );
    expect(readFileSync(path.join(paths.cwd, 'agent-process-segments.sqlite-shm'), 'utf8')).toBe(
      'shm',
    );
  });

  it.skipIf(process.platform !== 'linux')(
    'refuses while a process holds the legacy database open',
    async () => {
      const paths = workspace();
      const legacy = seedLegacy(paths);
      const holder = await holdFile(legacy.db);

      try {
        const result = run(paths);

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/pid \d+ \(.+\)/);
        expect(result.stderr).toContain('sandbox-harness.sqlite open');
        expect(result.stderr).toContain('--allow-running');
        expect(existsSync(legacy.data)).toBe(true);
        expect(existsSync(legacy.config)).toBe(true);
        expect(existsSync(legacy.state)).toBe(true);
        expect(existsSync(legacy.db)).toBe(true);
        expect(existsSync(`${legacy.db}-wal`)).toBe(true);
        expect(existsSync(`${legacy.db}-shm`)).toBe(true);
        expect(existsSync(path.join(paths.home, '.agent-process-segments'))).toBe(false);
        expect(existsSync(path.join(paths.cwd, 'agent-process-segments.sqlite'))).toBe(false);
      } finally {
        await stopHolder(holder);
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'refuses while a process cwd is inside the legacy data directory',
    async () => {
      const paths = workspace();
      const legacy = seedLegacy(paths);
      const holder = await holdCwd(legacy.data);

      try {
        const result = run(paths);

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/pid \d+ \(.+\)/);
        expect(result.stderr).toContain('has cwd');
        expect(result.stderr).toContain('.sandbox-harness');
        expect(existsSync(legacy.data)).toBe(true);
        expect(existsSync(path.join(paths.home, '.agent-process-segments'))).toBe(false);
      } finally {
        await stopHolder(holder);
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'refuses while a process holds a file inside the legacy config directory open',
    async () => {
      const paths = workspace();
      const legacy = seedLegacy(paths);
      const holder = await holdFile(path.join(legacy.config, 'config.json'));

      try {
        const result = run(paths);

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/pid \d+ \(.+\)/);
        expect(result.stderr).toContain('config.json open');
        expect(existsSync(legacy.config)).toBe(true);
        expect(existsSync(path.join(paths.configHome, 'agent-process-segments'))).toBe(false);
      } finally {
        await stopHolder(holder);
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'warns but previews in dry-run mode while a process holds a path',
    async () => {
      const paths = workspace();
      const legacy = seedLegacy(paths);
      const holder = await holdFile(legacy.db);

      try {
        const result = run(paths, ['--dry-run']);

        expect(result.status).toBe(0);
        expect(result.stderr).toContain('a real run would refuse');
        expect(result.stderr).toContain('using the planned paths');
        expect(result.stdout).toContain('would move data directory');
        expect(result.stdout).toContain('dry run: no files were changed');
        expect(existsSync(legacy.db)).toBe(true);
        expect(existsSync(path.join(paths.cwd, 'agent-process-segments.sqlite'))).toBe(false);
      } finally {
        await stopHolder(holder);
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'moves with --allow-running and warns while a process holds a path',
    async () => {
      const paths = workspace();
      const legacy = seedLegacy(paths);
      const holder = await holdFile(legacy.db);

      try {
        const result = run(paths, ['--allow-running']);

        expect(result.status).toBe(0);
        expect(result.stderr).toContain('can corrupt the database');
        expect(result.stdout).toContain('migration complete');
        expect(existsSync(legacy.db)).toBe(false);
        expect(readFileSync(path.join(paths.cwd, 'agent-process-segments.sqlite'), 'utf8')).toBe(
          'db',
        );
        expect(
          readFileSync(path.join(paths.cwd, 'agent-process-segments.sqlite-wal'), 'utf8'),
        ).toBe('wal');
        expect(
          readFileSync(path.join(paths.cwd, 'agent-process-segments.sqlite-shm'), 'utf8'),
        ).toBe('shm');
      } finally {
        await stopHolder(holder);
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'reports nothing to migrate when a process holds a path but every move is skipped',
    async () => {
      const paths = workspace();
      const legacy = seedLegacy(paths);
      write(path.join(paths.home, '.agent-process-segments', 'keep.txt'), 'new');
      write(path.join(paths.configHome, 'agent-process-segments', 'keep.txt'), 'new');
      write(path.join(paths.stateHome, 'agent-process-segments', 'keep.txt'), 'new');
      write(path.join(paths.cwd, 'agent-process-segments.sqlite'), 'new');
      const holder = await holdFile(legacy.db);

      try {
        const result = run(paths);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('nothing to migrate');
        expect(result.stderr).not.toContain('refusing to migrate');
      } finally {
        await stopHolder(holder);
      }
    },
  );

  it('still reports nothing to migrate when a unit is active but there is no legacy data', () => {
    const paths = workspace();

    const result = run(paths, [], { active: ['user:agent-process-segments.service'] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('nothing to migrate');
    expect(result.stderr).not.toContain('refusing to migrate');
  });

  it('proceeds with a note when systemctl is unavailable', () => {
    const paths = workspace();
    const legacy = seedLegacy(paths);

    const result = run(paths, [], { systemctl: false });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('could not query systemd');
    expect(result.stdout).toContain('migration complete');
    expect(existsSync(legacy.data)).toBe(false);
  });

  it('documents --allow-running in --help', () => {
    const paths = workspace();

    const result = run(paths, ['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--allow-running');
    expect(result.stdout).toContain('unsafe');
  });

  it('moves a complete legacy install so the next load uses canonical paths', () => {
    const paths = workspace();
    const legacyData = path.join(paths.home, '.sandbox-harness');
    const legacyConfigDir = path.join(paths.configHome, 'sandbox-harness');
    const legacyStateDir = path.join(paths.stateHome, 'sandbox-harness');
    const legacyDb = path.join(paths.cwd, 'sandbox-harness.sqlite');

    write(path.join(legacyData, 'requests', 'req-1', 'session.json'), '{"sessionId":"s1"}');
    write(path.join(legacyConfigDir, 'config.json'), '{"master":{}}');
    write(path.join(legacyConfigDir, 'process.json'), '{"version":1}');
    write(path.join(legacyStateDir, 'errors.log'), '{"source":"old"}\n');

    const db = new Database(legacyDb);
    db.exec('CREATE TABLE markers (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO markers (value) VALUES (?)').run('kept');
    db.close();

    const env = {
      XDG_CONFIG_HOME: paths.configHome,
      XDG_STATE_HOME: paths.stateHome,
    };
    const before = loadConfig(env, paths.cwd, paths.home);
    expect(before.dataDir).toBe(legacyData);
    expect(before.configPath).toBe(path.join(legacyConfigDir, 'config.json'));
    expect(before.processPath).toBe(path.join(legacyConfigDir, 'process.json'));
    expect(before.errorLogPath).toBe(path.join(legacyStateDir, 'errors.log'));
    expect(before.dbPath).toBe(legacyDb);
    expect(before.legacyPaths).toEqual([
      legacyData,
      path.join(legacyConfigDir, 'config.json'),
      path.join(legacyConfigDir, 'process.json'),
      path.join(legacyStateDir, 'errors.log'),
      legacyDb,
    ]);
    const warning = legacyPathWarning(before.legacyPaths);
    expect(warning).not.toBeNull();
    for (const legacyPath of before.legacyPaths) expect(warning).toContain(legacyPath);

    const result = run(paths);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('migration complete');

    const after = loadConfig(env, paths.cwd, paths.home);
    expect(after.dataDir).toBe(path.join(paths.home, '.agent-process-segments'));
    expect(after.configPath).toBe(
      path.join(paths.configHome, 'agent-process-segments', 'config.json'),
    );
    expect(after.processPath).toBe(
      path.join(paths.configHome, 'agent-process-segments', 'process.json'),
    );
    expect(after.errorLogPath).toBe(
      path.join(paths.stateHome, 'agent-process-segments', 'errors.log'),
    );
    expect(after.dbPath).toBe(path.join(paths.cwd, 'agent-process-segments.sqlite'));
    expect(after.legacyPaths).toEqual([]);

    const migrated = new Database(after.dbPath, { readonly: true });
    try {
      expect(migrated.prepare('SELECT value FROM markers').pluck().get()).toBe('kept');
    } finally {
      migrated.close();
    }

    const second = run(paths);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('nothing to migrate');
  });
});
