import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openDatabase } from '../../fixtures/references/correct/src/db.ts';
import { JobStore } from '../../fixtures/references/correct/src/store.ts';
import { createHandler } from '../../fixtures/references/correct/src/app.ts';
import { tick } from '../../fixtures/references/correct/src/runner.ts';
import { recoverInterrupted } from '../../fixtures/references/correct/src/recovery.ts';

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
  json: () => any;
}

function harness(start = 1_000) {
  const db = openDatabase(':memory:');
  const store = new JobStore(db);
  store.migrate();
  const clock = { t: start };
  const now = () => clock.t;
  const handler = createHandler({ store, uiHtml: '<html>ui</html>', now });
  async function call(method: string, url: string, opts: { body?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
    const req = Readable.from(opts.body === undefined ? [] : [Buffer.from(opts.body)]) as unknown as IncomingMessage;
    Object.assign(req, { method, url, headers: Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) });
    const reply = { status: 0, headers: {} as Record<string, string>, body: '' };
    const fake = {
      headersSent: false,
      writeHead(status: number, headers: Record<string, string>) {
        reply.status = status;
        reply.headers = headers;
        fake.headersSent = true;
        return fake;
      },
      end(chunk?: string) {
        reply.body = chunk ?? '';
      },
    };
    const res = fake as unknown as ServerResponse;
    await handler(req, res);
    return { ...reply, json: () => JSON.parse(reply.body) };
  }
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    call('POST', '/api/jobs', { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  const deps = { store, now, sleep: async (ms: number) => { clock.t += ms; } };
  return { db, store, clock, call, post, deps };
}

describe('HTTP contract (reference)', () => {
  it('reports health with worker state from the heartbeat', async () => {
    const h = harness();
    expect((await h.call('GET', '/health')).json()).toEqual({ status: 'ok', worker: 'down' });
    h.store.heartbeat(h.clock.t);
    expect((await h.call('GET', '/health')).json()).toEqual({ status: 'ok', worker: 'up' });
  });

  it('serves the UI at /', async () => {
    const r = await harness().call('GET', '/');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
  });

  it('creates, replays, and conflicts by idempotency key', async () => {
    const h = harness();
    const created = await h.post({ input: 'hello', steps: 3 }, { 'Idempotency-Key': 'k1' });
    expect(created.status).toBe(201);
    expect(created.json()).toMatchObject({ status: 'queued', input: 'hello', steps: 3, failAttempts: 0, attempts: 0, progress: { completed: 0, total: 3 }, result: null, error: null });
    const replay = await h.post({ input: 'hello', steps: 3 }, { 'Idempotency-Key': 'k1' });
    expect(replay.status).toBe(200);
    expect(replay.json().id).toBe(created.json().id);
    const implicitDefaults = await h.post({ input: 'x' }, { 'Idempotency-Key': 'k2' });
    expect((await h.post({ input: 'x', steps: 5, failAttempts: 0 }, { 'Idempotency-Key': 'k2' })).json().id).toBe(implicitDefaults.json().id);
    const conflict = await h.post({ input: 'other' }, { 'Idempotency-Key': 'k1' });
    expect(conflict.status).toBe(409);
    expect(conflict.json().error.code).toBe('idempotency_conflict');
    expect((await h.call('GET', '/api/jobs')).json().jobs).toHaveLength(2);
  });

  it.each([
    ['{not json', {}],
    [JSON.stringify({ input: '' }), {}],
    [JSON.stringify({ input: 'a', steps: 99 }), {}],
    [JSON.stringify({ input: 'a' }), { 'Idempotency-Key': 'bad key' }],
    [JSON.stringify({ input: 'a' }), { 'content-type': 'text/plain' }],
  ])('rejects %s with 400 and creates no job', async (body, headers) => {
    const h = harness();
    const r = await h.post(body, headers as Record<string, string>);
    expect(r.status).toBe(400);
    expect(r.json().error).toMatchObject({ code: 'invalid_request' });
    expect(r.json().error.fields.length).toBeGreaterThan(0);
    expect(h.store.list()).toHaveLength(0);
  });

  it('never creates a job for an invalid body and never answers 5xx', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string(), fc.json()), async (body) => {
        const h = harness();
        const r = await h.post(body);
        expect(r.status).toBeLessThan(500);
        expect(h.store.list()).toHaveLength(r.status === 201 ? 1 : 0);
      }),
      { numRuns: 100 },
    );
  });

  it('returns 404 for unknown jobs and paths, 405 for wrong methods', async () => {
    const h = harness();
    expect((await h.call('GET', '/api/jobs/nope')).status).toBe(404);
    expect((await h.call('GET', '/elsewhere')).status).toBe(404);
    expect((await h.call('DELETE', '/api/jobs')).status).toBe(405);
  });
});

describe('worker behaviour (reference)', () => {
  it('runs a job to completion with visible progress and output', async () => {
    const h = harness();
    const id = (await h.post({ input: 'Hello', steps: 3 })).json().id;
    expect(await tick(h.deps)).toBe(true);
    expect((await h.call('GET', `/api/jobs/${id}`)).json()).toMatchObject({
      status: 'completed',
      attempts: 1,
      progress: { completed: 3, total: 3 },
      result: { output: 'HELLO' },
    });
  });

  it('retries transient failures to completion without duplicating the job', async () => {
    const h = harness();
    const id = (await h.post({ input: 'r', steps: 1, failAttempts: 2 })).json().id;
    for (let i = 0; i < 20; i += 1) {
      if (!(await tick(h.deps))) h.clock.t += 100;
    }
    const jobs = (await h.call('GET', '/api/jobs')).json().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id, status: 'completed', attempts: 3, result: { output: 'R' } });
  });

  it('fails a job after three transient failures', async () => {
    const h = harness();
    const id = (await h.post({ input: 'f', steps: 1, failAttempts: 5 })).json().id;
    for (let i = 0; i < 20; i += 1) {
      if (!(await tick(h.deps))) h.clock.t += 100;
    }
    expect((await h.call('GET', `/api/jobs/${id}`)).json()).toMatchObject({ status: 'failed', attempts: 3, result: null, error: 'transient failure' });
  });

  it('resumes an in-flight job after a simulated worker crash and restart', async () => {
    const h = harness();
    const id = (await h.post({ input: 'long', steps: 5 })).json().id;
    h.store.claimNext(h.clock.t);
    h.store.progress(id, 2, h.clock.t);
    // crash: nothing else happens to the job; a new worker process starts
    recoverInterrupted(h.db, h.clock.t);
    await tick(h.deps);
    expect((await h.call('GET', `/api/jobs/${id}`)).json()).toMatchObject({ status: 'completed', result: { output: 'LONG' } });
  });
});
