import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { walkFiles } from '../src/util/files.js';

// Fixed wall-clock sleeps make the server suite flake under parallel load: they pass on
// an idle laptop and fail when a full run gives the event loop less time. This guard is a
// static speed bump, not a linter. A server test may wait only on an observable condition,
// `vi.waitFor`, fake timers, or a `setImmediate` drain. The sole exception is a bounded
// fail-fast guard that rejects or throws when a child never reaches the expected state;
// every such call must be listed in ALLOWED_TIMERS with a reason. Do not weaken this test
// without updating the matching invariant in AGENTS.md.

const repo = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const testDir = path.join(repo, 'src/server/test');

interface AllowedTimer {
  /** Test file path relative to `src/server/test`. */
  file: string;
  /** Whitespace-normalized source of the first `setTimeout` argument. */
  snippet: string;
  /** Why this timer is a bounded fail-fast guard rather than synchronization. */
  reason: string;
}

const ALLOWED_TIMERS: readonly AllowedTimer[] = [
  {
    file: 'harness.test.ts',
    snippet: "() => reject(new Error('timed out waiting for the stdin failure'))",
    reason: 'Bounded fail-fast guard for the EPIPE stdin test; cleared when the line arrives.',
  },
  {
    file: 'harness.test.ts',
    snippet: "() => reject(new Error('timed out waiting for the echoed message'))",
    reason: 'Bounded fail-fast guard for the echoed-message test; cleared when the line arrives.',
  },
  {
    file: 'migrate-paths.test.ts',
    snippet: "() => { reject(new Error('holder process did not become ready')); }",
    reason:
      "Bounded fail-fast guard while waiting for the holder process's ready line; unref'd and cleared.",
  },
];

interface Violation {
  file: string;
  /** 1-based line, or 0 for an allowlist problem that has no single call. */
  line: number;
  detail: string;
}

interface ScanResult {
  violations: Violation[];
  used: AllowedTimer[];
  unused: AllowedTimer[];
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Find one source's wall-clock waits and match them against its allowlist entries. */
function findWallClockWaits(
  file: string,
  source: string,
  allowlist: readonly AllowedTimer[] = ALLOWED_TIMERS,
): ScanResult {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: Violation[] = [];
  const timers: Array<{ line: number; snippet: string; delay: string }> = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (specifier === 'node:timers/promises' || specifier === 'timers/promises') {
        violations.push({
          file,
          line: lineOf(sourceFile, node),
          detail: `import from ${specifier}`,
        });
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'setTimeout'
    ) {
      const callback = node.arguments[0];
      const delay = node.arguments[1];
      timers.push({
        line: lineOf(sourceFile, node),
        snippet: callback === undefined ? '' : normalize(callback.getText(sourceFile)),
        delay: delay === undefined ? '(no delay)' : normalize(delay.getText(sourceFile)),
      });
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const fileEntries = allowlist.filter((entry) => entry.file === file);
  const usedCount = new Map<AllowedTimer, number>();

  for (const timer of timers) {
    const matches = fileEntries.filter((entry) => entry.snippet === timer.snippet);
    if (matches.length === 0) {
      violations.push({
        file,
        line: timer.line,
        detail: `setTimeout(${timer.snippet}), ${timer.delay}`,
      });
      continue;
    }
    if (matches.length > 1) {
      violations.push({
        file,
        line: timer.line,
        detail: `ambiguous allowlist entry for setTimeout(${timer.snippet})`,
      });
      continue;
    }
    const entry = matches[0];
    if (entry !== undefined) usedCount.set(entry, (usedCount.get(entry) ?? 0) + 1);
  }

  for (const entry of fileEntries) {
    const count = usedCount.get(entry) ?? 0;
    if (count > 1) {
      violations.push({
        file,
        line: 0,
        detail: `allowlist entry matched ${count} setTimeout calls: ${entry.snippet}`,
      });
    }
  }

  return {
    violations,
    used: fileEntries.filter((entry) => (usedCount.get(entry) ?? 0) > 0),
    unused: fileEntries.filter((entry) => (usedCount.get(entry) ?? 0) === 0),
  };
}

function formatViolation(violation: Violation): string {
  const location = violation.line > 0 ? `${violation.file}:${violation.line}` : violation.file;
  return `src/server/test/${location}  ${violation.detail}`;
}

/** Scan the real server test tree, including helper files, for wall-clock waits. */
function scanTestTree(allowlist: readonly AllowedTimer[] = ALLOWED_TIMERS): ScanResult {
  const files = walkFiles(testDir)
    .filter((file) => file.endsWith('.ts'))
    .sort();
  const violations: Violation[] = [];
  const used: AllowedTimer[] = [];
  const unused: AllowedTimer[] = [];

  for (const file of files) {
    const source = readFileSync(path.join(testDir, file), 'utf8');
    const result = findWallClockWaits(file, source, allowlist);
    violations.push(...result.violations);
    used.push(...result.used);
    unused.push(...result.unused);
  }

  // An allowlist entry whose file disappeared is stale too, even though no scan saw it.
  const usedEntries = new Set(used);
  for (const entry of allowlist) {
    if (!usedEntries.has(entry) && !unused.includes(entry)) unused.push(entry);
  }

  return { violations, used, unused };
}

describe('server test wall-clock guard', () => {
  it('flags setTimeout waits regardless of resolver name or callback shape', () => {
    const source = [
      'await new Promise((r) => setTimeout(r, 20));',
      'await new Promise((resolve) => setTimeout(resolve, 40));',
      'setTimeout(() => resolve(), 75);',
      'setTimeout(() => { resolve(); }, 10);',
      'setTimeout(fn, 10);',
    ].join('\n');

    const result = findWallClockWaits('example.test.ts', source, []);

    expect(result.violations.map((violation) => violation.line)).toEqual([1, 2, 3, 4, 5]);
    expect(result.violations.map((violation) => violation.detail)).toEqual([
      'setTimeout(r), 20',
      'setTimeout(resolve), 40',
      'setTimeout(() => resolve()), 75',
      'setTimeout(() => { resolve(); }), 10',
      'setTimeout(fn), 10',
    ]);
  });

  it('flags node:timers/promises and alias imports', () => {
    const source = [
      "import { setTimeout as sleep } from 'node:timers/promises';",
      "import timers from 'timers/promises';",
    ].join('\n');

    const result = findWallClockWaits('example.test.ts', source, []);

    expect(result.violations.map((violation) => violation.detail)).toEqual([
      'import from node:timers/promises',
      'import from timers/promises',
    ]);
    expect(result.violations.map((violation) => violation.line)).toEqual([1, 2]);
  });

  it('passes the exact bounded guards in the allowlist', () => {
    for (const entry of ALLOWED_TIMERS) {
      const source = [
        'new Promise((resolve, reject) => {',
        `  setTimeout(${entry.snippet}, 1_000);`,
        '});',
      ].join('\n');

      const result = findWallClockWaits(entry.file, source, [entry]);

      expect(result.violations, entry.reason).toEqual([]);
      expect(result.used).toEqual([entry]);
      expect(result.unused).toEqual([]);
    }
  });

  it('reports a stale allowlist entry when the callback text changes', () => {
    const entry: AllowedTimer = {
      file: 'example.test.ts',
      snippet: '() => resolve()',
      reason: 'test entry',
    };

    const result = findWallClockWaits(
      entry.file,
      'setTimeout(() => resolve(1), 10);',
      [entry],
    );

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.detail).toBe('setTimeout(() => resolve(1)), 10');
    expect(result.unused).toEqual([entry]);
  });

  it('reports duplicate allowlist entries and duplicate matches', () => {
    const entry: AllowedTimer = {
      file: 'example.test.ts',
      snippet: '() => resolve()',
      reason: 'first entry',
    };
    const duplicate = { ...entry, reason: 'second entry' };

    const ambiguous = findWallClockWaits(
      entry.file,
      'setTimeout(() => resolve(), 10);',
      [entry, duplicate],
    );
    expect(ambiguous.violations.map((violation) => violation.detail)).toEqual([
      'ambiguous allowlist entry for setTimeout(() => resolve())',
    ]);

    const repeated = findWallClockWaits(
      entry.file,
      ['setTimeout(() => resolve(), 10);', 'setTimeout(() => resolve(), 20);'].join('\n'),
      [entry],
    );
    expect(repeated.violations.map((violation) => violation.detail)).toEqual([
      'allowlist entry matched 2 setTimeout calls: () => resolve()',
    ]);
  });

  it('allows deterministic drains, fake-timer advances, and vi.waitFor', () => {
    const source = [
      'await new Promise((resolve) => setImmediate(resolve));',
      'await vi.advanceTimersByTimeAsync(100);',
      'vi.advanceTimersByTime(100);',
      'vi.runAllTimers();',
      'await vi.waitFor(() => expect(value).toBe(true));',
    ].join('\n');

    expect(findWallClockWaits('example.test.ts', source, []).violations).toEqual([]);
  });

  it('ignores timer text inside strings, template literals, and comments', () => {
    const source = [
      "const single = 'setTimeout(resolve, 10)';",
      'const template = `setTimeout(resolve, 20)`;',
      '// setTimeout(resolve, 30)',
      '/* setTimeout(resolve, 40) */',
    ].join('\n');

    expect(findWallClockWaits('example.test.ts', source, []).violations).toEqual([]);
  });

  it('reports the 1-based line of a multi-line call', () => {
    const source = [
      'const promise = new Promise((resolve) => {',
      '  setTimeout(',
      '    () => resolve(),',
      '    50,',
      '  );',
      '});',
    ].join('\n');

    const result = findWallClockWaits('example.test.ts', source, []);
    const violation = result.violations[0];

    expect(violation?.line).toBe(2);
    expect(violation && formatViolation(violation)).toBe(
      'src/server/test/example.test.ts:2  setTimeout(() => resolve()), 50',
    );
  });

  it('finds only the allowlisted guarded waits in the real server test tree', () => {
    const result = scanTestTree();

    expect(
      result.violations.map(formatViolation),
      [
        'Fixed wall-clock sleeps are not allowed in server tests.',
        'Wait on an observable condition, vi.waitFor, fake timers, or settle();',
        'or add a { file, snippet, reason } entry to ALLOWED_TIMERS when this is a',
        'bounded fail-fast guard.',
      ].join('\n'),
    ).toEqual([]);
    expect(result.unused).toEqual([]);
    expect(result.used).toHaveLength(ALLOWED_TIMERS.length);
  });
});
