import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { BENCHMARK_ROOT } from '../../src/fixtures.ts';
import { openDatabase as openCorrect } from '../../fixtures/references/correct/src/db.ts';
import { openDatabase as openScaffold } from '../../fixtures/scaffold/src/db.ts';

// Regression for the startup race: the server and worker open the same fresh database
// at once. Switching to WAL needs a brief exclusive lock, so `busy_timeout` must already be set
// or the loser fails at once with "database is locked" instead of waiting.
// No property test: openDatabase is I/O with no input-dependent invariant to state.

const HOLD_MS = 300;
const TMP_ROOT = process.env.HARNESS_TEST_TMP ?? join(BENCHMARK_ROOT, '.runs', 'unit-tmp');
mkdirSync(TMP_ROOT, { recursive: true });

/** Holds an exclusive lock on `path` from another thread for HOLD_MS, resolving once it is held. */
function holdLock(path: string): Promise<Worker> {
  const worker = new Worker(
    `const { workerData, parentPort } = require('node:worker_threads');
     const { DatabaseSync } = require('node:sqlite');
     const db = new DatabaseSync(workerData.path);
     db.exec('BEGIN EXCLUSIVE');
     parentPort.postMessage('locked');
     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
     db.exec('COMMIT');
     db.close();`,
    { eval: true, workerData: { path, holdMs: HOLD_MS } },
  );
  return new Promise((resolve, reject) => {
    worker.once('message', () => resolve(worker));
    worker.once('error', reject);
  });
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.each([
  ['scaffold', openScaffold],
  ['correct reference', openCorrect],
])('%s openDatabase', (_name, openDatabase) => {
  it('waits for a lock held by the other process instead of failing at once', async () => {
    const dir = mkdtempSync(join(TMP_ROOT, 'db-'));
    dirs.push(dir);
    const path = join(dir, 'jobs.db');
    const worker = await holdLock(path);
    try {
      const db = openDatabase(path);
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      db.close();
    } finally {
      await worker.terminate();
    }
  });
});
