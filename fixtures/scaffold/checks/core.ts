/**
 * Shared machinery for the fixed build-time checks (`npm run check:smoke`, `npm run check:contract`).
 *
 * The checks use only the disclosed examples in this directory. Passing them does not mean the
 * task is complete: a separate, hidden evaluation with different cases decides acceptance.
 * Do not modify anything under checks/.
 */

export interface HttpRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  /** Sent verbatim. No Content-Type is added unless given in `headers`. */
  body?: string;
}

export interface HttpResponse {
  status: number;
  contentType: string;
  text: string;
  /** Parsed body, or undefined when the body is not valid JSON. */
  json: unknown;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface App {
  /** Starts the server and worker. Does not wait for readiness. */
  start(): Promise<void>;
}

export interface CheckContext {
  http: HttpClient;
  clock: Clock;
  /** Absolute clock time after which waits stop early. */
  deadlineAt: number;
}

export interface Check {
  name: string;
  title: string;
  run(ctx: CheckContext): Promise<void>;
}

export interface CheckResult {
  name: string;
  title: string;
  passed: boolean;
  /** Expected versus observed, for failures. */
  detail: string;
  durationMs: number;
}

export interface SuiteReport {
  schema: 'job-tracker/check-report@1';
  suite: string;
  passed: boolean;
  checks: CheckResult[];
  /** Last lines of each process's stderr, captured by the CLI runner. */
  stderr: { server: string[]; worker: string[] };
}

export class CheckFailure extends Error {
  override name = 'CheckFailure';
}

export function expect(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new CheckFailure(detail);
}

export function expectEqual(observed: unknown, expected: unknown, what: string): void {
  if (!Object.is(observed, expected)) {
    throw new CheckFailure(`${what}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`);
  }
}

/** Polls until `probe` returns a value other than undefined, or fails after `timeoutMs`. */
export async function waitFor<T>(ctx: CheckContext, what: string, timeoutMs: number, probe: () => Promise<T | undefined>, intervalMs = 100): Promise<T> {
  const until = Math.min(ctx.clock.now() + timeoutMs, ctx.deadlineAt);
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (e) {
      if (e instanceof CheckFailure) throw e;
      lastError = e;
    }
    const now = ctx.clock.now();
    if (now >= until) {
      const why = lastError instanceof Error ? ` (last error: ${lastError.message})` : '';
      throw new CheckFailure(`timed out after ${timeoutMs} ms waiting for ${what}${why}`);
    }
    await ctx.clock.sleep(Math.min(intervalMs, until - now));
  }
}

/** Runs every check in order; one failure never stops the others. */
export async function runChecks(checks: readonly Check[], ctx: CheckContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of checks) {
    const t0 = ctx.clock.now();
    let passed = true;
    let detail = '';
    if (ctx.clock.now() >= ctx.deadlineAt) {
      passed = false;
      detail = 'not run: check time limit reached';
    } else {
      try {
        await c.run(ctx);
      } catch (e) {
        passed = false;
        detail = e instanceof Error ? e.message : String(e);
      }
    }
    results.push({ name: c.name, title: c.title, passed, detail: clip(detail, 600), durationMs: Math.round(ctx.clock.now() - t0) });
  }
  return results;
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function describeResponse(r: HttpResponse): string {
  return `${r.status} ${clip(r.text, 300)}`;
}

export function expectJsonResponse(r: HttpResponse, status: number, what: string): Record<string, unknown> {
  expect(r.status === status, `${what}: expected status ${status}, observed ${describeResponse(r)}`);
  expect(/^application\/json\b/i.test(r.contentType), `${what}: expected Content-Type application/json, observed ${JSON.stringify(r.contentType)}`);
  expect(isObject(r.json), `${what}: expected a JSON object body, observed ${clip(r.text, 300)}`);
  return r.json;
}

export function postJson(ctx: CheckContext, body: unknown, headers: Record<string, string> = {}): Promise<HttpResponse> {
  return ctx.http.request({
    method: 'POST',
    path: '/api/jobs',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

export async function listJobs(ctx: CheckContext): Promise<Record<string, unknown>[]> {
  const body = expectJsonResponse(await ctx.http.request({ method: 'GET', path: '/api/jobs' }), 200, 'GET /api/jobs');
  expect(Array.isArray(body.jobs), `GET /api/jobs: expected {"jobs": [...]}, observed keys ${JSON.stringify(Object.keys(body))}`);
  return body.jobs.map((j) => (isObject(j) ? j : {}));
}

export async function getJob(ctx: CheckContext, id: string): Promise<Record<string, unknown>> {
  return expectJsonResponse(await ctx.http.request({ method: 'GET', path: `/api/jobs/${encodeURIComponent(id)}` }), 200, `GET /api/jobs/${id}`);
}

export function jobId(job: Record<string, unknown>, what: string): string {
  expect(typeof job.id === 'string' && job.id.length > 0, `${what}: expected a non-empty string "id", observed ${JSON.stringify(job.id)}`);
  return job.id;
}

/** Waits until the job leaves queued/running, then returns it. */
export function waitForFinished(ctx: CheckContext, id: string, timeoutMs: number): Promise<Record<string, unknown>> {
  return waitFor(ctx, `job ${id} to reach "completed" or "failed"`, timeoutMs, async () => {
    const job = await getJob(ctx, id);
    return job.status === 'completed' || job.status === 'failed' ? job : undefined;
  });
}

/** Waits for GET /health to answer 200 {"status":"ok"} (and, optionally, worker "up"). */
export async function waitForHealth(ctx: CheckContext, timeoutMs: number, workerUp: boolean): Promise<Record<string, unknown>> {
  const want = `GET /health to return 200 {"status":"ok"${workerUp ? ',"worker":"up"' : ''}}`;
  let last = 'no response';
  try {
    return await waitFor(ctx, want, timeoutMs, async () => {
      let r: HttpResponse;
      try {
        r = await ctx.http.request({ method: 'GET', path: '/health' });
      } catch (e) {
        last = `unreachable (${e instanceof Error ? e.message : String(e)})`;
        return undefined;
      }
      last = describeResponse(r);
      if (r.status !== 200 || !isObject(r.json) || r.json.status !== 'ok') return undefined;
      if (workerUp && r.json.worker !== 'up') return undefined;
      return r.json;
    });
  } catch {
    throw new CheckFailure(`timed out after ${timeoutMs} ms waiting for ${want}; last response: ${clip(last, 300)}`);
  }
}
