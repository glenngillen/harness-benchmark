import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Opens the SQLite database shared by the server and worker processes. */
export function openDatabase(path: string = process.env.DATABASE_PATH ?? 'data/jobs.db'): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // busy_timeout first: switching to WAL takes a brief exclusive lock, and the server and worker
  // open the same database at once, so the loser must wait rather than fail.
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  return db;
}
