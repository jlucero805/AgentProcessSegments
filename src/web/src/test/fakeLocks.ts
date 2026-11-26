/**
 * Minimal in-memory `LockManager` for tests. jsdom has no `navigator.locks`, and
 * two `ClarifyChat` instances rendered in one test need to share one lock manager
 * to behave like two tabs. Requests are granted FIFO; a lock is released when the
 * callback's promise settles.
 */

type Grant = () => void;

interface FakeLockRequest {
  name: string;
  mode: KeyedMode;
}

type KeyedMode = 'exclusive' | 'shared';

class FakeLockManager {
  private held = new Set<string>();
  private waiting = new Map<string, Grant[]>();

  request<T>(
    name: string,
    optionsOrCallback: { mode?: KeyedMode } | (() => T | PromiseLike<T>),
    maybeCallback?: () => T | PromiseLike<T>,
  ): Promise<T> {
    const callback = (
      typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
    ) as () => T | PromiseLike<T>;
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.held.add(name);
        Promise.resolve()
          .then(() => callback())
          .then(
            (value) => {
              this.release(name);
              resolve(value);
            },
            (error: unknown) => {
              this.release(name);
              reject(error instanceof Error ? error : new Error(String(error)));
            },
          );
      };
      if (this.held.has(name)) {
        const queue = this.waiting.get(name) ?? [];
        queue.push(run);
        this.waiting.set(name, queue);
      } else {
        run();
      }
    });
  }

  query(): Promise<{ held: FakeLockRequest[]; pending: FakeLockRequest[] }> {
    return Promise.resolve({
      held: [...this.held].map((name) => ({ name, mode: 'exclusive' as const })),
      pending: [...this.waiting.keys()].map((name) => ({ name, mode: 'exclusive' as const })),
    });
  }

  snapshot(): Promise<{ held: FakeLockRequest[]; pending: FakeLockRequest[] }> {
    return this.query();
  }

  private release(name: string): void {
    this.held.delete(name);
    const next = this.waiting.get(name)?.shift();
    if (next) {
      next();
      return;
    }
    this.waiting.delete(name);
  }
}

let previousLocks: PropertyDescriptor | undefined;

export function installFakeLocks(): void {
  previousLocks = Object.getOwnPropertyDescriptor(window.navigator, 'locks');
  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    value: new FakeLockManager() as unknown as LockManager,
  });
}

export function uninstallFakeLocks(): void {
  if (previousLocks) Object.defineProperty(window.navigator, 'locks', previousLocks);
  else Reflect.deleteProperty(window.navigator, 'locks');
  previousLocks = undefined;
}
