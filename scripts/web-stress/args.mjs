// Argument parsing for scripts/web-stress.mjs. Pure: no globals, no I/O.
//
// A usage error is a one-line message the entry prints before the usage block
// and exits 2, so a typo never looks like a failed suite iteration.

export const USAGE = `Usage: node scripts/web-stress.mjs [options]

Runs the web Vitest suite under competing CPU load. Fails closed on a failed
iteration, a hog that exited early, a per-iteration timeout, or a missing
Vitest JSON report.

Options:
  --runs <n>        suite iterations to run (default 3; minimum 1)
  --hogs <n>        busy-loop CPU processes kept alive (default 4; 0 = quiet baseline)
  --timeout <s>     wall-clock limit per iteration in seconds (default 600)
  --only <pattern>  Vitest file filter; repeatable, so not a full-suite proof
  --fail-fast       stop after the first failing iteration
  --verbose         stream each iteration's captured output live
  --log-dir <dir>   per-run results.json/output.log location
                    (default: a fresh aps-web-stress-* directory under the OS temp dir)
  --keep-logs       keep the log directory after an all-pass run
  --help, -h        print this usage`;

export const DEFAULTS = Object.freeze({
  runs: 3,
  hogs: 4,
  timeoutSeconds: 600,
  only: [],
  failFast: false,
  verbose: false,
  logDir: null,
  keepLogs: false,
  help: false,
});

export class UsageError extends Error {}

function integer(flag, raw, minimum) {
  const detail = minimum === 0 ? 'of at least 0' : `of at least ${minimum}`;
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`${flag} needs an integer ${detail}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new UsageError(`${flag} needs an integer ${detail}`);
  }
  return value;
}

function splitFlag(arg) {
  const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
  if (equals === -1) return { flag: arg, value: undefined };
  return { flag: arg.slice(0, equals), value: arg.slice(equals + 1) };
}

/**
 * Parse the CLI arguments. `--help` wins over every other argument so a user
 * asking for usage never sees a validation error instead.
 */
export function parseArgs(argv) {
  const options = { ...DEFAULTS, only: [] };
  if (argv.includes('--help') || argv.includes('-h')) {
    return { ...options, help: true };
  }

  for (let index = 0; index < argv.length; index += 1) {
    const { flag, value: inline } = splitFlag(argv[index]);

    const value = () => {
      if (inline !== undefined) {
        if (inline === '') throw new UsageError(`${flag} needs a value`);
        return inline;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`${flag} needs a value`);
      }
      index += 1;
      return next;
    };

    const noValue = () => {
      if (inline !== undefined) throw new UsageError(`${flag} does not take a value`);
    };

    switch (flag) {
      case '--runs':
        options.runs = integer(flag, value(), 1);
        break;
      case '--hogs':
        options.hogs = integer(flag, value(), 0);
        break;
      case '--timeout':
        options.timeoutSeconds = integer(flag, value(), 1);
        break;
      case '--only': {
        const pattern = value();
        options.only.push(pattern);
        break;
      }
      case '--log-dir':
        options.logDir = value();
        break;
      case '--fail-fast':
        noValue();
        options.failFast = true;
        break;
      case '--verbose':
        noValue();
        options.verbose = true;
        break;
      case '--keep-logs':
        noValue();
        options.keepLogs = true;
        break;
      default:
        throw new UsageError(
          flag.startsWith('-') ? `unknown argument: ${flag}` : `unexpected argument: ${flag}`,
        );
    }
  }

  return options;
}
