// Read and summarize a Vitest JSON report. Pure apart from the requested file
// read, so the fail-closed rules are unit-testable without running Vitest:
// a missing, empty, unparsable, or zero-test report is an error, never a pass.
import { readFileSync } from 'node:fs';

export const SLOWEST_LIMIT = 10;
const MAX_FAILURE_MESSAGE_LINES = 12;
const MAX_FAILURE_LINES = 80;

export class ResultsError extends Error {}

/** Read `file` and return its summary, or throw ResultsError. */
export function readResults(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    const reason = error && typeof error === 'object' && 'code' in error ? error.code : 'unreadable';
    throw new ResultsError(`no results at ${file} (${reason})`);
  }
  return summarize(parseReport(file, raw));
}

function parseReport(file, raw) {
  if (raw.trim() === '') throw new ResultsError(`empty results at ${file}`);
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new ResultsError(`unparsable results at ${file}`);
  }
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new ResultsError(`unparsable results at ${file}`);
  }
  return report;
}

/**
 * Turn a Vitest JSON report into counts plus the slowest cases and failures.
 * Vitest's `json` reporter follows the Jest shape:
 * `{ numTotalTests, numPassedTests, numFailedTests, success,
 *    testResults: [{ name, assertionResults: [{ fullName, status, duration,
 *    failureMessages }] }] }`.
 */
export function summarize(report) {
  const total = report.numTotalTests;
  if (!Number.isInteger(total) || total <= 0) {
    throw new ResultsError('the report contains no tests');
  }

  const passed = Number(report.numPassedTests ?? 0);
  const failed = Number(report.numFailedTests ?? 0);
  const slowest = [];
  const failures = [];

  const suites = Array.isArray(report.testResults) ? report.testResults : [];
  for (const suite of suites) {
    const file = typeof suite?.name === 'string' ? suite.name : '';
    const assertions = Array.isArray(suite?.assertionResults) ? suite.assertionResults : [];
    for (const assertion of assertions) {
      const entry = {
        file,
        fullName:
          typeof assertion?.fullName === 'string'
            ? assertion.fullName
            : String(assertion?.title ?? ''),
        duration: Number(assertion?.duration ?? 0),
      };
      slowest.push(entry);
      if (assertion?.status === 'failed') {
        failures.push({
          ...entry,
          messages: Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [],
        });
      }
    }
  }

  slowest.sort((left, right) => right.duration - left.duration);
  return {
    total,
    passed,
    failed,
    ok: report.success === true && failed === 0,
    slowest: slowest.slice(0, SLOWEST_LIMIT),
    failures,
  };
}

/** One readable line for a finished iteration. */
export function formatRunLine({ index, runs, summary, elapsedMs }) {
  const slowest = summary.slowest[0];
  const tail = slowest
    ? `  slowest ${(slowest.duration / 1000).toFixed(1)}s ${slowest.fullName}`
    : '';
  return (
    `run ${index}/${runs} ${summary.ok ? 'PASS' : 'FAIL'} ` +
    `${(elapsedMs / 1000).toFixed(1)}s  ` +
    `${summary.passed} passed, ${summary.failed} failed${tail}`
  );
}

/** The slowest cases, one line each, for the per-run detail block. */
export function formatSlowest(summary, limit = SLOWEST_LIMIT) {
  return summary.slowest
    .slice(0, limit)
    .map((item) => `  ${(item.duration / 1000).toFixed(1)}s ${item.fullName}`);
}

/** Failure detail lines, capped so one runaway message cannot flood the run. */
export function formatFailures(summary) {
  const lines = [];
  for (const failure of summary.failures) {
    if (lines.length >= MAX_FAILURE_LINES) break;
    lines.push(`  FAILED ${failure.fullName}`);
    for (const message of failure.messages) {
      const raw = String(message).split('\n').slice(0, MAX_FAILURE_MESSAGE_LINES);
      for (const line of raw) {
        if (lines.length >= MAX_FAILURE_LINES) break;
        lines.push(`    ${line}`);
      }
    }
  }
  if (summary.failures.length > 0 && lines.length >= MAX_FAILURE_LINES) {
    lines.push('    ...');
  }
  return lines;
}
