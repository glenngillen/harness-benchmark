import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { openDatabase } from '../../fixtures/references/correct/src/db.ts';
import { JobStore } from '../../fixtures/references/correct/src/store.ts';
import { recoverInterrupted, LEASE_MS } from '../../fixtures/references/correct/src/recovery.ts';
import { toJobJson } from '../../fixtures/references/correct/src/jobjson.ts';

const sub = (input = 'job', steps = 3, failAttempts = 0) => ({ input, steps, failAttempts });

function store() {
  const db = openDatabase(':memory:');
  const s = new JobStore(db);
  s.migrate();
  return { db, s };
}

describe('JobStore submission and idempotency', () => {
  it('creates a queued job with zero progress', () => {
    const { s } = store();
    const r = s.create(sub(), undefined, 1000);
    expect(r.kind).toBe('created');
    if (r.kind === 'conflict') throw new Error('unexpected');
    const json = toJobJson(r.job);
    expect(json).toMatchObject({ status: 'queued', attempts: 0, progress: { completed: 0, total: 3 }, result: null, error: null });
    expect(typeof json.id).toBe('string');
  });

  it('replays the same key with the same payload and conflicts on a different payload', () => {
    const { s } = store();
    const first = s.create(sub('a'), 'k1', 1000);
    const replay = s.create(sub('a'), 'k1', 2000);
    const conflict = s.create(sub('b'), 'k1', 3000);
    expect(replay.kind).toBe('replay');
    expect(conflict.kind).toBe('conflict');
    if (first.kind !== 'created' || replay.kind !== 'replay') throw new Error('unexpected');
    expect(replay.job.id).toBe(first.job.id);
    expect(s.list()).toHaveLength(1);
  });

  it('stores exactly one job per distinct key plus one per keyless submission', () => {
    fc.assert(
      fc.property(fc.array(fc.option(fc.constantFrom('a', 'b', 'c', 'd'), { nil: undefined }), { maxLength: 30 }), (keys) => {
        const { s } = store();
        keys.forEach((k, i) => s.create(sub('same'), k, i));
        const distinct = new Set(keys.filter((k) => k !== undefined)).size;
        const keyless = keys.filter((k) => k === undefined).length;
        expect(s.list()).toHaveLength(distinct + keyless);
      }),
      { numRuns: 50 },
    );
  });

  it('lists newest first', () => {
    const { s } = store();
    s.create(sub('first'), undefined, 1);
    s.create(sub('second'), undefined, 2);
    expect(s.list().map((j) => j.input)).toEqual(['second', 'first']);
  });
});

describe('JobStore worker lifecycle', () => {
  it('claims, reports progress, and completes', () => {
    const { s } = store();
    const c = s.create(sub('hi', 2), undefined, 0);
    if (c.kind === 'conflict') throw new Error('unexpected');
    const claimed = s.claimNext(10);
    expect(claimed?.id).toBe(c.job.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);
    expect(s.claimNext(11)).toBeUndefined();
    s.progress(c.job.id, 1, 20);
    expect(s.get(c.job.id)?.progress).toBe(1);
    s.complete(c.job.id, 'HI', 30);
    expect(toJobJson(s.get(c.job.id)!)).toMatchObject({ status: 'completed', progress: { completed: 2, total: 2 }, result: { output: 'HI' } });
  });

  it('requeues a transient failure after backoff, then fails after the last attempt', () => {
    const { s } = store();
    const c = s.create(sub('x', 1, 5), undefined, 0);
    if (c.kind === 'conflict') throw new Error('unexpected');
    let now = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const job = s.claimNext(now);
      expect(job?.attempts).toBe(attempt);
      s.failAttempt(c.job.id, now, 'transient failure');
      const after = s.get(c.job.id)!;
      if (attempt < 3) {
        expect(after.status).toBe('queued');
        expect(s.claimNext(now)).toBeUndefined();
        now = after.availableAt;
      } else {
        expect(after.status).toBe('failed');
        expect(after.error).toBe('transient failure');
      }
    }
    expect(s.list()).toHaveLength(1);
  });

  it('recovers interrupted running jobs on worker start', () => {
    const { db, s } = store();
    const c = s.create(sub('x', 5), undefined, 0);
    if (c.kind === 'conflict') throw new Error('unexpected');
    s.claimNext(0);
    s.progress(c.job.id, 3, 1);
    expect(recoverInterrupted(db, 2)).toBe(1);
    const job = s.get(c.job.id)!;
    expect(job.status).toBe('queued');
    expect(s.claimNext(3)?.id).toBe(c.job.id);
  });

  it('reclaims a running job whose lease expired', () => {
    const { s } = store();
    const c = s.create(sub(), undefined, 0);
    if (c.kind === 'conflict') throw new Error('unexpected');
    s.claimNext(0);
    expect(s.claimNext(LEASE_MS - 1)).toBeUndefined();
    expect(s.claimNext(LEASE_MS + 1)?.attempts).toBe(2);
  });

  it('records and reads the worker heartbeat', () => {
    const { s } = store();
    expect(s.lastHeartbeat()).toBeUndefined();
    s.heartbeat(1234);
    expect(s.lastHeartbeat()).toBe(1234);
  });
});
