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
const markdownConfig = readFileSync(path.join(repoRoot, '.markdownlint-cli2.jsonc'), 'utf8');
const workflow = readFileSync(path.join(repoRoot, 'deploy/ci-workflow.yml'), 'utf8');
const tsconfigTest = JSON.parse(
  readFileSync(path.join(repoRoot, 'src/server/tsconfig.test.json'), 'utf8'),
) as { include?: string[] };

describe('zero-warning lint gate', () => {
  it('runs ESLint, ShellCheck, actionlint, systemd-analyze verify, and markdownlint', () => {
    expect(packageJson.scripts?.['lint']).toBe(
      'npm run --silent lint:js && npm run --silent lint:sh && npm run --silent lint:actions && npm run --silent lint:unit && npm run --silent lint:md',
    );
    expect(packageJson.scripts?.['lint:js']).toBe('eslint . --max-warnings=0');
    expect(packageJson.scripts?.['lint:sh']).toBe(
      'for f in deploy/*.sh scripts/*.sh; do bash -n "$f" || exit 1; shellcheck --severity=warning "$f" || exit 1; done',
    );
    expect(packageJson.scripts?.['lint:sh']).toContain('shellcheck --severity=warning');
    expect(packageJson.scripts?.['lint:md']).toBe('markdownlint-cli2 "**/*.md"');
    expect(workflow).toContain('make g++ python3 shellcheck');
    expect(packageJson.scripts?.['lint:actions']).toBe(
      'actionlint deploy/ci-workflow.yml',
    );
    expect(packageJson.scripts?.['lint:unit']).toBe(
      'node scripts/verify-systemd-unit.mjs',
    );
  });

  it('keeps the lint toolchain as root devDependencies', () => {
    for (const dependency of [
      'eslint',
      '@eslint/js',
      'globals',
      'typescript-eslint',
      'eslint-plugin-react-hooks',
      'markdownlint-cli2',
    ]) {
      expect(packageJson.devDependencies?.[dependency], dependency).toBeDefined();
    }
  });

  it('pins the lint and typecheck scope for src, scripts, .opencode, Markdown, and the vitest config', () => {
    expect(eslintConfig).toContain("files: ['**/*.{js,mjs,cjs}']");
    expect(eslintConfig).toContain(
      "files: ['src/**/*.{ts,tsx,mts,cts}', '.opencode/**/*.{ts,mts,cts}']",
    );
    expect(
      tsconfigTest.include,
      'the server test project must typecheck vitest.config.mts',
    ).toContain('vitest.config.mts');
    expect(eslintConfig).toContain("files: ['scripts/screenshots.mjs', 'scripts/ui-smoke.mjs']");
    expect(eslintConfig).toContain("'**/dist/**'");
    expect(eslintConfig).toContain("'**/node_modules/**'");
    expect(eslintConfig).toContain("reportUnusedDisableDirectives: 'error'");
    expect(eslintConfig).toContain("'@typescript-eslint/no-explicit-any': 'warn'");
    expect(eslintConfig).toContain(
      "extends: [reactHooks.configs.flat['recommended-latest']]",
    );
    expect(eslintConfig).not.toContain("'react-hooks/rules-of-hooks': 'error'");
    expect(markdownConfig).toContain('"**/node_modules/**"');
    expect(markdownConfig).toContain('"**/dist/**"');
    expect(markdownConfig).toContain('"line_length": 120');
    expect(markdownConfig).toContain('"tables": false');
    expect(markdownConfig).toContain('"code_blocks": false');
    expect(markdownConfig).toContain('"headings": false');
  });

  it('runs the gate in CI before typecheck', () => {
    const lint = workflow.indexOf('- run: npm run lint');
    const typecheck = workflow.indexOf('- run: npm run typecheck');
    expect(lint).toBeGreaterThan(-1);
    expect(typecheck).toBeGreaterThan(lint);
    expect(workflow).toContain('name: lint, typecheck, test, build, smoke');

    const install = workflow.indexOf('name: Install actionlint');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(lint);
    expect(workflow).toContain(
      'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz',
    );
    expect(workflow).toContain(
      '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8  /tmp/actionlint.tar.gz',
    );
    expect(workflow).toContain(
      'sudo tar -xzf /tmp/actionlint.tar.gz -C /usr/local/bin actionlint',
    );
    expect(workflow).toContain('actionlint --version');
  });
});
