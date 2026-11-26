// Shared SIGINT/SIGTERM cleanup coordinator for the proof scripts.
//
// A signal handler cannot run `finally` blocks, and an interactive interrupt must
// not slice through an async cleanup. This coordinator installs both handlers,
// runs the same idempotent cleanup for the normal path and the first signal, and
// only exits after that cleanup settles. A second signal force-releases what is
// left and exits immediately.
const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });
const SIGNALS = Object.keys(SIGNAL_EXIT_CODES);

/**
 * @param {object} options
 * @param {() => Promise<void> | void} options.cleanup Idempotent async teardown.
 * @param {(signal: string) => void} [options.force] Synchronous second-signal release.
 * @param {(code: number) => void} [options.exit] Exit hook; defaults to process.exit.
 * @param {NodeJS.EventEmitter} [options.emitter] Signal source; defaults to process.
 * @param {(message: string) => void} [options.log] Error/log sink; defaults to console.error.
 */
export function createSignalCleanup({
  cleanup,
  force = () => {},
  exit = (code) => process.exit(code),
  emitter = process,
  log = (message) => console.error(message),
} = {}) {
  if (typeof cleanup !== 'function') {
    throw new TypeError('createSignalCleanup needs a cleanup function');
  }

  let cleanupPromise;
  let interrupted = false;
  let disposed = false;
  let exited = false;

  const finish = (code) => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  const run = () => {
    cleanupPromise ??= Promise.resolve().then(cleanup);
    return cleanupPromise;
  };

  const onSignal = (signal) => {
    if (disposed) return;
    const code = SIGNAL_EXIT_CODES[signal] ?? 1;

    if (interrupted) {
      try {
        force(signal);
      } catch (error) {
        log(`force cleanup failed: ${error instanceof Error ? error.message : error}`);
      }
      finish(code);
      return;
    }

    interrupted = true;
    log(`interrupted by ${signal}; cleaning up`);
    run()
      .catch((error) => {
        log(`cleanup failed: ${error instanceof Error ? error.message : error}`);
      })
      .finally(() => finish(code));
  };

  const handlers = new Map(SIGNALS.map((signal) => [signal, () => onSignal(signal)]));
  for (const [signal, handler] of handlers) emitter.on(signal, handler);

  return {
    run,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [signal, handler] of handlers) emitter.off(signal, handler);
    },
  };
}
