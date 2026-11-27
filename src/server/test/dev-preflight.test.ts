import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = path.join(repoRoot, 'scripts', 'check-dev-deps.mjs');

interface Manifest {
  scripts?: Record<string, string>;
}

function readManifest(relativePath: string): Manifest {
  return JSON.parse(
    readFileSync(path.join(repoRoot, relativePath), 'utf8'),
  ) as Manifest;
}

const packageJson = readManifest('package.json');
const serverPackageJson = readManifest('src/server/package.json');
const webPackageJson = readManifest('src/web/package.json');

const MODES: ReadonlyArray<{ mode: string; tools: readonly string[] }> = [
  { mode: 'typecheck', tools: ['tsc'] },
  { mode: 'test', tools: ['vitest'] },
  { mode: 'lint', tools: ['eslint', 'markdownlint-cli2'] },
  { mode: 'lint-js', tools: ['eslint'] },
  { mode: 'lint-md', tools: ['markdownlint-cli2'] },
  { mode: 'build', tools: ['tsc', 'vite'] },
  { mode: 'build-web', tools: ['vite'] },
  { mode: 'build-server', tools: ['tsc'] },
  { mode: 'dev', tools: ['concurrently', 'tsx', 'vite'] },
  { mode: 'dev-web', tools: ['vite'] },
  { mode: 'dev-server', tools: ['tsx'] },
  { mode: 'preview-web', tools: ['vite'] },
  { mode: 'e2e', tools: ['tsc', 'vite'] },
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
    for (const fixture of MODES) {
      const root = emptyRoot(`dev-preflight-${fixture.mode}`);
      const bin = path.join(root, 'node_modules', '.bin');
      mkdirSync(bin, { recursive: true });
      const installed = new Set(fixture.tools);
      for (const tool of fixture.tools) executable(path.join(bin, tool));

      for (const candidate of MODES) {
        const result = run(candidate.mode, ['--root', root], {
          ...process.env,
          NODE_ENV: 'production',
        });
        const label = `${fixture.mode} fixture / ${candidate.mode}`;
        const missing = candidate.tools.filter((tool) => !installed.has(tool));

        if (missing.length === 0) {
          expect(result.status, label).toBe(0);
          expect(result.stdout, label).toBe('');
          expect(result.stderr, label).toBe('');
        } else {
          expect(result.status, label).toBe(1);
          expect(result.stdout, label).toBe('');
          expect(result.stderr, label).toContain(
            `${candidate.mode}: missing devDependencies (${missing.join(', ')})`,
          );
        }
      }
    }

    const workspaceRoot = emptyRoot('dev-preflight-workspace');
    const webBin = path.join(workspaceRoot, 'src', 'web', 'node_modules', '.bin');
    const serverBin = path.join(workspaceRoot, 'src', 'server', 'node_modules', '.bin');
    mkdirSync(webBin, { recursive: true });
    mkdirSync(serverBin, { recursive: true });

    const expectMode = (mode: string, missing: readonly string[]): void => {
      const result = run(mode, ['--root', workspaceRoot], {
        ...process.env,
        NODE_ENV: 'production',
      });
      expect(result.status, mode).toBe(missing.length === 0 ? 0 : 1);
      expect(result.stdout, mode).toBe('');
      if (missing.length === 0) {
        expect(result.stderr, mode).toBe('');
      } else {
        expect(result.stderr, mode).toContain(
          `${mode}: missing devDependencies (${missing.join(', ')})`,
        );
      }
    };

    executable(path.join(webBin, 'tsc'));
    expectMode('build-server', ['tsc']);

    executable(path.join(serverBin, 'tsc'));
    expectMode('build-server', []);

    executable(path.join(serverBin, 'vite'));
    expectMode('build-web', ['vite']);

    executable(path.join(webBin, 'vite'));
    expectMode('build-web', []);
    expectMode('dev-web', []);
    expectMode('preview-web', []);

    executable(path.join(webBin, 'tsx'));
    expectMode('dev-server', ['tsx']);

    executable(path.join(serverBin, 'tsx'));
    expectMode('dev-server', []);
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

  it('wires the preflight into the root and workspace scripts', () => {
    const rootHooks: ReadonlyArray<readonly [string, string]> = [
      ['pretypecheck', 'node scripts/check-dev-deps.mjs typecheck'],
      ['pretest', 'node scripts/check-dev-deps.mjs test'],
      ['prelint', 'node scripts/check-dev-deps.mjs lint'],
      ['prelint:js', 'node scripts/check-dev-deps.mjs lint-js'],
      ['prelint:md', 'node scripts/check-dev-deps.mjs lint-md'],
      ['prebuild', 'node scripts/check-dev-deps.mjs build'],
      ['predev', 'node scripts/check-dev-deps.mjs dev'],
      ['pree2e', 'node scripts/check-dev-deps.mjs e2e'],
    ];
    for (const [hook, command] of rootHooks) {
      expect(packageJson.scripts?.[hook], hook).toBe(command);
    }

    const workspaces: ReadonlyArray<readonly [string, Manifest]> = [
      ['src/server', serverPackageJson],
      ['src/web', webPackageJson],
    ];
    for (const [workspace, manifest] of workspaces) {
      expect(manifest.scripts?.['pretest'], `${workspace} pretest`).toBe(
        'node ../../scripts/check-dev-deps.mjs test',
      );
      expect(manifest.scripts?.['pretypecheck'], `${workspace} pretypecheck`).toBe(
        'node ../../scripts/check-dev-deps.mjs typecheck',
      );
    }

    const workspaceHooks: ReadonlyArray<
      readonly [string, Manifest, string, string]
    > = [
      ['src/server', serverPackageJson, 'prebuild', 'build-server'],
      ['src/server', serverPackageJson, 'predev', 'dev-server'],
      ['src/web', webPackageJson, 'prebuild', 'build-web'],
      ['src/web', webPackageJson, 'predev', 'dev-web'],
      ['src/web', webPackageJson, 'prepreview', 'preview-web'],
    ];
    for (const [workspace, manifest, hook, mode] of workspaceHooks) {
      expect(manifest.scripts?.[hook], `${workspace} ${hook}`).toBe(
        `node ../../scripts/check-dev-deps.mjs ${mode}`,
      );
    }

    expect(packageJson.scripts?.['typecheck']).toBe(
      'npm run typecheck --workspace src/server && npm run typecheck --workspace src/web',
    );
    expect(packageJson.scripts?.['test']).toBe(
      'npm test --workspace src/server && npm test --workspace src/web && npm run test:e2e-env',
    );
    expect(packageJson.scripts?.['lint']).toBe(
      'npm run --silent lint:js && npm run --silent lint:sh && npm run --silent lint:actions && npm run --silent lint:unit && npm run --silent lint:md',
    );
    expect(packageJson.scripts?.['lint:unit']).toBe(
      'node scripts/verify-systemd-unit.mjs',
    );
  });

  it('rejects an unknown mode with a usage error', () => {
    const result = run('bogus');
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown mode: bogus');
    expect(result.stderr).toContain(
      'Usage: node scripts/check-dev-deps.mjs <typecheck|test|lint|lint-js|lint-md|build|build-web|build-server|dev|dev-web|dev-server|preview-web|e2e> [--root <dir>]',
    );
  });
});
