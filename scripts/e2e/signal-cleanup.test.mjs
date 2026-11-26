import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createSignalCleanup } from './signal-cleanup.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createHarness({ cleanup, force } = {}) {
  const emitter = new EventEmitter();
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const calls = { cleanup: 0, force: 0, forceSignals: [], exit: [], logs: [] };

  const controller = createSignalCleanup({
    cleanup: async () => {
      calls.cleanup += 1;
      if (cleanup) await cleanup();
    },
    force: (signal) => {
      calls.force += 1;
      calls.forceSignals.push(signal);
      if (force) force(signal);
    },
    exit: (code) => {
      calls.exit.push(code);
      resolveExit();
    },
    emitter,
    log: (message) => calls.logs.push(message),
  });

  return { controller, emitter, calls, exited };
}

test('run is idempotent and does not exit', async () => {
  const harness = createHarness();

  await harness.controller.run();
  await harness.controller.run();

  assert.equal(harness.calls.cleanup, 1);
  assert.deepEqual(harness.calls.exit, []);
  harness.controller.dispose();
});

test('SIGINT runs cleanup once, then exits 130', async () => {
  const harness = createHarness();

  harness.emitter.emit('SIGINT');
  await harness.exited;

  assert.deepEqual(harness.calls.exit, [130]);
  assert.equal(harness.calls.cleanup, 1);
  assert.match(harness.calls.logs.join('\n'), /interrupted by SIGINT; cleaning up/);
  harness.controller.dispose();
});

test('SIGTERM runs cleanup once, then exits 143', async () => {
  const harness = createHarness();

  harness.emitter.emit('SIGTERM');
  await harness.exited;

  assert.deepEqual(harness.calls.exit, [143]);
  assert.equal(harness.calls.cleanup, 1);
  assert.match(harness.calls.logs.join('\n'), /interrupted by SIGTERM; cleaning up/);
  harness.controller.dispose();
});

test('a second signal forces an immediate exit without cleaning up twice', async () => {
  const release = deferred();
  const harness = createHarness({ cleanup: () => release.promise });

  harness.emitter.emit('SIGINT');
  await Promise.resolve();
  assert.equal(harness.calls.cleanup, 1);

  harness.emitter.emit('SIGTERM');
  await harness.exited;

  assert.deepEqual(harness.calls.exit, [143]);
  assert.equal(harness.calls.force, 1);
  assert.deepEqual(harness.calls.forceSignals, ['SIGTERM']);

  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.calls.exit, [143]);
  assert.equal(harness.calls.cleanup, 1);
  harness.controller.dispose();
});

test('a cleanup rejection is logged and still exits with the signal code', async () => {
  const harness = createHarness({
    cleanup: async () => {
      throw new Error('boom');
    },
  });

  harness.emitter.emit('SIGINT');
  await harness.exited;

  assert.deepEqual(harness.calls.exit, [130]);
  assert.equal(harness.calls.cleanup, 1);
  assert.match(harness.calls.logs.join('\n'), /cleanup failed: boom/);
  harness.controller.dispose();
});

test('dispose removes both listeners and ignores later signals', async () => {
  const harness = createHarness();

  harness.controller.dispose();

  assert.equal(harness.emitter.listenerCount('SIGINT'), 0);
  assert.equal(harness.emitter.listenerCount('SIGTERM'), 0);

  harness.emitter.emit('SIGINT');
  harness.emitter.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.calls.cleanup, 0);
  assert.deepEqual(harness.calls.exit, []);
});

test('a throwing force hook still exits immediately', async () => {
  const harness = createHarness({
    cleanup: () => new Promise(() => {}),
    force: () => {
      throw new Error('force boom');
    },
  });

  harness.emitter.emit('SIGINT');
  harness.emitter.emit('SIGTERM');
  await harness.exited;

  assert.deepEqual(harness.calls.exit, [143]);
  assert.equal(harness.calls.force, 1);
  assert.match(harness.calls.logs.join('\n'), /force cleanup failed: force boom/);
});
