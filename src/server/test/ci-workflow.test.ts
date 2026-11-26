import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const workflowPath = path.join(repoRoot, 'deploy/ci-workflow.yml');
const workflow = readFileSync(workflowPath, 'utf8');

/** One `      - …` step of the single `test` job, starting at its first key. */
function stepBlock(name: string): string {
  const steps = workflow.split(/\n {6}- /).slice(1);
  const block = steps.find((step) => step.startsWith(`name: ${name}\n`));
  if (block === undefined) {
    throw new Error(`deploy/ci-workflow.yml has no step named "${name}"`);
  }
  return block;
}

/** The step-level `env:` mapping, with plain YAML quoting removed. */
function stepEnv(block: string): Record<string, string> {
  const env: Record<string, string> = {};
  let inEnv = false;
  for (const line of block.split('\n')) {
    if (line === '        env:') {
      inEnv = true;
      continue;
    }
    if (!inEnv) continue;
    const entry = /^ {10}([A-Z0-9_]+): (.+)$/.exec(line);
    if (entry) {
      const name = entry[1];
      const rawValue = entry[2];
      if (name !== undefined && rawValue !== undefined) {
        env[name] = rawValue.replace(/^"(.*)"$/, '$1').trim();
      }
      continue;
    }
    if (line.trim() !== '' && !line.trimStart().startsWith('#')) inEnv = false;
  }
  return env;
}

// Sentinels that cannot resolve to the throwaway brain. They include the values
// from the original report plus the request-id names that made mcp-smoke call a
// host brain. Keep this list in step with deploy/ci-workflow.yml.
const HOSTILE_SENTINELS = {
  HOME: '/nonexistent',
  NODE_ENV: 'production',
  SBOX_HARNESS: 'opencode',
  SBOX_HARNESS_BIN: '/bin/false',
  SBOX_CLAUDE_BIN: '/bin/false',
  SBOX_PLUGINS_DIR: '/nonexistent/host-plugins',
  SBOX_BRAIN_URL: 'http://127.0.0.1:1',
  SBOX_REQUEST_ID: 'hostile-request',
  SBOX_TURN_TIMEOUT_MS: '1',
  APS_HARNESS: 'opencode',
  APS_HARNESS_BIN: '/bin/false',
  APS_CLAUDE_BIN: '/bin/false',
  APS_PLUGINS_DIR: '/nonexistent/host-plugins',
  APS_BRAIN_URL: 'http://127.0.0.1:1',
  APS_REQUEST_ID: 'hostile-request',
  APS_TURN_TIMEOUT_MS: '1',
  APS_DEFAULT_MODEL: 'host/model',
  ANTHROPIC_API_KEY: 'sk-hostile-not-real',
  ANTHROPIC_BASE_URL: 'https://example.invalid',
} as const;

const proofSteps = [
  { name: 'E2E API workflow', run: 'node scripts/e2e.mjs' },
  { name: 'MCP stdio smoke', run: 'node scripts/mcp-smoke.mjs' },
  { name: 'Claude mock smoke', run: 'node scripts/claude-mock-smoke.mjs' },
];

describe('deploy/ci-workflow.yml', () => {
  it('runs the web suite with an inherited NODE_ENV=production', () => {
    const compact = workflow.replace(/\s+/g, ' ');

    expect(compact).toContain('name: Web tests with inherited NODE_ENV=production');
    expect(compact).toContain('run: NODE_ENV=production npm test --workspace src/web');
  });

  it('fails on high runtime advisories before lint', () => {
    const block = stepBlock('Runtime dependency audit');
    expect(block).toContain('run: npm audit --omit=dev --audit-level=high\n');
    expect(block).not.toContain('continue-on-error');
    const runLine = block
      .split('\n')
      .find((line) => line.trimStart().startsWith('run: '));
    expect(runLine).not.toContain('|| true');
    expect(runLine).not.toContain('; true');

    const install = workflow.indexOf('- run: npm ci');
    const audit = workflow.indexOf('- name: Runtime dependency audit');
    const lint = workflow.indexOf('- run: npm run lint');
    const typecheck = workflow.indexOf('- run: npm run typecheck');
    expect(install).toBeGreaterThan(-1);
    expect(audit).toBeGreaterThan(install);
    expect(audit).toBeLessThan(lint);
    expect(audit).toBeLessThan(typecheck);
  });

  it('runs every proof step under the hostile sentinel set', () => {
    for (const { name, run } of proofSteps) {
      const block = stepBlock(name);
      const env = stepEnv(block);
      for (const [sentinel, value] of Object.entries(HOSTILE_SENTINELS)) {
        expect(env[sentinel], `${name} must export ${sentinel}`).toBe(value);
      }
      expect(block).toContain(`run: ${run}`);
    }
  });

  it('keeps the E2E and MCP env blocks identical', () => {
    const [e2e, mcp] = proofSteps;
    if (e2e === undefined || mcp === undefined) throw new Error('proof steps missing');
    expect(stepEnv(stepBlock(mcp.name))).toEqual(stepEnv(stepBlock(e2e.name)));
  });

  it('keeps the hostile env step-scoped', () => {
    // A job-level env would put HOME=/nonexistent on npm ci and NODE_ENV=production
    // on npm test, so the overrides must stay on the proof steps themselves.
    expect(workflow).not.toMatch(/^ {4}env:$/m);
    for (const { name } of proofSteps) {
      expect(stepBlock(name)).toMatch(/^ {8}env:$/m);
    }
  });
});

describe('.github/workflows/ci.yml', () => {
  it('is a byte-identical copy of the template and runs on main pushes and PRs', () => {
    const published = readFileSync(
      path.join(repoRoot, '.github/workflows/ci.yml'),
      'utf8',
    );

    // The template is the only editable source; the published copy must not drift.
    expect(published).toBe(workflow);
    expect(published).toContain(
      'on:\n  push:\n    branches: [main]\n  pull_request:\n',
    );
  });
});
