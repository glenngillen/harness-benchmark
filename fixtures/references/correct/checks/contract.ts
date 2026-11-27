/**
 * Contract checks on disclosed examples: submission, validation, completion, retry, and
 * idempotency. Run with `npm run build && npm run check:contract`.
 *
 * These are examples, not the full contract in TASK.md. Persistence across restarts, the browser
 * page, and many validation rules are not checked here.
 */
import {
  expect,
  expectEqual,
  expectJsonResponse,
  getJob,
  isObject,
  jobId,
  listJobs,
  postJson,
  waitForFinished,
  type Check,
  type CheckContext,
} from './core.ts';

/** Generous waits: pickup within 1 s, steps of at most 500 ms, retry delays of at most 2 s. */
const FINISH_MS = 8_000;
const RETRY_FINISH_MS = 12_000;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function expectQueuedJob(job: Record<string, unknown>, input: string, steps: number, failAttempts: number, what: string): void {
  jobId(job, what);
  expectEqual(job.status, 'queued', `${what} status`);
  expectEqual(job.input, input, `${what} input`);
  expectEqual(job.steps, steps, `${what} steps`);
  expectEqual(job.failAttempts, failAttempts, `${what} failAttempts`);
  expectEqual(job.attempts, 0, `${what} attempts`);
  expect(isObject(job.progress), `${what} progress: expected {"completed":0,"total":${steps}}, observed ${JSON.stringify(job.progress)}`);
  expectEqual(job.progress.completed, 0, `${what} progress.completed`);
  expectEqual(job.progress.total, steps, `${what} progress.total`);
  expectEqual(job.result, null, `${what} result`);
  expectEqual(job.error, null, `${what} error`);
  for (const f of ['createdAt', 'updatedAt'] as const) {
    expect(typeof job[f] === 'string' && ISO.test(job[f]), `${what} ${f}: expected an ISO 8601 timestamp, observed ${JSON.stringify(job[f])}`);
  }
}

function expectCompleted(job: Record<string, unknown>, output: string, steps: number, attempts: number, what: string): void {
  expectEqual(job.status, 'completed', `${what} status`);
  expect(isObject(job.result), `${what} result: expected {"output":${JSON.stringify(output)}}, observed ${JSON.stringify(job.result)}`);
  expectEqual(job.result.output, output, `${what} result.output`);
  expectEqual(job.error, null, `${what} error`);
  expectEqual(job.attempts, attempts, `${what} attempts`);
  expect(isObject(job.progress), `${what} progress: expected an object, observed ${JSON.stringify(job.progress)}`);
  expectEqual(job.progress.completed, steps, `${what} progress.completed`);
}

async function create(ctx: CheckContext, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const what = `POST /api/jobs ${JSON.stringify(body)}`;
  return expectJsonResponse(await postJson(ctx, body, headers), 201, what);
}

async function expectInvalid(ctx: CheckContext, body: Record<string, unknown>, field: string): Promise<void> {
  const what = `POST /api/jobs ${JSON.stringify(body)}`;
  const res = expectJsonResponse(await postJson(ctx, body), 400, what);
  const error = res.error;
  expect(isObject(error), `${what}: expected {"error":{...}}, observed ${JSON.stringify(res)}`);
  expectEqual(error.code, 'invalid_request', `${what} error.code`);
  const fields = Array.isArray(error.fields) ? error.fields.map((f) => (isObject(f) ? f.field : undefined)) : [];
  expect(fields.includes(field), `${what} error.fields: expected an entry with "field":${JSON.stringify(field)}, observed ${JSON.stringify(error.fields)}`);
}

export const CONTRACT_CHECKS: readonly Check[] = [
  {
    name: 'contract.submit-job',
    title: 'POST /api/jobs creates a queued job that GET /api/jobs/:id and GET /api/jobs return',
    async run(ctx) {
      const input = 'Check example';
      const job = await create(ctx, { input, steps: 2 });
      expectQueuedJob(job, input, 2, 0, 'created job');
      const id = jobId(job, 'created job');
      expectEqual((await getJob(ctx, id)).id, id, `GET /api/jobs/${id} id`);
      const jobs = await listJobs(ctx);
      expectEqual(jobs[0]?.id, id, 'GET /api/jobs first (newest) job id');
      const missing = await ctx.http.request({ method: 'GET', path: '/api/jobs/no-such-job' });
      const body = expectJsonResponse(missing, 404, 'GET /api/jobs/no-such-job');
      expectEqual(isObject(body.error) ? body.error.code : undefined, 'not_found', 'GET /api/jobs/no-such-job error.code');
    },
  },
  {
    name: 'contract.reject-invalid',
    title: 'Invalid submissions return 400 invalid_request naming the field, and create no job',
    async run(ctx) {
      const before = (await listJobs(ctx)).length;
      await expectInvalid(ctx, { input: 'Check example', steps: '2' }, 'steps');
      await expectInvalid(ctx, { input: 'Check example', failAttempts: 7 }, 'failAttempts');
      await expectInvalid(ctx, { input: 'Check example', colour: 'blue' }, 'colour');
      await expectInvalid(ctx, { steps: 2 }, 'input');
      expectEqual((await listJobs(ctx)).length, before, 'number of jobs after invalid submissions');
    },
  },
  {
    name: 'contract.complete-job',
    title: 'A job completes with result.output equal to the upper-cased input',
    async run(ctx) {
      const job = await create(ctx, { input: 'complete me', steps: 2, failAttempts: 0 });
      const done = await waitForFinished(ctx, jobId(job, 'created job'), FINISH_MS);
      expectCompleted(done, 'COMPLETE ME', 2, 1, 'finished job');
    },
  },
  {
    name: 'contract.retry-transient',
    title: 'failAttempts 1 fails the first attempt, then completes on attempt 2 without a duplicate job',
    async run(ctx) {
      const input = 'retry example';
      const job = await create(ctx, { input, steps: 1, failAttempts: 1 });
      const done = await waitForFinished(ctx, jobId(job, 'created job'), RETRY_FINISH_MS);
      expectCompleted(done, 'RETRY EXAMPLE', 1, 2, 'finished job');
      const copies = (await listJobs(ctx)).filter((j) => j.input === input).length;
      expectEqual(copies, 1, `jobs listed with input ${JSON.stringify(input)}`);
    },
  },
  {
    name: 'contract.idempotent-replay',
    title: 'A reused Idempotency-Key replays the same job (200), or returns 409 for a different payload',
    async run(ctx) {
      const key = { 'idempotency-key': 'check-example-key' };
      const input = 'idempotent example';
      const first = await create(ctx, { input, steps: 1 }, key);
      const id = jobId(first, 'first submission');
      const replay = expectJsonResponse(await postJson(ctx, { input, steps: 1 }, key), 200, 'replay with the same key and payload');
      expectEqual(replay.id, id, 'replayed job id');
      const conflict = expectJsonResponse(await postJson(ctx, { input: 'idempotent example, changed', steps: 1 }, key), 409, 'same key with a different input');
      expectEqual(isObject(conflict.error) ? conflict.error.code : undefined, 'idempotency_conflict', 'conflict error.code');
      const copies = (await listJobs(ctx)).filter((j) => typeof j.input === 'string' && j.input.startsWith('idempotent example')).length;
      expectEqual(copies, 1, 'jobs created for the idempotency key');
    },
  },
];
