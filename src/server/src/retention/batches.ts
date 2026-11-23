export interface BatchDeleteOptions {
  /** Runs one bounded DELETE and returns the number of rows it removed. */
  runBatch(): number;
  batchSize: number;
  /** Checked between batches so shutdown can stop a long drain. */
  shouldStop?(): boolean;
}

/**
 * Deletes in bounded batches with an event-loop yield between them.
 * better-sqlite3 is synchronous, so one unbounded delete would block the brain.
 */
export async function deleteInBatches(options: BatchDeleteOptions): Promise<number> {
  let deleted = 0;
  for (;;) {
    const changes = options.runBatch();
    deleted += changes;
    if (changes < options.batchSize) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (options.shouldStop?.()) break;
  }
  return deleted;
}
