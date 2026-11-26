import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = path.join(repoRoot, 'scripts', 'check-dev-deps.mjs');
const packageJson = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
) as { scripts?: Record<string, string> };

const MODES: ReadonlyArray<{ mode: string; tools: readonly string[] }> = [
  { mode: 'typecheck', tools: ['tsc'] },
  { mode: 'test', tools: ['vitest'] },
  { mode: 'lint', tools: ['eslint', 'markdownlint-cli2'] },
];

function run(mode: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [script, mode, ...args], { encoding: 'utf8', env });
}

/** A minimal project root with no installed dev binaries. */
function emptyRoot(prefix: string): string {
  const root = tmpDir(prefix);
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","private":true}\n');
  return root;
}

function executable(file: string): void {
  writeFileSync(file, '#!/usr/bin/env sh\nexit 0\n');
  chmodSync(file, 0o755);
}

describe('root dev dependency preflight', () => {
  it('is silent on a healthy install for every mode', () => {
    for (const { mode } of MODES) {
      const result = run(mode, [], { ...process.env, NODE_ENV: 'production' });
      expect(result.status, mode).toBe(0);
      expect(result.stdout, mode).toBe('');
      expect(result.stderr, mode).toBe('');
    }
  });

  it('reports each missing tool with the install hint', () => {
    const root = emptyRoot('dev-preflight-missing');

    for (const { mode, tools } of MODES) {
      const result = run(mode, ['--root', root], { ...process.env, NODE_ENV: 'production' });
      expect(result.status, mode).toBe(1);
      expect(result.stdout, mode).toBe('');
      expect(result.stderr, mode).toContain(
        `${mode}: missing devDependencies (${tools.join(', ')})`,
      );
      expect(result.stderr, mode).toContain('npm ci --include=dev');
      expect(result.stderr, mode).toContain('NODE_ENV=production');
      expect(result.stderr, mode).toContain('npm config get omit');
    }
  });

  it('checks only the tools each mode needs', () => {
    const root = emptyRoot('dev-preflight-lint-tools');
    const bin = path.join(root, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    const lintTools = MODES.find((entry) => entry.mode === 'lint')?.tools ?? [];
    for (const tool of lintTools) executable(path.join(bin, tool));

    const lint = run('lint', ['--root', root], { ...process.env, NODE_ENV: 'production' });
    expect(lint.status).toBe(0);
    expect(lint.stdout).toBe('');
    expect(lint.stderr).toBe('');

    for (const { mode, tools } of MODES.filter((entry) => entry.mode !== 'lint')) {
      const result = run(mode, ['--root', root], { ...process.env, NODE_ENV: 'production' });
      expect(result.status, mode).toBe(1);
      for (const tool of tools) expect(result.stderr, mode).toContain(tool);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'ignores global PATH shims and NODE_PATH packages',
    () => {
      const root = emptyRoot('dev-preflight-global');
      const pathDir = tmpDir('dev-preflight-path');
      for (const { tools } of MODES) {
        for (const tool of tools) executable(path.join(pathDir, tool));
      }

      const nodePathDir = tmpDir('dev-preflight-node-path');
      for (const { tools } of MODES) {
        for (const tool of tools) {
          const packageDir = path.join(nodePathDir, 'node_modules', tool);
          mkdirSync(packageDir, { recursive: true });
          writeFileSync(
            path.join(packageDir, 'package.json'),
            JSON.stringify({ name: tool, main: 'index.js' }),
          );
          writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = 1;\n');
        }
      }

      for (const { mode, tools } of MODES) {
        const result = run(mode, ['--root', root], {
          ...process.env,
          NODE_ENV: 'production',
          PATH: pathDir,
          NODE_PATH: path.join(nodePathDir, 'node_modules'),
        });
        expect(result.status, mode).toBe(1);
        expect(result.stdout, mode).toBe('');
        for (const tool of tools) expect(result.stderr, mode).toContain(tool);
      }
    },
  );

  it('wires the preflight into the root scripts', () => {
    expect(packageJson.scripts?.['pretypecheck']).toBe(
      'node scripts/check-dev-deps.mjs typecheck',
    );
    expect(packageJson.scripts?.['pretest']).toBe('node scripts/check-dev-deps.mjs test');
    expect(packageJson.scripts?.['prelint']).toBe('node scripts/check-dev-deps.mjs lint');
    expect(packageJson.scripts?.['typecheck']).toBe(
      'npm run typecheck --workspace src/server && npm run typecheck --workspace src/web',
    );
    expect(packageJson.scripts?.['test']).toBe(
      'npm test --workspace src/server && npm test --workspace src/web && npm run test:e2e-env',
    );
    expect(packageJson.scripts?.['lint']).toBe(
      'npm run --silent lint:js && npm run --silent lint:sh && npm run --silent lint:md',
    );
  });

  it('rejects an unknown mode with a usage error', () => {
    const result = run('bogus');
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown mode: bogus');
    expect(result.stderr).toContain('Usage:');
  });
});
