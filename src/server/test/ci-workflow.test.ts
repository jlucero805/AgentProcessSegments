import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const workflowPath = path.join(repoRoot, 'deploy/ci-workflow.yml');

describe('deploy/ci-workflow.yml', () => {
  it('runs the web suite with an inherited NODE_ENV=production', () => {
    const workflow = readFileSync(workflowPath, 'utf8').replace(/\s+/g, ' ');

    expect(workflow).toContain('name: Web tests with inherited NODE_ENV=production');
    expect(workflow).toContain('run: NODE_ENV=production npm test --workspace src/web');
  });
});
