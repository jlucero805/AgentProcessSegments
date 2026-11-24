/**
 * Runtime environment names.
 *
 * `APS_*` is canonical. `SBOX_*` is the legacy prefix from before the rename and
 * remains readable for at least one release, so an existing unit or shell profile
 * keeps working. The canonical prefix wins whenever it is defined, including an
 * empty string; `APS_DEFAULT_MODEL=''` deliberately means "use the CLI default".
 */
export function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const current = env[`APS_${name}`];
  if (current !== undefined) return current;
  return env[`SBOX_${name}`];
}

/**
 * Reads one exact env name, skipping blank values. For path settings an empty
 * string can only be a mistake. Values are returned verbatim, never trimmed.
 */
export function readNonBlankEnv(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = env[key];
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/**
 * Like `readEnv`, but skips blank values. Only for path settings: a blank APS
 * value must not shadow a usable SBOX alias. Values are returned verbatim,
 * never trimmed.
 */
export function readNonEmptyEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  return (
    readNonBlankEnv(env, `APS_${name}`) ?? readNonBlankEnv(env, `SBOX_${name}`)
  );
}

const LEGACY_ENV_PREFIX = 'SBOX_';

/**
 * Names of the legacy variables still present in `env`, sorted for a stable
 * startup message. Values are never read, so a path or token cannot leak into
 * the warning; an empty-string value still counts as present because `readEnv`
 * honors it the same way as a non-empty one.
 */
export function legacyEnvNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((key) => key.startsWith(LEGACY_ENV_PREFIX) && env[key] !== undefined)
    .sort();
}

/** One startup warning for legacy names, or `null` when there is nothing to report. */
export function legacyEnvWarning(names: string[]): string | null {
  if (names.length === 0) return null;
  return (
    `legacy SBOX_* environment names are set: ${names.join(', ')}. ` +
    'Rename them to APS_*; APS_* wins when both are set. ' +
    '`npm run migrate:paths` moves only the legacy default paths.'
  );
}
