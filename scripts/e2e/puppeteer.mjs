// Browser-free Puppeteer policy for the proof scripts.
//
// scripts/screenshots.mjs rewrites committed images and scripts/ui-smoke.mjs is
// the real-browser SPA check, so a run without Puppeteer must fail instead of
// reporting success. Keeping the decision here lets
// scripts/e2e/puppeteer.test.mjs prove every branch without a browser, a network
// call, or a real `node_modules` install.
import { statSync } from 'node:fs';

export const ALLOW_MISSING_PUPPETEER = '--allow-missing-puppeteer';

const SCREENSHOTS_PROFILE = {
  name: 'screenshots',
  usage: 'usage: node scripts/screenshots.mjs [--allow-missing-puppeteer]',
  missingHeadline:
    'screenshots: puppeteer is not installed, so the screenshots were NOT refreshed:',
  skipHeadline: 'screenshots: SKIPPED - puppeteer is not installed, so nothing was captured.',
  skipAction: 'the capture',
  skipTail: ['  the committed images stay stale until the capture runs with puppeteer installed.'],
  listOutputs: true,
};

const UI_SMOKE_PROFILE = {
  name: 'ui smoke',
  usage: 'usage: node scripts/ui-smoke.mjs [--allow-missing-puppeteer]',
  missingHeadline: 'ui smoke: puppeteer is not installed, so the UI smoke did NOT run.',
  skipHeadline: 'ui smoke: SKIPPED - puppeteer is not installed, so nothing was run.',
  skipAction: 'the smoke',
  skipTail: ['  no browser was launched and no UI checks ran; this skip is not a pass.'],
  listOutputs: false,
};

function usageError(profile, line) {
  return { ok: false, exitCode: 1, lines: [`${profile.name}: ${line}; ${profile.usage}`] };
}

/**
 * Accept no arguments or exactly one --allow-missing-puppeteer. Anything else is
 * a typo, which must fail loudly rather than degrade into a skipped run.
 */
function parseGuardArgs(argv, profile) {
  if (argv.length === 0) return { ok: true, allowMissing: false };
  if (argv.length === 1 && argv[0] === ALLOW_MISSING_PUPPETEER) {
    return { ok: true, allowMissing: true };
  }
  const unknown = argv.find((arg) => arg !== ALLOW_MISSING_PUPPETEER);
  if (unknown !== undefined) return usageError(profile, `unknown argument "${unknown}"`);
  return usageError(profile, `${ALLOW_MISSING_PUPPETEER} given more than once`);
}

export function parseScreenshotArgs(argv) {
  return parseGuardArgs(argv, SCREENSHOTS_PROFILE);
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
 * with it the run is skipped, but the current outputs are printed so a stale
 * result cannot be mistaken for a fresh one.
 */
function describeMissing({ profile, allowMissing, outputs = [], stat = statSync }) {
  if (!allowMissing) {
    return {
      ok: false,
      exitCode: 1,
      lines: [
        profile.missingHeadline,
        ...(profile.listOutputs
          ? outputs.map(({ label }) => `  ${label}: not refreshed`)
          : []),
        '  install it (optional dev tool, not a project dependency):',
        '    npm install --no-save puppeteer',
        '    npx puppeteer browsers install chrome',
        `  to skip ${profile.skipAction} on purpose, rerun with ${ALLOW_MISSING_PUPPETEER}`,
      ],
    };
  }
  return {
    ok: false,
    exitCode: 0,
    lines: [
      profile.skipHeadline,
      ...(profile.listOutputs ? outputs.map((output) => describeOutput(output, stat)) : []),
      ...profile.skipTail,
    ],
  };
}

export function describeMissingPuppeteer({ allowMissing, outputs, stat = statSync }) {
  return describeMissing({
    profile: SCREENSHOTS_PROFILE,
    allowMissing,
    outputs,
    stat,
  });
}

function describeBrokenPuppeteer(profile, error) {
  return {
    ok: false,
    exitCode: 1,
    lines: [
      `${profile.name}: puppeteer is installed but failed to load: ${error?.message ?? error}`,
      '  fix or reinstall it:',
      '    npm install --no-save puppeteer',
      '    npx puppeteer browsers install chrome',
    ],
  };
}

/**
 * Parse args, then load Puppeteer, then decide: run, skip loudly, or fail.
 * Returns { ok: true, puppeteer } or { ok: false, exitCode, lines }.
 */
export async function resolvePuppeteer({
  argv,
  outputs = [],
  load,
  stat = statSync,
  profile = SCREENSHOTS_PROFILE,
}) {
  const parsed = parseGuardArgs(argv, profile);
  if (!parsed.ok) return parsed;

  const loaded = await classifyPuppeteerLoad(load);
  if (loaded.ok) return { ok: true, puppeteer: loaded.puppeteer };
  if (!loaded.missing) return describeBrokenPuppeteer(profile, loaded.error);
  return describeMissing({ profile, allowMissing: parsed.allowMissing, outputs, stat });
}

export async function resolveUiSmokePuppeteer({ argv, load }) {
  return resolvePuppeteer({ argv, outputs: [], load, profile: UI_SMOKE_PROFILE });
}
