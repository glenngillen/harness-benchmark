import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Submission } from './validate.ts';
import { fingerprint } from './fingerprint.ts';
import { decideAfterFailure } from './retry.ts';
import { LEASE_MS } from './recovery.ts';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface JobRow {
  id: string;
  status: JobStatus;
  input: string;
  steps: number;
  failAttempts: number;
  attempts: number;
  progress: number;
  output: string | null;
  error: string | null;
  availableAt: number;
  createdAt: string;
  updatedAt: string;
}

export type CreateResult = { kind: 'created' | 'replay'; job: JobRow } | { kind: 'conflict' };

const SELECT = `SELECT id, status, input, steps, fail_attempts AS failAttempts, attempts, progress, output, error,
  available_at AS availableAt, created_at AS createdAt, updated_at AS updatedAt FROM jobs`;

const iso = (ms: number) => new Date(ms).toISOString();

export class JobStore {
  constructor(private readonly db: DatabaseSync) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT UNIQUE,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        input TEXT NOT NULL,
        steps INTEGER NOT NULL,
        fail_attempts INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        progress INTEGER NOT NULL DEFAULT 0,
        output TEXT,
        error TEXT,
        available_at INTEGER NOT NULL,
        lease_until INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS heartbeat (name TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  create(sub: Submission, key: string | undefined, now: number): CreateResult {
    return this.tx(() => {
      const fp = fingerprint(sub);
      if (key !== undefined) {
        const existing = this.db.prepare('SELECT id, fingerprint FROM jobs WHERE idempotency_key = ?').get(key) as
          | { id: string; fingerprint: string }
          | undefined;
        if (existing) {
          return existing.fingerprint === fp ? { kind: 'replay', job: this.get(existing.id)! } : { kind: 'conflict' };
        }
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO jobs (id, idempotency_key, fingerprint, status, input, steps, fail_attempts, available_at, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, key ?? null, fp, sub.input, sub.steps, sub.failAttempts, now, iso(now), iso(now));
      return { kind: 'created', job: this.get(id)! };
    });
  }

  get(id: string): JobRow | undefined {
    return this.db.prepare(`${SELECT} WHERE id = ?`).get(id) as JobRow | undefined;
  }

  list(): JobRow[] {
    return this.db.prepare(`${SELECT} ORDER BY seq DESC`).all() as unknown as JobRow[];
  }

  claimNext(now: number): JobRow | undefined {
    return this.tx(() => {
      const row = this.db
        .prepare(
          `SELECT id FROM jobs WHERE (status = 'queued' AND available_at <= ?) OR (status = 'running' AND lease_until < ?)
           ORDER BY seq LIMIT 1`,
        )
        .get(now, now) as { id: string } | undefined;
      if (!row) return undefined;
      this.db
        .prepare(
          `UPDATE jobs SET status = 'running', attempts = attempts + 1, progress = 0, lease_until = ?, updated_at = ? WHERE id = ?`,
        )
        .run(now + LEASE_MS, iso(now), row.id);
      return this.get(row.id);
    });
  }

  progress(id: string, completed: number, now: number): void {
    this.db
      .prepare(`UPDATE jobs SET progress = ?, lease_until = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
      .run(completed, now + LEASE_MS, iso(now), id);
  }

  complete(id: string, output: string, now: number): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = 'completed', progress = steps, output = ?, error = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(output, iso(now), id);
  }

  failAttempt(id: string, now: number, error: string): void {
    this.tx(() => {
      const job = this.get(id);
      if (!job) return;
      const decision = decideAfterFailure(job.attempts, now);
      if (decision.kind === 'retry') {
        this.db
          .prepare(`UPDATE jobs SET status = 'queued', progress = 0, available_at = ?, lease_until = NULL, updated_at = ? WHERE id = ?`)
          .run(decision.availableAt, iso(now), id);
      } else {
        this.db
          .prepare(`UPDATE jobs SET status = 'failed', error = ?, lease_until = NULL, updated_at = ? WHERE id = ?`)
          .run(error, iso(now), id);
      }
    });
  }

  heartbeat(now: number): void {
    this.db
      .prepare(`INSERT INTO heartbeat (name, at) VALUES ('worker', ?) ON CONFLICT(name) DO UPDATE SET at = excluded.at`)
      .run(now);
  }

  lastHeartbeat(): number | undefined {
    const row = this.db.prepare(`SELECT at FROM heartbeat WHERE name = 'worker'`).get() as { at: number } | undefined;
    return row?.at;
  }
}
