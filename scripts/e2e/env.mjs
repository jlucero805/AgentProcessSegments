// Environment for the repo's proof scripts (E2E, MCP smoke, Claude mock smoke,
// screenshots).
//
// Each proof must behave the same on a clean shell and on a host that exports
// harness overrides, so inherited APS_* / SBOX_* settings are dropped and the
// pins decide everything. ANTHROPIC_*, CLAUDE_*, and OPENAI_* are dropped too:
// if a future edit ever resolves the real CLI, the run should fail on missing
// auth instead of calling a paid API.
//
// Scripts that deliberately prove the legacy SBOX_* aliases keep SBOX_* pins;
// scrubbing the inherited APS_* names first is what makes those pins the only
// source. Pin XDG_CONFIG_HOME/XDG_STATE_HOME too when a child resolves paths
// outside the APS_* names: loadConfig() reads XDG_* directly.
import path from 'node:path';

export const SCRUB_PREFIXES = Object.freeze([
  'APS_',
  'SBOX_',
  'ANTHROPIC_',
  'CLAUDE_',
  'OPENAI_',
]);

/**
 * Copy the ordinary host environment and drop harness settings and
 * credentials. Pure: no globals, no side effects. Empty strings are dropped
 * because a host may export `APS_HARNESS=''` (which readEnv honors as present).
 */
export function scrubEnv(hostEnv) {
  const env = {};
  for (const [name, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    if (SCRUB_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    env[name] = value;
  }
  return env;
}

/**
 * Apply pins over the scrubbed host env so a pin always wins, including when
 * the host exported the same name with an empty value.
 */
export function buildPinnedEnv(hostEnv, pins) {
  return { ...scrubEnv(hostEnv), ...pins };
}

/** The E2E entrypoint's name for the shared builder. */
export const buildE2eEnv = buildPinnedEnv;

/**
 * Choose the Claude binary for the mock smoke from script-scoped inputs only.
 *
 * Inherited `APS_*` / `SBOX_*` settings must never choose the binary under test, so
 * this deliberately ignores `APS_CLAUDE_BIN`/`SBOX_CLAUDE_BIN`. Precedence:
 * `--claude-bin <path>` / `--claude-bin=<path>`, then `CLAUDE_MOCK_SMOKE_BIN`,
 * then `claude` on `PATH`. An explicit value must be an absolute executable
 * file; a bad value throws instead of silently falling back. A PATH miss
 * returns null so the caller keeps the documented skip.
 *
 * `isExecutable` is injected so tests do not touch the filesystem. `isClaude` is
 * the optional identity check (the smoke passes a `--version` probe): a wrong
 * explicit value throws, while a wrong PATH candidate is skipped so the scan
 * continues. Without it the resolver only checks the file, matching the older
 * behavior.
 */
export function resolveClaudeBin({ argv = [], env = {}, isExecutable, isClaude } = {}) {
  if (typeof isExecutable !== 'function') {
    throw new TypeError('resolveClaudeBin: isExecutable must be a function');
  }

  let flagValue;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--claude-bin') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new TypeError('resolveClaudeBin: --claude-bin requires a path');
      }
      flagValue = value;
      break;
    }
    if (arg.startsWith('--claude-bin=')) {
      flagValue = arg.slice('--claude-bin='.length);
      break;
    }
  }

  for (const [source, value] of [
    ['--claude-bin', flagValue],
    ['CLAUDE_MOCK_SMOKE_BIN', env.CLAUDE_MOCK_SMOKE_BIN],
  ]) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TypeError(`resolveClaudeBin: ${source} must be a non-empty path`);
    }
    if (!path.isAbsolute(value)) {
      throw new TypeError(`resolveClaudeBin: ${source} must be an absolute path: ${value}`);
    }
    if (!isExecutable(value)) {
      throw new TypeError(`resolveClaudeBin: ${source} is not an executable file: ${value}`);
    }
    if (typeof isClaude === 'function' && !identifiesAsClaude(isClaude, value)) {
      throw new TypeError(`resolveClaudeBin: ${source} did not identify as Claude Code: ${value}`);
    }
    return value;
  }

  const pathValue = typeof env.PATH === 'string' ? env.PATH : '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.resolve(dir, 'claude');
    if (!isExecutable(candidate)) continue;
    if (typeof isClaude === 'function' && !identifiesAsClaude(isClaude, candidate)) continue;
    return candidate;
  }
  return null;
}

/** Run the identity check, treating a throwing probe as "not Claude Code". */
function identifiesAsClaude(isClaude, candidate) {
  try {
    return isClaude(candidate) === true;
  } catch {
    return false;
  }
}

function requireString(name, value, builder = 'buildE2ePins') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${builder}: ${name} must be a non-empty string`);
  }
}

function requireAbsolutePath(name, value, builder = 'buildE2ePins') {
  requireString(name, value, builder);
  if (!path.isAbsolute(value)) {
    throw new TypeError(`${builder}: ${name} must be an absolute path`);
  }
}

function requirePort(value, builder = 'buildE2ePins') {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TypeError(`${builder}: port must be an integer between 1 and 65535`);
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

/**
 * Pins for the Claude mock smoke's brain. The run deliberately uses the legacy
 * SBOX_* names, so the scrub must remove inherited APS_* names or readEnv would
 * prefer them. The config/process/error-log paths are explicit because
 * loadConfig() reads XDG_CONFIG_HOME/XDG_STATE_HOME directly.
 */
export function buildClaudeSmokePins({
  root,
  claude,
  home,
  temp,
  dbPath,
  dataDir,
  port,
  mockUrl,
}) {
  const builder = 'buildClaudeSmokePins';
  requireAbsolutePath('root', root, builder);
  // resolveClaudeBin() returns an absolute path from the flag/env/PATH resolver.
  requireString('claude', claude, builder);
  requireAbsolutePath('home', home, builder);
  requireAbsolutePath('temp', temp, builder);
  requireAbsolutePath('dbPath', dbPath, builder);
  requireAbsolutePath('dataDir', dataDir, builder);
  requireString('mockUrl', mockUrl, builder);
  requirePort(port, builder);

  return {
    HOME: home,
    NODE_ENV: 'production',
    SBOX_HARNESS: 'claude',
    SBOX_HARNESS_BIN: claude,
    SBOX_CLAUDE_BIN: claude,
    SBOX_PORT: String(port),
    SBOX_DB: dbPath,
    SBOX_DATA_DIR: dataDir,
    SBOX_CONFIG: path.join(temp, 'config.json'),
    SBOX_PROCESS: path.join(temp, 'process.json'),
    SBOX_ERROR_LOG: path.join(temp, 'errors.log'),
    SBOX_WEB_DIR: path.join(root, 'src', 'web', 'dist'),
    SBOX_DOCS_DIR: path.join(root, 'docs'),
    SBOX_TERMINAL: '0',
    XDG_CONFIG_HOME: path.join(temp, 'xdg-config'),
    XDG_STATE_HOME: path.join(temp, 'xdg-state'),
    ANTHROPIC_BASE_URL: mockUrl,
    ANTHROPIC_API_KEY: 'test-key',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_AUTOUPDATE: '1',
  };
}

/**
 * Pins for the MCP smoke's brain: a temp DB/data/config plus temp XDG and
 * opencode config dirs under `work`, no real agent CLI, and the loopback host.
 */
export function buildMcpSmokePins({ root, work, home, port }) {
  const builder = 'buildMcpSmokePins';
  requireAbsolutePath('root', root, builder);
  requireAbsolutePath('work', work, builder);
  requireAbsolutePath('home', home, builder);
  requirePort(port, builder);

  return {
    HOME: home,
    NODE_ENV: 'production',
    APS_HOST: '127.0.0.1',
    APS_PORT: String(port),
    APS_DB: path.join(work, 'harness.sqlite'),
    APS_DATA_DIR: path.join(work, 'data'),
    APS_CONFIG: path.join(work, 'config.json'),
    APS_PROCESS: path.join(work, 'process.json'),
    APS_ERROR_LOG: path.join(work, 'errors.log'),
    APS_WEB_DIR: path.join(root, 'src', 'web', 'dist'),
    APS_DOCS_DIR: path.join(root, 'docs'),
    APS_PLUGINS_DIR: path.join(work, 'plugins'),
    APS_HARNESS: 'claude',
    APS_HARNESS_BIN: '/bin/false',
    APS_CLAUDE_BIN: '/bin/false',
    APS_OPENCODE_BIN: '/bin/false',
    APS_TERMINAL: '0',
    XDG_CONFIG_HOME: path.join(work, 'xdg-config'),
    XDG_STATE_HOME: path.join(work, 'xdg-state'),
    OPENCODE_CONFIG_DIR: path.join(work, 'xdg-config', 'opencode'),
  };
}

/**
 * Pins for the MCP smoke's stdio client. Deliberately legacy SBOX_* names:
 * scrubbing inherited APS_* names is what proves the alias path.
 */
export function buildMcpSmokeClientPins({ home, base, requestId }) {
  const builder = 'buildMcpSmokeClientPins';
  requireAbsolutePath('home', home, builder);
  requireString('base', base, builder);
  requireString('requestId', requestId, builder);

  return {
    HOME: home,
    NODE_ENV: 'production',
    SBOX_BRAIN_URL: base,
    SBOX_REQUEST_ID: requestId,
  };
}

/**
 * Pins for the screenshots capture browser. The SPA renders the master drawer's
 * clock text with the browser locale and timezone, so an inherited
 * LANG/LC_ALL/TZ would change the committed images. `buildPinnedEnv` also keeps
 * inherited harness settings and credentials out of Chromium.
 */
export const SCREENSHOT_BROWSER_PINS = Object.freeze({
  TZ: 'UTC',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
});

/**
 * Pins for the screenshots server: the staged temp board, no agent CLI, and
 * temp XDG dirs so the run cannot read the host's config or state.
 */
export function buildScreenshotPins({
  root,
  temp,
  dbPath,
  dataDir,
  configPath,
  processPath,
  errorLogPath,
  xdgConfig,
  xdgState,
  port,
}) {
  const builder = 'buildScreenshotPins';
  requireAbsolutePath('root', root, builder);
  requireAbsolutePath('temp', temp, builder);
  requireAbsolutePath('dbPath', dbPath, builder);
  requireAbsolutePath('dataDir', dataDir, builder);
  requireAbsolutePath('configPath', configPath, builder);
  requireAbsolutePath('processPath', processPath, builder);
  requireAbsolutePath('errorLogPath', errorLogPath, builder);
  requireAbsolutePath('xdgConfig', xdgConfig, builder);
  requireAbsolutePath('xdgState', xdgState, builder);
  requirePort(port, builder);

  return {
    HOME: path.join(temp, 'home'),
    NODE_ENV: 'production',
    APS_HOST: '127.0.0.1',
    APS_PORT: String(port),
    APS_DB: dbPath,
    APS_DATA_DIR: dataDir,
    APS_CONFIG: configPath,
    APS_PROCESS: processPath,
    APS_ERROR_LOG: errorLogPath,
    APS_WEB_DIR: path.join(root, 'src', 'web', 'dist'),
    APS_DOCS_DIR: path.join(root, 'docs'),
    APS_HARNESS: 'claude',
    APS_CLAUDE_BIN: '/bin/false',
    APS_OPENCODE_BIN: '/bin/false',
    APS_TERMINAL_CWD: root,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_STATE_HOME: xdgState,
  };
}
