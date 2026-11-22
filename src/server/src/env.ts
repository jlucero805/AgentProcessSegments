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
