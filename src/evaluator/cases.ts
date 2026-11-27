/**
 * Independent acceptance cases (methodology section 9, behaviours A1-A8).
 *
 * PROTECTED: this file, and every case below, must never be copied into a model workspace or
 * quoted in build-time feedback. The data deliberately differs from every example disclosed in
 * the brief and in the public checks/ suites, and every input carries a per-evaluation nonce so
 * an app cannot recognise evaluator traffic or replay canned answers.
 *
 * Cases run in the listed order against one app instance; the A7 group restarts it. Each case
 * is black-box: HTTP over loopback, the browser page, and process signals only.
 */
import { CaseFailure, check, checkEqual, waitFor, type Deadline } from './expect.ts';
import { errorProblems, fieldNames, isJsonContentType, jobProblems } from './shape.ts';
import type { AppControl, Behaviour, Clock, HttpClient, HttpResponse, UiPage } from './types.ts';

// ---------------------------------------------------------------- timing contract (task.md)

const STARTUP_MS = 10_000;
const HEARTBEAT_STALE_MS = 3_000;
const MAX_STEP_MS = 500;
const MIN_STEP_MS = 50;
const MAX_RETRY_DELAY_MS = 2_000;
const PICKUP_MS = 1_000;
const RECOVERY_MS = 10_000;
const UI_REFRESH_MS = 2_000;
const SHUTDOWN_MS = 5_000;
/** Polling and scheduling slack added to every contractual window. */
const SLACK_MS = 1_000;

/** Upper bound for a job to reach a terminal state once the worker is idle. */
export function jobWindowMs(steps: number, failedAttempts = 0): number {
  const attempts = Math.min(failedAttempts, 2) + 1;
  return PICKUP_MS + steps * MAX_STEP_MS * attempts + Math.min(failedAttempts, 2) * MAX_RETRY_DELAY_MS + SLACK_MS;
}

// ---------------------------------------------------------------- data

export type EvalData = ReturnType<typeof evaluationData>;

/** Evaluation inputs. `nonce` must match /^[0-9a-f]{8,16}$/ so it is valid inside idempotency keys. */
export function evaluationData(nonce: string) {
  if (!/^[0-9a-f]{8,16}$/.test(nonce)) throw new Error(`invalid nonce: ${nonce}`);
  const n = nonce;
  return {
    nonce,
    createInput: `Zebra crossing at dusk ${n}`,
    defaultsInput: `  Mixed Case, kept as sent ${n}  `,
    unicodeInput: `straße café ǆ ${n}`,
    progressInput: `progress watcher ${n}`,
    validInput: `valid text ${n}`,
    longInput: `${'é'.repeat(1000 - n.length - 1)} ${n}`,
    idemInput: `Quarterly report draft ${n}`,
    idemOtherInput: `Quarterly report final ${n}`,
    defaultsKeyInput: `Ledger ${n}`,
    concurrentInput: `Concurrent submit ${n}`,
    noKeyInput: `No key twice ${n}`,
    retryInput: `retry me ✓ ${n}`,
    exhaustInput: `give up eventually ${n}`,
    uiInput: `Browser submitted ⚑ item ${n}`,
    uiAfterErrorInput: `Browser after error ${n}`,
    liveInput: `live update ${n}`,
    inflightInput: `long running survives ${n}`,
    queuedInput: `queued behind ${n}`,
    keys: { replay: `eval-${n}-replay`, defaults: `eval_${n}_defaults`, concurrent: `EVAL-${n}-race` },
  };
}

// ---------------------------------------------------------------- context

type Json = Record<string, unknown>;

interface JobRef {
  id: string | undefined;
  input: string;
}

interface Snapshot {
  id: string;
  status: unknown;
  attempts: unknown;
  updatedAt: unknown;
  result: unknown;
  error: unknown;
}

export interface EvalState {
  replayJob?: JobRef & { createdAt: unknown };
  uiJob?: JobRef;
  restart?: {
    before: Snapshot[];
    inflight: JobRef;
    queued: JobRef;
  };
}

export interface CaseContext {
  http: HttpClient;
  app: AppControl;
  clock: Clock;
  deadline: Deadline;
  /** Opens the UI page lazily (once) against the current server. */
  page(): Promise<UiPage>;
  data: EvalData;
  state: EvalState;
}

export interface EvalCase {
  id: string;
  behaviour: Behaviour;
  title: string;
  run(ctx: CaseContext): Promise<void>;
}

// ---------------------------------------------------------------- HTTP helpers

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const brief = (r: HttpResponse) => `${r.status} ${r.text.length > 300 ? `${r.text.slice(0, 300)}…` : r.text}`;

function post(ctx: CaseContext, body: unknown, headers: Record<string, string> = {}): Promise<HttpResponse> {
  return ctx.http.request({
    method: 'POST',
    path: '/api/jobs',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function expectJson(r: HttpResponse, what: string): void {
  check(isJsonContentType(r.contentType), `${what}: Content-Type must be application/json (got ${JSON.stringify(r.contentType)})`);
  check(r.json !== undefined, `${what}: body is not valid JSON`);
}

async function listJobs(ctx: CaseContext): Promise<Json[]> {
  const r = await ctx.http.request({ method: 'GET', path: '/api/jobs' });
  checkEqual(r.status, 200, 'GET /api/jobs status');
  expectJson(r, 'GET /api/jobs');
  const jobs = isObject(r.json) ? r.json.jobs : undefined;
  check(Array.isArray(jobs), 'GET /api/jobs must return {"jobs": [...]}');
  return jobs.map((j) => (isObject(j) ? j : {}));
}

async function countJobs(ctx: CaseContext): Promise<number> {
  return (await listJobs(ctx)).length;
}

function refOf(job: unknown, input: string): JobRef {
  const id = isObject(job) && typeof job.id === 'string' && job.id.length > 0 ? job.id : undefined;
  return { id, input };
}

/** Fetches a job by id, or by its unique input when the app failed to return an id (so A2 faults do not mask A3-A7). */
async function fetchJob(ctx: CaseContext, ref: JobRef): Promise<Json> {
  if (ref.id !== undefined) {
    const r = await ctx.http.request({ method: 'GET', path: `/api/jobs/${encodeURIComponent(ref.id)}` });
    checkEqual(r.status, 200, `GET /api/jobs/:id status for ${ref.id}`);
    expectJson(r, 'GET /api/jobs/:id');
    check(isObject(r.json), 'GET /api/jobs/:id must return a job object');
    return r.json;
  }
  const matches = (await listJobs(ctx)).filter((j) => j.input === ref.input);
  checkEqual(matches.length, 1, `jobs listed with input ${JSON.stringify(ref.input)}`);
  return matches[0]!;
}

async function createJob(ctx: CaseContext, body: Json, headers: Record<string, string> = {}): Promise<{ ref: JobRef; job: Json }> {
  const r = await post(ctx, body, headers);
  check(r.status === 201, `POST /api/jobs ${JSON.stringify(body)}: expected 201, observed ${brief(r)}`);
  expectJson(r, 'POST /api/jobs');
  const job = isObject(r.json) ? r.json : {};
  return { ref: refOf(job, String(body.input)), job };
}

const TERMINAL = new Set(['completed', 'failed']);

async function waitTerminal(ctx: CaseContext, ref: JobRef, timeoutMs: number, observe?: (job: Json, at: number) => void): Promise<Json> {
  return waitFor(ctx.deadline, `job ${ref.id ?? JSON.stringify(ref.input)} to finish`, timeoutMs, async () => {
    const job = await fetchJob(ctx, ref);
    observe?.(job, ctx.clock.now());
    return TERMINAL.has(job.status as string) ? job : undefined;
  });
}

async function waitIdle(ctx: CaseContext, timeoutMs: number): Promise<void> {
  await waitFor(ctx.deadline, 'every job to finish', timeoutMs, async () =>
    (await listJobs(ctx)).every((j) => TERMINAL.has(j.status as string)) ? true : undefined,
  );
}

function expectShape(job: Json, what: string, requireId = false): void {
  const problems = jobProblems(job, { requireId });
  check(problems.length === 0, `${what}: ${problems.join('; ')}`);
}

function expectCompleted(job: Json, input: string, steps: number, what: string): void {
  expectShape(job, what);
  checkEqual(job.status, 'completed', `${what} status`);
  const output = isObject(job.result) ? job.result.output : undefined;
  checkEqual(output, input.toUpperCase(), `${what} result.output`);
  checkEqual(isObject(job.progress) ? job.progress.completed : undefined, steps, `${what} progress.completed`);
  checkEqual(job.error, null, `${what} error`);
}

async function expectInvalid(ctx: CaseContext, send: () => Promise<HttpResponse>, fields: readonly string[]): Promise<void> {
  const before = await countJobs(ctx);
  const r = await send();
  check(r.status === 400, `expected 400 invalid_request, observed ${brief(r)}`);
  expectJson(r, 'validation error');
  const problems = errorProblems(r.json, 'invalid_request');
  check(problems.length === 0, `validation error body: ${problems.join('; ')}`);
  const listed = fieldNames(r.json);
  const missing = fields.filter((f) => !listed.includes(f));
  check(missing.length === 0, `error.fields must name ${JSON.stringify(missing)} (listed ${JSON.stringify(listed)})`);
  if (fields.length === 0) check(listed.length > 0, 'error.fields must name the offending field');
  checkEqual(await countJobs(ctx), before, 'job count after a rejected submission');
}

async function health(ctx: CaseContext): Promise<Json | undefined> {
  const r = await ctx.http.request({ method: 'GET', path: '/health' });
  if (r.status !== 200 || !isObject(r.json)) return undefined;
  return r.json;
}

/** Health probe that treats a refused connection as "not yet" (used only during startup windows). */
async function healthDuringStartup(ctx: CaseContext): Promise<Json | undefined> {
  try {
    return await health(ctx);
  } catch (err) {
    if (err instanceof CaseFailure) return undefined;
    throw err;
  }
}

async function startAndWaitHealthy(ctx: CaseContext): Promise<void> {
  await ctx.app.start();
  const h = await waitFor(ctx.deadline, 'GET /health to answer 200', STARTUP_MS, () => healthDuringStartup(ctx), 100);
  checkEqual(h.status, 'ok', 'health status');
}

/**
 * Stable identities for a job list: the id, or input, creation time and occurrence number when the
 * app omits ids (so A2 faults do not mask A7). Lists are newest first, so occurrences count from the end.
 */
function identities(jobs: Json[]): string[] {
  const seen = new Map<string, number>();
  return [...jobs]
    .reverse()
    .map((j) => {
      if (typeof j.id === 'string' && j.id.length > 0) return j.id;
      const base = `${String(j.input)}@${String(j.createdAt)}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return `${base}#${n}`;
    })
    .reverse();
}

const sameJob = (a: JobRef & { createdAt?: unknown }, b: Json) =>
  a.id !== undefined ? b.id === a.id : b.input === a.input && (a.createdAt === undefined || b.createdAt === a.createdAt);

// ---------------------------------------------------------------- UI helpers

async function uiSubmit(page: UiPage, input: string, steps: string, failAttempts: string): Promise<void> {
  await page.setField('job-input', input);
  await page.setField('job-steps', steps);
  await page.setField('job-fail-attempts', failAttempts);
  await page.click('job-submit');
}

async function waitUiItem(ctx: CaseContext, id: string, what: string, timeoutMs: number, pred: (i: { status: string; progress: string; result: string }) => boolean) {
  const page = await ctx.page();
  return waitFor(ctx.deadline, what, timeoutMs, async () => {
    const item = (await page.jobItems()).find((i) => i.id === id);
    return item && pred(item) ? item : undefined;
  }, 100);
}

// ---------------------------------------------------------------- cases

const invalid = (id: string, title: string, body: unknown, fields: string[], headers?: Record<string, string>): EvalCase => ({
  id,
  behaviour: 'A4',
  title,
  run: (ctx) => expectInvalid(ctx, () => post(ctx, typeof body === 'function' ? (body as (d: EvalData) => unknown)(ctx.data) : body, headers), fields),
});

export const CASES: readonly EvalCase[] = [
  // ---- A1: startup and health
  {
    id: 'A1.starts-and-answers-health',
    behaviour: 'A1',
    title: 'npm run start:server and start:worker start; GET /health answers 200 {"status":"ok"} within 10 s',
    run: (ctx) => startAndWaitHealthy(ctx),
  },
  {
    id: 'A1.reports-worker-up',
    behaviour: 'A1',
    title: 'GET /health reports the running worker as "up"',
    run: async (ctx) => {
      await waitFor(ctx.deadline, 'health worker "up"', STARTUP_MS, async () => ((await health(ctx))?.worker === 'up' ? true : undefined), 100);
    },
  },

  // ---- A2: submission
  {
    id: 'A2.create-returns-queued-job',
    behaviour: 'A2',
    title: 'A valid submission returns 201 with a complete queued job and creates exactly one job, listed first',
    run: async (ctx) => {
      const before = await listJobs(ctx);
      const body = { input: ctx.data.createInput, steps: 2, failAttempts: 0 };
      const { job } = await createJob(ctx, body);
      expectShape(job, '201 body', true);
      checkEqual(job.status, 'queued', 'status');
      checkEqual(job.input, body.input, 'input');
      checkEqual(job.steps, 2, 'steps');
      checkEqual(job.failAttempts, 0, 'failAttempts');
      checkEqual(job.attempts, 0, 'attempts');
      checkEqual(isObject(job.progress) ? job.progress.completed : undefined, 0, 'progress.completed');
      check(!before.some((j) => j.id === job.id), 'id must be new');
      const after = await listJobs(ctx);
      checkEqual(after.length, before.length + 1, 'job count');
      checkEqual(after[0]?.id, job.id, 'newest job listed first');
      const fetched = await fetchJob(ctx, refOf(job, body.input));
      checkEqual(fetched.id, job.id, 'GET /api/jobs/:id id');
      checkEqual(fetched.input, body.input, 'GET /api/jobs/:id input');
    },
  },
  {
    id: 'A2.defaults-and-exact-input',
    behaviour: 'A2',
    title: 'Omitted steps and failAttempts default to 5 and 0; input is stored exactly as sent',
    run: async (ctx) => {
      const { job } = await createJob(ctx, { input: ctx.data.defaultsInput });
      expectShape(job, '201 body', true);
      checkEqual(job.input, ctx.data.defaultsInput, 'input');
      checkEqual(job.steps, 5, 'default steps');
      checkEqual(job.failAttempts, 0, 'default failAttempts');
    },
  },

  // ---- A3: processing and retrieval
  {
    id: 'A3.unknown-id-not-found',
    behaviour: 'A3',
    title: 'GET /api/jobs/:id for an unknown id returns 404 not_found',
    run: async (ctx) => {
      const r = await ctx.http.request({ method: 'GET', path: `/api/jobs/missing-${ctx.data.nonce}` });
      check(r.status === 404, `expected 404, observed ${brief(r)}`);
      expectJson(r, '404');
      const problems = errorProblems(r.json, 'not_found');
      check(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'A3.completes-with-uppercase-output',
    behaviour: 'A3',
    title: 'A job completes with result.output equal to input.toUpperCase(), full progress, and one attempt',
    run: async (ctx) => {
      const { ref } = await createJob(ctx, { input: ctx.data.unicodeInput, steps: 3, failAttempts: 0 });
      const job = await waitTerminal(ctx, ref, jobWindowMs(2) + jobWindowMs(5) + jobWindowMs(3));
      expectCompleted(job, ctx.data.unicodeInput, 3, 'completed job');
      checkEqual(job.attempts, 1, 'attempts');
    },
  },
  {
    id: 'A3.progress-observable',
    behaviour: 'A3',
    title: 'An idle worker starts a job within 1 s; progress is visible while running and steps take 50-500 ms',
    run: async (ctx) => {
      await waitIdle(ctx, jobWindowMs(5) * 3);
      const steps = 10;
      const t0 = ctx.clock.now();
      const { ref } = await createJob(ctx, { input: ctx.data.progressInput, steps, failAttempts: 0 });
      let started: number | undefined;
      let runningAt: number | undefined;
      let completedAt: number | undefined;
      let sawPartial = false;
      let last = -1;
      let regressed = false;
      const job = await waitTerminal(ctx, ref, jobWindowMs(steps), (j, at) => {
        const done = isObject(j.progress) ? Number(j.progress.completed) : NaN;
        if (j.status !== 'queued') started ??= at;
        if (j.status === 'running') {
          runningAt ??= at;
          if (done > 0 && done < steps) sawPartial = true;
          if (done < last) regressed = true;
          last = done;
        }
        if (j.status === 'completed') completedAt ??= at;
      });
      expectCompleted(job, ctx.data.progressInput, steps, 'job');
      check(started !== undefined && started - t0 <= PICKUP_MS + 500, `job must start within ${PICKUP_MS} ms (observed ${started === undefined ? 'never' : `${started - t0} ms`})`);
      check(sawPartial, 'progress.completed must be observable between 0 and steps while running');
      check(!regressed, 'progress.completed must not decrease within an attempt');
      if (runningAt !== undefined && completedAt !== undefined) {
        const ran = completedAt - runningAt;
        check(ran >= steps * MIN_STEP_MS - 150, `${steps} steps finished in ${ran} ms; each step must take at least ${MIN_STEP_MS} ms`);
      }
    },
  },

  // ---- A4: validation
  invalid('A4.missing-input', 'Missing input is rejected', { steps: 4 }, ['input']),
  invalid('A4.empty-input', 'Empty input is rejected', { input: '' }, ['input']),
  invalid('A4.whitespace-input', 'Whitespace-only input is rejected', { input: '\t  \n ' }, ['input']),
  invalid('A4.input-too-long', 'Input longer than 1000 characters is rejected', { input: 'Ω'.repeat(1001) }, ['input']),
  invalid('A4.input-not-string', 'Non-string input is rejected', { input: 42 }, ['input']),
  invalid('A4.steps-above-max', 'steps above 20 is rejected', (d: EvalData) => ({ input: d.validInput, steps: 21 }), ['steps']),
  invalid('A4.steps-zero', 'steps of 0 is rejected', (d: EvalData) => ({ input: d.validInput, steps: 0 }), ['steps']),
  invalid('A4.steps-fraction', 'Non-integer steps is rejected', (d: EvalData) => ({ input: d.validInput, steps: 2.5 }), ['steps']),
  invalid('A4.steps-numeric-string', 'Numeric-string steps is rejected', (d: EvalData) => ({ input: d.validInput, steps: '4' }), ['steps']),
  // No null case: the brief does not say whether null means "omitted", so it is not tested.
  invalid('A4.fail-attempts-negative', 'Negative failAttempts is rejected', (d: EvalData) => ({ input: d.validInput, failAttempts: -1 }), ['failAttempts']),
  invalid('A4.fail-attempts-above-max', 'failAttempts above 5 is rejected', (d: EvalData) => ({ input: d.validInput, failAttempts: 6 }), ['failAttempts']),
  invalid('A4.fail-attempts-string', 'Numeric-string failAttempts is rejected', (d: EvalData) => ({ input: d.validInput, failAttempts: '1' }), ['failAttempts']),
  invalid('A4.unknown-field', 'Unknown fields are rejected and named', (d: EvalData) => ({ input: d.validInput, priority: 'high' }), ['priority']),
  invalid('A4.every-offending-field', 'Every offending field is listed', { input: '', steps: 99, failAttempts: 9 }, ['input', 'steps', 'failAttempts']),
  invalid('A4.malformed-json', 'Malformed JSON is rejected as "body"', '{"input": "unterminated', ['body']),
  invalid('A4.array-body', 'An array body is rejected as "body"', '["input"]', ['body']),
  invalid('A4.null-body', 'A null body is rejected as "body"', 'null', ['body']),
  {
    id: 'A4.missing-content-type',
    behaviour: 'A4',
    title: 'A submission without Content-Type is rejected',
    run: (ctx) =>
      expectInvalid(ctx, () => ctx.http.request({ method: 'POST', path: '/api/jobs', body: JSON.stringify({ input: ctx.data.validInput }) }), []),
  },
  {
    id: 'A4.non-json-content-type',
    behaviour: 'A4',
    title: 'A text/plain submission is rejected',
    run: (ctx) =>
      expectInvalid(
        ctx,
        () => ctx.http.request({ method: 'POST', path: '/api/jobs', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ input: ctx.data.validInput }) }),
        [],
      ),
  },
  invalid('A4.idempotency-key-charset', 'An Idempotency-Key with invalid characters is rejected', (d: EvalData) => ({ input: d.validInput }), ['Idempotency-Key'], { 'idempotency-key': 'not valid!' }),
  invalid('A4.idempotency-key-length', 'An Idempotency-Key longer than 128 characters is rejected', (d: EvalData) => ({ input: d.validInput }), ['Idempotency-Key'], { 'idempotency-key': 'k'.repeat(129) }),
  {
    id: 'A4.boundaries-accepted',
    behaviour: 'A4',
    title: 'Boundary values (1000-character input, steps 1 and 20, failAttempts 0 and 5) are accepted',
    run: async (ctx) => {
      check(ctx.data.longInput.length === 1000, 'evaluator data error: long input must be 1000 characters');
      await createJob(ctx, { input: ctx.data.longInput, steps: 20, failAttempts: 5 });
      await createJob(ctx, { input: 'z', steps: 1, failAttempts: 0 });
    },
  },

  // ---- A5: idempotency
  {
    id: 'A5.replay-same-payload',
    behaviour: 'A5',
    title: 'Same key and same payload (explicit defaults, different key order) returns 200 with the original job',
    run: async (ctx) => {
      const key = ctx.data.keys.replay;
      const before = await countJobs(ctx);
      const { ref, job } = await createJob(ctx, { input: ctx.data.idemInput, steps: 1 }, { 'idempotency-key': key });
      ctx.state.replayJob = { ...ref, createdAt: job.createdAt };
      const r = await post(ctx, { failAttempts: 0, steps: 1, input: ctx.data.idemInput }, { 'idempotency-key': key });
      check(r.status === 200, `replay: expected 200, observed ${brief(r)}`);
      expectJson(r, 'replay');
      check(isObject(r.json) && sameJob(ctx.state.replayJob, r.json), 'replay must return the original job');
      checkEqual(await countJobs(ctx), before + 1, 'job count');
    },
  },
  {
    id: 'A5.conflict-different-input',
    behaviour: 'A5',
    title: 'Same key with a different input returns 409 idempotency_conflict and creates no job',
    run: async (ctx) => {
      const before = await countJobs(ctx);
      const r = await post(ctx, { input: ctx.data.idemOtherInput, steps: 1 }, { 'idempotency-key': ctx.data.keys.replay });
      check(r.status === 409, `expected 409, observed ${brief(r)}`);
      expectJson(r, '409');
      const problems = errorProblems(r.json, 'idempotency_conflict');
      check(problems.length === 0, problems.join('; '));
      checkEqual(await countJobs(ctx), before, 'job count');
    },
  },
  {
    id: 'A5.conflict-different-steps',
    behaviour: 'A5',
    title: 'Same key with different steps returns 409 and creates no job',
    run: async (ctx) => {
      const before = await countJobs(ctx);
      const r = await post(ctx, { input: ctx.data.idemInput, steps: 2 }, { 'idempotency-key': ctx.data.keys.replay });
      check(r.status === 409, `expected 409, observed ${brief(r)}`);
      checkEqual(await countJobs(ctx), before, 'job count');
    },
  },
  {
    id: 'A5.defaults-equivalent',
    behaviour: 'A5',
    title: 'A payload relying on defaults and one stating them are the same payload',
    run: async (ctx) => {
      const key = ctx.data.keys.defaults;
      const { ref, job } = await createJob(ctx, { input: ctx.data.defaultsKeyInput }, { 'idempotency-key': key });
      const r = await post(ctx, { input: ctx.data.defaultsKeyInput, steps: 5, failAttempts: 0 }, { 'idempotency-key': key });
      check(r.status === 200, `expected 200, observed ${brief(r)}`);
      check(isObject(r.json) && sameJob({ ...ref, createdAt: job.createdAt }, r.json), 'must return the original job');
    },
  },
  {
    id: 'A5.concurrent-same-key',
    behaviour: 'A5',
    title: 'Five concurrent submissions with one new key create exactly one job',
    run: async (ctx) => {
      const before = await countJobs(ctx);
      const rs = await Promise.all(
        Array.from({ length: 5 }, () => post(ctx, { input: ctx.data.concurrentInput, steps: 1 }, { 'idempotency-key': ctx.data.keys.concurrent })),
      );
      const statuses = rs.map((r) => r.status);
      check(statuses.every((s) => s === 200 || s === 201), `statuses must be 200 or 201 (observed ${statuses.join(', ')})`);
      checkEqual(statuses.filter((s) => s === 201).length, 1, 'number of 201 responses');
      checkEqual(await countJobs(ctx), before + 1, 'job count');
      const ids = new Set(rs.map((r) => (isObject(r.json) ? r.json.id : undefined)));
      checkEqual(ids.size, 1, 'distinct job ids returned');
    },
  },
  {
    id: 'A5.no-key-always-creates',
    behaviour: 'A5',
    title: 'Identical submissions without a key create two jobs',
    run: async (ctx) => {
      const before = await countJobs(ctx);
      const a = await createJob(ctx, { input: ctx.data.noKeyInput, steps: 1 });
      const b = await createJob(ctx, { input: ctx.data.noKeyInput, steps: 1 });
      if (a.ref.id !== undefined || b.ref.id !== undefined) check(a.ref.id !== b.ref.id, 'the two jobs must have different ids');
      checkEqual(await countJobs(ctx), before + 2, 'job count');
    },
  },

  // ---- A6: transient failures
  {
    id: 'A6.retried-to-completion',
    behaviour: 'A6',
    title: 'failAttempts 2 completes on attempt 3, returns to queued between attempts, with one job and one result',
    run: async (ctx) => {
      await waitIdle(ctx, jobWindowMs(5) * 4);
      const before = await countJobs(ctx);
      const { ref } = await createJob(ctx, { input: ctx.data.retryInput, steps: 2, failAttempts: 2 });
      let requeued = false;
      let lastAttempts = 0;
      let attemptsRegressed = false;
      const job = await waitTerminal(ctx, ref, jobWindowMs(2, 2), (j) => {
        const attempts = Number(j.attempts);
        if (attempts < lastAttempts) attemptsRegressed = true;
        lastAttempts = Math.max(lastAttempts, attempts);
        if (j.status === 'queued' && attempts >= 1) requeued = true;
      });
      expectCompleted(job, ctx.data.retryInput, 2, 'retried job');
      checkEqual(job.attempts, 3, 'attempts');
      check(requeued, 'the job must return to queued while waiting to retry');
      check(!attemptsRegressed, 'attempts must never decrease');
      const jobs = await listJobs(ctx);
      checkEqual(jobs.length, before + 1, 'job count');
      checkEqual(jobs.filter((j) => j.input === ctx.data.retryInput).length, 1, 'jobs with the retried input');
    },
  },
  {
    id: 'A6.exhausted-fails',
    behaviour: 'A6',
    title: 'failAttempts 3 ends failed with error "transient failure", null result, attempts 3, and is not reprocessed',
    run: async (ctx) => {
      const { ref } = await createJob(ctx, { input: ctx.data.exhaustInput, steps: 1, failAttempts: 3 });
      const job = await waitTerminal(ctx, ref, jobWindowMs(1, 2) + 2 * MAX_STEP_MS);
      expectShape(job, 'failed job');
      checkEqual(job.status, 'failed', 'status');
      checkEqual(job.error, 'transient failure', 'error');
      checkEqual(job.result, null, 'result');
      checkEqual(job.attempts, 3, 'attempts');
      await ctx.clock.sleep(MAX_RETRY_DELAY_MS);
      const later = await fetchJob(ctx, ref);
      checkEqual(later.status, 'failed', 'status after waiting');
      checkEqual(later.attempts, 3, 'attempts after waiting');
    },
  },

  // ---- A8 (and A3 through the UI): browser
  {
    id: 'A8.page-structure',
    behaviour: 'A8',
    title: 'GET / serves HTML with every required data-testid; form-error has role="alert" and starts empty',
    run: async (ctx) => {
      const r = await ctx.http.request({ method: 'GET', path: '/' });
      checkEqual(r.status, 200, 'GET / status');
      check(/^text\/html/i.test(r.contentType), `GET / Content-Type must be text/html (got ${JSON.stringify(r.contentType)})`);
      const page = await ctx.page();
      const missing = await page.missingTestIds(['job-form', 'job-input', 'job-steps', 'job-fail-attempts', 'job-submit', 'form-error', 'job-list']);
      check(missing.length === 0, `missing data-testid elements: ${missing.join(', ')}`);
      checkEqual(await page.attribute('form-error', 'role'), 'alert', 'form-error role');
      checkEqual(await page.text('form-error'), '', 'initial form-error text');
    },
  },
  {
    id: 'A8.submit-through-form',
    behaviour: 'A8',
    title: 'Submitting the form creates exactly one job with numeric steps and failAttempts',
    run: async (ctx) => {
      const page = await ctx.page();
      const before = await countJobs(ctx);
      await uiSubmit(page, ctx.data.uiInput, '2', '0');
      const job = await waitFor(ctx.deadline, 'the submitted job to appear in GET /api/jobs', 5_000, async () =>
        (await listJobs(ctx)).find((j) => j.input === ctx.data.uiInput),
      );
      ctx.state.uiJob = refOf(job, ctx.data.uiInput);
      checkEqual(job.steps, 2, 'steps');
      checkEqual(job.failAttempts, 0, 'failAttempts');
      checkEqual(await countJobs(ctx), before + 1, 'job count');
      checkEqual(await page.text('form-error'), '', 'form-error after a successful submission');
    },
  },
  {
    id: 'A3.ui-shows-result',
    behaviour: 'A3',
    title: 'The UI shows a completed job\'s status, progress and output without a reload',
    run: async (ctx) => {
      const ref = ctx.state.uiJob;
      check(ref !== undefined, 'prerequisite failed: no job was submitted through the UI');
      check(ref.id !== undefined, 'the submitted job has no id to find in the UI');
      await waitTerminal(ctx, ref, jobWindowMs(2) * 2);
      const expected = ctx.data.uiInput.toUpperCase();
      await waitUiItem(ctx, ref.id, `job-item ${ref.id} showing completed 2/2 ${expected}`, UI_REFRESH_MS + SLACK_MS, (i) =>
        i.status === 'completed' && i.progress === '2/2' && i.result === expected,
      );
    },
  },
  {
    id: 'A8.live-updates',
    behaviour: 'A8',
    title: 'A job created elsewhere appears in the UI and its completion is reflected within 2 s, without a reload',
    run: async (ctx) => {
      await ctx.page();
      const { ref } = await createJob(ctx, { input: ctx.data.liveInput, steps: 8, failAttempts: 0 });
      check(ref.id !== undefined, 'the job has no id to find in the UI');
      await waitUiItem(ctx, ref.id, `job-item ${ref.id} to appear`, UI_REFRESH_MS + SLACK_MS, () => true);
      await waitTerminal(ctx, ref, jobWindowMs(8) * 2);
      await waitUiItem(ctx, ref.id, `job-item ${ref.id} showing completed`, UI_REFRESH_MS + SLACK_MS, (i) =>
        i.status === 'completed' && i.progress === '8/8',
      );
    },
  },
  {
    id: 'A8.list-newest-first',
    behaviour: 'A8',
    title: 'The UI lists jobs newest first, matching GET /api/jobs',
    run: async (ctx) => {
      const page = await ctx.page();
      await waitIdle(ctx, jobWindowMs(5) * 2);
      const apiIds = (await listJobs(ctx)).slice(0, 5).map((j) => j.id);
      await waitFor(ctx.deadline, `job-list order ${JSON.stringify(apiIds)}`, UI_REFRESH_MS + SLACK_MS, async () => {
        const ids = (await page.jobItems()).slice(0, apiIds.length).map((i) => i.id);
        return JSON.stringify(ids) === JSON.stringify(apiIds) ? true : undefined;
      }, 100);
    },
  },
  {
    id: 'A8.validation-error-shown',
    behaviour: 'A8',
    title: 'A rejected submission shows the offending field in form-error and creates no job',
    run: async (ctx) => {
      const page = await ctx.page();
      const before = await countJobs(ctx);
      await uiSubmit(page, '   ', '3', '0');
      await waitFor(ctx.deadline, 'form-error to name the "input" field', 3_000, async () =>
        /input/i.test(await page.text('form-error')) ? true : undefined,
      100);
      checkEqual(await page.attribute('form-error', 'role'), 'alert', 'form-error role');
      await ctx.clock.sleep(300);
      checkEqual(await countJobs(ctx), before, 'job count');
    },
  },
  {
    id: 'A8.error-cleared-after-success',
    behaviour: 'A8',
    title: 'form-error is empty again after a later successful submission',
    run: async (ctx) => {
      const page = await ctx.page();
      await uiSubmit(page, ctx.data.uiAfterErrorInput, '1', '0');
      await waitFor(ctx.deadline, 'the job to be created', 5_000, async () =>
        (await listJobs(ctx)).some((j) => j.input === ctx.data.uiAfterErrorInput) ? true : undefined,
      );
      await waitFor(ctx.deadline, 'form-error to be empty', 3_000, async () => ((await page.text('form-error')) === '' ? true : undefined), 100);
    },
  },

  // ---- A7: durability across a crash (with A1 worker-loss and A5 key-persistence checks)
  {
    id: 'A7.kill-during-processing',
    behaviour: 'A7',
    title: 'Setup: a job is running when the worker is killed with SIGKILL, with another job queued behind it',
    run: async (ctx) => {
      await waitIdle(ctx, jobWindowMs(5) * 4);
      const listed = await listJobs(ctx);
      const ids = identities(listed);
      const before: Snapshot[] = listed.map((j, i) => ({
        id: ids[i]!,
        status: j.status,
        attempts: j.attempts,
        updatedAt: j.updatedAt,
        result: JSON.stringify(j.result ?? null),
        error: j.error,
      }));
      const inflight = (await createJob(ctx, { input: ctx.data.inflightInput, steps: 15, failAttempts: 0 })).ref;
      const queued = (await createJob(ctx, { input: ctx.data.queuedInput, steps: 1, failAttempts: 0 })).ref;
      ctx.state.restart = { before, inflight, queued };
      await waitFor(ctx.deadline, 'the long job to be running with progress', jobWindowMs(3), async () => {
        const j = await fetchJob(ctx, inflight);
        return j.status === 'running' && isObject(j.progress) && Number(j.progress.completed) >= 2 ? true : undefined;
      });
      await ctx.app.signal('worker', 'SIGKILL');
      check(await ctx.app.waitForExit('worker', SHUTDOWN_MS), 'worker did not exit after SIGKILL');
    },
  },
  {
    id: 'A1.reports-worker-down',
    behaviour: 'A1',
    title: 'GET /health reports the worker "down" within 3 s of it dying',
    run: async (ctx) => {
      check(ctx.state.restart !== undefined, 'prerequisite failed: worker was not killed');
      await waitFor(ctx.deadline, 'health worker "down"', HEARTBEAT_STALE_MS + SLACK_MS * 2, async () =>
        (await health(ctx))?.worker === 'down' ? true : undefined,
      100);
    },
  },
  {
    id: 'A7.restart-after-sigkill',
    behaviour: 'A7',
    title: 'After SIGKILL of the server, both processes restart on the same DATABASE_PATH and the server answers GET /health',
    run: async (ctx) => {
      check(ctx.state.restart !== undefined, 'prerequisite failed: crash setup did not complete');
      await ctx.app.signal('server', 'SIGKILL');
      check(await ctx.app.waitForExit('server', SHUTDOWN_MS), 'server did not exit after SIGKILL');
      await startAndWaitHealthy(ctx);
    },
  },
  {
    id: 'A7.jobs-persist',
    behaviour: 'A7',
    title: 'Every job from before the crash is still listed after the restart',
    run: async (ctx) => {
      const r = ctx.state.restart;
      check(r !== undefined, 'prerequisite failed: crash setup did not complete');
      const jobs = await listJobs(ctx);
      const ids = new Set(identities(jobs));
      const missing = r.before.filter((s) => !ids.has(s.id)).map((s) => s.id);
      check(missing.length === 0, `jobs missing after restart: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
      for (const ref of [r.inflight, r.queued]) {
        check(jobs.some((j) => sameJob(ref, j)), `job ${JSON.stringify(ref.input)} missing after restart`);
      }
    },
  },
  {
    id: 'A7.inflight-resumed',
    behaviour: 'A7',
    title: 'The job running at the crash is processed again and completes within 10 s plus its processing time',
    run: async (ctx) => {
      const r = ctx.state.restart;
      check(r !== undefined, 'prerequisite failed: crash setup did not complete');
      const job = await waitTerminal(ctx, r.inflight, RECOVERY_MS + jobWindowMs(15));
      expectCompleted(job, ctx.data.inflightInput, 15, 'resumed job');
      check(Number(job.attempts) >= 2, `attempts must count the interrupted attempt (observed ${JSON.stringify(job.attempts)})`);
    },
  },
  {
    id: 'A7.queued-processed-after-restart',
    behaviour: 'A7',
    title: 'A job still queued at the crash is processed after the restart',
    run: async (ctx) => {
      const r = ctx.state.restart;
      check(r !== undefined, 'prerequisite failed: crash setup did not complete');
      const job = await waitTerminal(ctx, r.queued, RECOVERY_MS + jobWindowMs(15) + jobWindowMs(1));
      expectCompleted(job, ctx.data.queuedInput, 1, 'queued job');
    },
  },
  {
    id: 'A7.finished-jobs-not-reprocessed',
    behaviour: 'A7',
    title: 'Completed and failed jobs keep their status, attempts, result and updatedAt across the restart',
    run: async (ctx) => {
      const r = ctx.state.restart;
      check(r !== undefined, 'prerequisite failed: crash setup did not complete');
      const listed = await listJobs(ctx);
      const ids = identities(listed);
      const now = new Map(listed.map((j, i) => [ids[i]!, j]));
      const changed: string[] = [];
      for (const s of r.before.filter((b) => TERMINAL.has(b.status as string))) {
        const j = now.get(s.id);
        if (!j) continue; // reported by A7.jobs-persist
        const same =
          j.status === s.status && j.attempts === s.attempts && j.updatedAt === s.updatedAt && JSON.stringify(j.result ?? null) === s.result && j.error === s.error;
        if (!same) changed.push(s.id);
      }
      check(changed.length === 0, `finished jobs changed after restart: ${changed.slice(0, 5).join(', ')}`);
    },
  },
  {
    id: 'A5.key-survives-restart',
    behaviour: 'A5',
    title: 'An idempotency key used before the restart still replays the same job afterwards',
    run: async (ctx) => {
      const original = ctx.state.replayJob;
      check(original !== undefined, 'prerequisite failed: no keyed job was created');
      const before = await countJobs(ctx);
      const r = await post(ctx, { input: ctx.data.idemInput, steps: 1 }, { 'idempotency-key': ctx.data.keys.replay });
      check(r.status === 200, `expected 200, observed ${brief(r)}`);
      check(isObject(r.json) && sameJob(original, r.json), 'must return the original job');
      checkEqual(await countJobs(ctx), before, 'job count');
    },
  },

  // ---- A1: shutdown (last; stops the app)
  {
    id: 'A1.clean-sigterm-shutdown',
    behaviour: 'A1',
    title: 'Server and worker exit within 5 s of SIGTERM',
    run: async (ctx) => {
      check((await health(ctx)) !== undefined, 'prerequisite failed: the server is not answering GET /health');
      await ctx.app.signal('server', 'SIGTERM');
      await ctx.app.signal('worker', 'SIGTERM');
      const [server, worker] = await Promise.all([ctx.app.waitForExit('server', SHUTDOWN_MS), ctx.app.waitForExit('worker', SHUTDOWN_MS)]);
      check(server, 'server did not exit within 5 s of SIGTERM');
      check(worker, 'worker did not exit within 5 s of SIGTERM');
    },
  },
];
