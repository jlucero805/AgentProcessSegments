import { afterAll } from 'vitest';
import { cleanupTmpDirs } from './tmp.js';

// Vitest runs after-hooks in reverse registration order, so a test file's own
// teardown (close the app/db, kill PTYs) runs before its temp root is deleted.
afterAll(cleanupTmpDirs);
