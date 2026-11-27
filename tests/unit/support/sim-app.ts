/**
 * In-process simulation of the job tracker on a virtual clock, for unit-testing the evaluator
 * without processes, sockets, or a browser. The HTTP side reuses the known-correct reference's
 * handler and store over an in-memory SQLite database; the worker is a step machine advanced by
 * the clock. Faults emulate each broken reference so discrimination can be checked per behaviour.
 */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openDatabase } from '../../../fixtures/references/correct/src/db.ts';
import { JobStore } from '../../../fixtures/references/correct/src/store.ts';
import { createHandler } from '../../../fixtures/references/correct/src/app.ts';
import { recoverInterrupted } from '../../../fixtures/references/correct/src/recovery.ts';
import { toJobJson } from '../../../fixtures/references/correct/src/jobjson.ts';
import { validateSubmission } from '../../../fixtures/references/correct/src/validate.ts';
import { AppUnreachable, InfrastructureError } from '../../../src/evaluator/expect.ts';
import type { AppControl, AppProcess, Clock, HttpClient, HttpRequest, HttpResponse, StopSignal, UiBrowser, UiJobItem, UiPage } from '../../../src/evaluator/types.ts';

export type SimFault =
  | 'A1-worker-never-healthy'
  | 'A2-job-response-missing-id'
  | 'A3-wrong-output'
  | 'A4-steps-unbounded'
  | 'A5-idempotency-ignores-payload'
  | 'A6-no-retry'
  | 'A7-no-crash-recovery'
  | 'A8-ui-hides-errors'
  | 'server-never-starts'
  | 'ignores-sigterm'
  | 'browser-unavailable';

const STEP_MS = 100;
const TICK_MS = 10;

export function createSimulation(faults: readonly SimFault[] = []) {
  const has = (f: SimFault) => faults.includes(f);
  const db = openDatabase(':memory:');
  const store = new JobStore(db);
  store.migrate();
  let t = Date.UTC(2026, 10, 14);
  const alive = { server: false, worker: false };
  let current: { id: string; steps: number; step: number; nextAt: number } | null = null;

  function advanceWorker(): void {
    if (!alive.worker) return;
    store.heartbeat(t);
    if (current === null) {
      const job = store.claimNext(t);
      if (!job) return;
      if (has('A7-no-crash-recovery')) db.prepare('UPDATE jobs SET lease_until = ? WHERE id = ?').run(t + 86_400_000, job.id);
      if (job.attempts <= job.failAttempts) {
        if (has('A6-no-retry')) {
          db.prepare("UPDATE jobs SET status = 'failed', error = 'transient failure', updated_at = ? WHERE id = ?").run(new Date(t).toISOString(), job.id);
        } else store.failAttempt(job.id, t, 'transient failure');
        return;
      }
      current = { id: job.id, steps: job.steps, step: 0, nextAt: t + STEP_MS };
      return;
    }
    if (t < current.nextAt) return;
    current.step += 1;
    store.progress(current.id, current.step, t);
    if (has('A7-no-crash-recovery')) db.prepare('UPDATE jobs SET lease_until = ? WHERE id = ?').run(t + 86_400_000, current.id);
    if (current.step >= current.steps) {
      const row = store.get(current.id)!;
      store.complete(current.id, has('A3-wrong-output') ? row.input : row.input.toUpperCase(), t);
      current = null;
    } else current.nextAt += STEP_MS;
  }

  const clock: Clock = {
    now: () => t,
    async sleep(ms: number) {
      const end = t + Math.max(0, ms);
      while (t < end) {
        t = Math.min(end, t + TICK_MS);
        advanceWorker();
      }
      await Promise.resolve();
    },
  };

  const handler = createHandler({ store, uiHtml: '<!doctype html><title>sim</title>', now: () => t });

  async function callHandler(req: HttpRequest): Promise<HttpResponse> {
    const headers = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const reply = { status: 0, contentType: '', text: '' };
    const incoming = Readable.from(req.body === undefined ? [] : [Buffer.from(req.body)]) as unknown as IncomingMessage;
    Object.assign(incoming, { method: req.method, url: req.path, headers });
    const fake = {
      headersSent: false,
      writeHead(status: number, h: Record<string, string>) {
        reply.status = status;
        reply.contentType = h['content-type'] ?? '';
        fake.headersSent = true;
        return fake;
      },
      end(chunk?: string) {
        reply.text = chunk ?? '';
      },
    };
    await handler(incoming, fake as unknown as ServerResponse);
    return { ...reply, json: parse(reply.text) };
  }

  const json = (status: number, body: unknown): HttpResponse => ({ status, contentType: 'application/json', text: JSON.stringify(body), json: body });

  async function faultyRequest(req: HttpRequest): Promise<HttpResponse> {
    const key = Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === 'idempotency-key')?.[1];
    if (req.method === 'GET' && req.path === '/health' && has('A1-worker-never-healthy')) return json(200, { status: 'ok', worker: 'down' });
    if (req.method === 'POST' && req.path === '/api/jobs') {
      const body = parse(req.body ?? '');
      if (has('A5-idempotency-ignores-payload') && key !== undefined) {
        const row = db.prepare('SELECT id FROM jobs WHERE idempotency_key = ?').get(key) as { id: string } | undefined;
        if (row) return json(200, toJobJson(store.get(row.id)!));
      }
      if (has('A4-steps-unbounded') && body && typeof body === 'object' && Number.isInteger((body as { steps?: unknown }).steps)) {
        const steps = (body as { steps: number }).steps;
        if (steps > 20) {
          const v = validateSubmission({ ...(body as object), steps: 20 });
          if (v.ok) {
            const created = store.create({ ...v.value, steps }, key, t);
            if (created.kind !== 'conflict') return json(201, toJobJson(created.job));
          }
        }
      }
    }
    const res = await callHandler(req);
    if (has('A2-job-response-missing-id') && res.json && typeof res.json === 'object') {
      const strip = (j: unknown) => {
        if (j && typeof j === 'object' && 'status' in j) delete (j as { id?: unknown }).id;
      };
      const body = res.json as { jobs?: unknown[] };
      if (Array.isArray(body.jobs)) body.jobs.forEach(strip);
      else strip(body);
      res.text = JSON.stringify(body);
    }
    return res;
  }

  const http: HttpClient = {
    async request(req) {
      if (!alive.server) throw new AppUnreachable(`connect ECONNREFUSED (${req.method} ${req.path})`);
      return faultyRequest(req);
    },
  };

  const exited: Record<AppProcess, boolean> = { server: true, worker: true };
  const starts = { count: 0 };
  const app: AppControl = {
    async start() {
      starts.count += 1;
      if (!has('server-never-starts')) {
        alive.server = true;
        exited.server = false;
      }
      alive.worker = true;
      exited.worker = false;
      current = null;
      if (!has('A7-no-crash-recovery')) recoverInterrupted(db, t);
    },
    async signal(proc: AppProcess, signal: StopSignal) {
      if (signal === 'SIGTERM' && has('ignores-sigterm')) return;
      alive[proc] = false;
      exited[proc] = true;
      if (proc === 'worker') current = null;
    },
    async waitForExit(proc: AppProcess, timeoutMs: number) {
      if (exited[proc]) return true;
      await clock.sleep(timeoutMs);
      return exited[proc];
    },
    baseUrl: () => `http://sim.invalid:${starts.count}`,
  };

  const fields: Record<string, string> = { 'job-input': '', 'job-steps': '5', 'job-fail-attempts': '0' };
  let formError = '';
  const numberOrRaw = (v: string): unknown => (v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v);
  const page: UiPage = {
    async missingTestIds() {
      return [];
    },
    async attribute(testId, name) {
      return testId === 'form-error' && name === 'role' ? 'alert' : null;
    },
    async setField(testId, value) {
      fields[testId] = value;
    },
    async click(testId) {
      if (testId !== 'job-submit') return;
      formError = '';
      const res = await http.request({
        method: 'POST',
        path: '/api/jobs',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: fields['job-input'], steps: numberOrRaw(fields['job-steps']!), failAttempts: numberOrRaw(fields['job-fail-attempts']!) }),
      });
      if (res.status >= 400 && !has('A8-ui-hides-errors')) {
        const list = (res.json as { error?: { fields?: { field: string; message: string }[] } }).error?.fields ?? [];
        formError = list.map((f) => `${f.field}: ${f.message}`).join('; ') || 'Request failed';
      }
    },
    async text(testId) {
      return testId === 'form-error' ? formError : '';
    },
    async jobItems(): Promise<UiJobItem[]> {
      const res = await http.request({ method: 'GET', path: '/api/jobs' });
      return ((res.json as { jobs: Record<string, any>[] }).jobs ?? []).map((j) => ({
        id: typeof j.id === 'string' ? j.id : null,
        status: j.status,
        progress: `${j.progress.completed}/${j.progress.total}`,
        result: j.result ? j.result.output : (j.error ?? ''),
      }));
    },
  };
  const browser: UiBrowser = {
    async open() {
      if (has('browser-unavailable')) throw new InfrastructureError('chromium failed to launch');
      return page;
    },
    async close() {},
  };

  return { clock, http, app, browser, store, starts };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
