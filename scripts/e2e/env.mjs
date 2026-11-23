// Environment for the E2E brain child process.
//
// The suite must behave the same on a clean shell and on a host that exports
// harness overrides, so inherited APS_* / SBOX_* settings are dropped and the
// pins decide everything. ANTHROPIC_*, CLAUDE_*, and OPENAI_* are dropped too:
// if a future edit ever resolves the real CLI, the run should fail on missing
// auth instead of calling a paid API.
import path from 'node:path';

export const SCRUB_PREFIXES = Object.freeze([
  'APS_',
  'SBOX_',
  'ANTHROPIC_',
  'CLAUDE_',
  'OPENAI_',
]);

/**
 * Copy the ordinary host environment, drop harness settings and credentials,
 * then apply the pins so they always win. Pure: no globals, no side effects.
 */
export function buildE2eEnv(hostEnv, pins) {
  const env = {};
  for (const [name, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    if (SCRUB_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    env[name] = value;
  }
  return { ...env, ...pins };
}

function requireString(name, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`buildE2ePins: ${name} must be a non-empty string`);
  }
}

function requireAbsolutePath(name, value) {
  requireString(name, value);
  if (!path.isAbsolute(value)) {
    throw new TypeError(`buildE2ePins: ${name} must be an absolute path`);
  }
}

function requirePort(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TypeError('buildE2ePins: port must be an integer between 1 and 65535');
  }
}

/**
 * The pins the E2E brain always gets: a throwaway HOME and database, the repo's
 * docs, a temp plugins dir, and the mock Claude binary. Exported so the unit
 * guard exercises the same set the suite spawns with instead of a copy that can
 * drift. Pure: every path comes from the caller, and every argument is checked
 * so a dropped pin fails here instead of falling back to a real CLI on PATH.
 */
export function buildE2ePins({
  root,
  mock,
  home,
  temp,
  dbPath,
  port,
  base,
  pluginsDir,
}) {
  requireAbsolutePath('root', root);
  requireAbsolutePath('mock', mock);
  requireAbsolutePath('home', home);
  requireAbsolutePath('temp', temp);
  requireAbsolutePath('dbPath', dbPath);
  requireAbsolutePath('pluginsDir', pluginsDir);
  requireString('base', base);
  requirePort(port);

  return {
    HOME: home,
    NODE_ENV: 'production',
    APS_HOST: '127.0.0.1',
    APS_PORT: String(port),
    APS_DB: dbPath,
    APS_DATA_DIR: path.join(temp, 'data'),
    APS_CONFIG: path.join(temp, 'config.json'),
    APS_PROCESS: path.join(temp, 'process.json'),
    APS_ERROR_LOG: path.join(temp, 'errors.log'),
    APS_WEB_DIR: path.join(temp, 'no-web-build'),
    APS_DOCS_DIR: path.join(root, 'docs'),
    APS_PLUGINS_DIR: pluginsDir,
    APS_BRAIN_URL: base,
    APS_HARNESS: 'claude',
    APS_HARNESS_BIN: mock,
    APS_CLAUDE_BIN: mock,
    APS_TERMINAL: '0',
  };
}
