import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
) as {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const eslintConfig = readFileSync(path.join(repoRoot, 'eslint.config.mjs'), 'utf8');
const workflow = readFileSync(path.join(repoRoot, 'deploy/ci-workflow.yml'), 'utf8');

describe('zero-warning lint gate', () => {
  it('runs ESLint over the repo and bash -n over the deploy scripts', () => {
    expect(packageJson.scripts?.['lint']).toBe(
      'npm run --silent lint:js && npm run --silent lint:sh',
    );
    expect(packageJson.scripts?.['lint:js']).toBe('eslint . --max-warnings=0');
    expect(packageJson.scripts?.['lint:sh']).toBe(
      'for f in deploy/*.sh scripts/*.sh; do bash -n "$f" || exit 1; done',
    );
  });

  it('keeps the ESLint toolchain as root devDependencies', () => {
    for (const dependency of [
      'eslint',
      '@eslint/js',
      'globals',
      'typescript-eslint',
      'eslint-plugin-react-hooks',
    ]) {
      expect(packageJson.devDependencies?.[dependency], dependency).toBeDefined();
    }
  });

  it('scopes the flat config to src, scripts, and .opencode and keeps unused suppressions fatal', () => {
    expect(eslintConfig).toContain("files: ['**/*.{js,mjs,cjs}']");
    expect(eslintConfig).toContain(
      "files: ['src/**/*.{ts,tsx}', '.opencode/**/*.{ts,mts,cts}']",
    );
    expect(eslintConfig).toContain("files: ['scripts/screenshots.mjs', 'scripts/ui-smoke.mjs']");
    expect(eslintConfig).toContain("'**/dist/**'");
    expect(eslintConfig).toContain("'**/node_modules/**'");
    expect(eslintConfig).toContain("reportUnusedDisableDirectives: 'error'");
    expect(eslintConfig).toContain("'@typescript-eslint/no-explicit-any': 'warn'");
    expect(eslintConfig).toContain(
      "extends: [reactHooks.configs.flat['recommended-latest']]",
    );
    expect(eslintConfig).not.toContain("'react-hooks/rules-of-hooks': 'error'");
  });

  it('runs the gate in CI before typecheck', () => {
    const lint = workflow.indexOf('- run: npm run lint');
    const typecheck = workflow.indexOf('- run: npm run typecheck');
    expect(lint).toBeGreaterThan(-1);
    expect(typecheck).toBeGreaterThan(lint);
    expect(workflow).toContain('name: lint, typecheck, test, build, smoke');
  });
});
