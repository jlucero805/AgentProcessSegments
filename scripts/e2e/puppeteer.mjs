// Browser-free Puppeteer policy for the proof scripts.
//
// scripts/screenshots.mjs rewrites committed images, so a run without Puppeteer
// must fail instead of reporting success. Keeping the decision here lets
// scripts/e2e/puppeteer.test.mjs prove every branch without a browser, a network
// call, or a real `node_modules` install.
import { statSync } from 'node:fs';

export const ALLOW_MISSING_PUPPETEER = '--allow-missing-puppeteer';

const USAGE = 'usage: node scripts/screenshots.mjs [--allow-missing-puppeteer]';

function usageError(line) {
  return { ok: false, exitCode: 1, lines: [`screenshots: ${line}; ${USAGE}`] };
}

/**
 * Accept no arguments or exactly one --allow-missing-puppeteer. Anything else is
 * a typo, which must fail loudly rather than degrade into a skipped capture.
 */
export function parseScreenshotArgs(argv) {
  if (argv.length === 0) return { ok: true, allowMissing: false };
  if (argv.length === 1 && argv[0] === ALLOW_MISSING_PUPPETEER) {
    return { ok: true, allowMissing: true };
  }
  const unknown = argv.find((arg) => arg !== ALLOW_MISSING_PUPPETEER);
  if (unknown !== undefined) return usageError(`unknown argument "${unknown}"`);
  return usageError(`${ALLOW_MISSING_PUPPETEER} given more than once`);
}

/**
 * A missing transitive dependency inside an installed Puppeteer raises the same
 * ERR_MODULE_NOT_FOUND code, so the message must name the package itself.
 */
function isMissingPuppeteer(error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') return false;
  return /Cannot find (package|module) 'puppeteer'/.test(error?.message ?? '');
}

export async function classifyPuppeteerLoad(load = () => import('puppeteer')) {
  try {
    const loaded = await load();
    return { ok: true, puppeteer: loaded?.default ?? loaded };
  } catch (error) {
    return { ok: false, missing: isMissingPuppeteer(error), error };
  }
}

function describeOutput({ label, file }, stat) {
  try {
    return `  ${label}: unchanged since ${new Date(stat(file).mtimeMs).toISOString()}`;
  } catch {
    return `  ${label}: not present`;
  }
}

/**
 * Explain a missing Puppeteer. Without the opt-out flag this fails the run;
 * with it the capture is skipped, but the current image mtimes are printed so a
 * stale image cannot be mistaken for a refresh.
 */
export function describeMissingPuppeteer({ allowMissing, outputs, stat = statSync }) {
  if (!allowMissing) {
    return {
      ok: false,
      exitCode: 1,
      lines: [
        'screenshots: puppeteer is not installed, so the screenshots were NOT refreshed:',
        ...outputs.map(({ label }) => `  ${label}: not refreshed`),
        '  install it (optional dev tool, not a project dependency):',
        '    npm install --no-save puppeteer',
        '    npx puppeteer browsers install chrome',
        `  to skip the capture on purpose, rerun with ${ALLOW_MISSING_PUPPETEER}`,
      ],
    };
  }
  return {
    ok: false,
    exitCode: 0,
    lines: [
      'screenshots: SKIPPED - puppeteer is not installed, so nothing was captured.',
      ...outputs.map((output) => describeOutput(output, stat)),
      '  the committed images stay stale until the capture runs with puppeteer installed.',
    ],
  };
}

function describeBrokenPuppeteer(error) {
  return {
    ok: false,
    exitCode: 1,
    lines: [
      `screenshots: puppeteer is installed but failed to load: ${error?.message ?? error}`,
      '  fix or reinstall it:',
      '    npm install --no-save puppeteer',
      '    npx puppeteer browsers install chrome',
    ],
  };
}

/**
 * Parse args, then load Puppeteer, then decide: capture, skip loudly, or fail.
 * Returns { ok: true, puppeteer } or { ok: false, exitCode, lines }.
 */
export async function resolvePuppeteer({ argv, outputs, load, stat = statSync }) {
  const parsed = parseScreenshotArgs(argv);
  if (!parsed.ok) return parsed;

  const loaded = await classifyPuppeteerLoad(load);
  if (loaded.ok) return { ok: true, puppeteer: loaded.puppeteer };
  if (!loaded.missing) return describeBrokenPuppeteer(loaded.error);
  return describeMissingPuppeteer({ allowMissing: parsed.allowMissing, outputs, stat });
}
