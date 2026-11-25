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
  it('runs ESLint over src with warnings treated as failures', () => {
    expect(packageJson.scripts?.['lint']).toBe('eslint src --max-warnings=0');
  });

  it('keeps the ESLint toolchain as root devDependencies', () => {
    for (const dependency of ['eslint', 'typescript-eslint', 'eslint-plugin-react-hooks']) {
      expect(packageJson.devDependencies?.[dependency], dependency).toBeDefined();
    }
  });

  it('scopes the flat config to src and keeps unused suppressions fatal', () => {
    expect(eslintConfig).toContain("files: ['src/**/*.{ts,tsx}']");
    expect(eslintConfig).toContain("'**/dist/**'");
    expect(eslintConfig).toContain("'**/node_modules/**'");
    expect(eslintConfig).toContain("reportUnusedDisableDirectives: 'error'");
    expect(eslintConfig).toContain("'@typescript-eslint/no-explicit-any': 'warn'");
    expect(eslintConfig).toContain("'react-hooks/rules-of-hooks': 'error'");
    expect(eslintConfig).toContain("'react-hooks/exhaustive-deps': 'warn'");
  });

  it('runs the gate in CI before typecheck', () => {
    const lint = workflow.indexOf('- run: npm run lint');
    const typecheck = workflow.indexOf('- run: npm run typecheck');
    expect(lint).toBeGreaterThan(-1);
    expect(typecheck).toBeGreaterThan(lint);
    expect(workflow).toContain('name: lint, typecheck, test, build, smoke');
  });
});
