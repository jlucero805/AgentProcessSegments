import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { ReadableStream, TransformStream, WritableStream } from 'node:stream/web';

// A vmThreads VM context has no Node web streams, and assistant-stream reads them at
// import time. Seed them from node:stream/web before any test module loads.
const webStreamGlobals = globalThis as unknown as Record<string, unknown>;
if (!('ReadableStream' in globalThis)) webStreamGlobals.ReadableStream = ReadableStream;
if (!('TransformStream' in globalThis)) webStreamGlobals.TransformStream = TransformStream;
if (!('WritableStream' in globalThis)) webStreamGlobals.WritableStream = WritableStream;

// jsdom does not implement these; assistant-ui's viewport and radix primitives use them.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = () => {};
}

afterEach(() => {
  cleanup();
  // Backstop for a case that installs fake timers and fails before its own finally.
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});
