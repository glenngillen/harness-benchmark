/**
 * Runs one check suite against this repository's built app:
 *
 *   npm run build && npm run check:smoke
 *   npm run build && npm run check:contract
 *
 * It starts `npm run start:server` and `npm run start:worker` on a free port with a fresh database
 * under data/, runs the suite, stops both processes, prints the results, and exits 0 only if every
 * check passed. `--report <file>` also writes the results as JSON.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { CONTRACT_CHECKS } from './contract.ts';
import { SMOKE_CHECKS } from './smoke.ts';
import { runChecks, waitForHealth, type Check, type CheckContext, type Clock, type HttpClient, type SuiteReport } from './core.ts';

const SUITES: Record<string, { checks: readonly Check[]; budgetMs: number; waitForServer: boolean }> = {
  smoke: { checks: SMOKE_CHECKS, budgetMs: 30_000, waitForServer: false },
  contract: { checks: CONTRACT_CHECKS, budgetMs: 60_000, waitForServer: true },
};

const STDERR_LINES = 40;
const REQUEST_TIMEOUT_MS = 5_000;

export function parseArgs(argv: readonly string[]): { suite: string; report: string | undefined } {
  const [suite, ...rest] = argv;
  if (!suite || !(suite in SUITES)) throw new Error(`usage: cli.ts <${Object.keys(SUITES).join('|')}> [--report <file>]`);
  let report: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--report' && rest[i + 1]) report = rest[++i];
    else throw new Error(`unknown argument: ${rest[i]}`);
  }
  return { suite, report };
}

export function lastLines(text: string, n = STDERR_LINES): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-n).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
}

const clock: Clock = { now: () => performance.now(), sleep: async (ms) => void (await sleep(ms)) };

function httpClient(port: number): HttpClient {
  return {
    request: (req) =>
      new Promise((resolvePromise, reject) => {
        const body = req.body === undefined ? undefined : Buffer.from(req.body);
        const headers: Record<string, string | number> = { ...(req.headers ?? {}), connection: 'close' };
        if (body) headers['content-length'] = body.length;
        const r = request({ host: '127.0.0.1', port, path: req.path, method: req.method, headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json: unknown;
            try {
              json = JSON.parse(text);
            } catch {
              json = undefined;
            }
            const ct = res.headers['content-type'];
            resolvePromise({ status: res.statusCode ?? 0, contentType: Array.isArray(ct) ? ct.join(', ') : (ct ?? ''), text, json });
          });
          res.on('error', reject);
        });
        r.on('timeout', () => r.destroy(new Error(`no response within ${REQUEST_TIMEOUT_MS} ms`)));
        r.on('error', (e) => reject(new Error(`${req.method} ${req.path}: ${e.message}`)));
        r.end(body);
      }),
  };
}

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolvePromise(port));
    });
  });
}

function stopGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

async function main(): Promise<void> {
  const { suite, report } = parseArgs(process.argv.slice(2));
  const spec = SUITES[suite]!;
  const runDir = resolve('data', 'checks', `${suite}-${process.pid}-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), DATABASE_PATH: join(runDir, 'jobs.db') };
  const children: Record<'server' | 'worker', ChildProcess | undefined> = { server: undefined, worker: undefined };
  const stopAll = (signal: NodeJS.Signals) => Object.values(children).forEach((c) => c && stopGroup(c, signal));
  process.once('SIGTERM', () => (stopAll('SIGKILL'), process.exit(143)));
  process.once('SIGINT', () => (stopAll('SIGKILL'), process.exit(130)));

  for (const proc of ['server', 'worker'] as const) {
    const err = openSync(join(runDir, `${proc}.stderr.txt`), 'a');
    children[proc] = spawn('npm', ['run', '--silent', `start:${proc}`], { env, detached: true, stdio: ['ignore', 'ignore', err] });
    closeSync(err);
    children[proc].on('error', () => undefined);
  }

  const ctx: CheckContext = { http: httpClient(port), clock, deadlineAt: clock.now() + spec.budgetMs };
  if (spec.waitForServer) await waitForHealth(ctx, 10_000, false).catch(() => undefined);
  const checks = await runChecks(spec.checks, ctx);

  stopAll('SIGTERM');
  const exited = (c: ChildProcess | undefined) => (c && c.exitCode === null && c.signalCode === null ? new Promise((r) => c.once('exit', r)) : Promise.resolve());
  await Promise.race([Promise.all([exited(children.server), exited(children.worker)]), sleep(5_000)]);
  stopAll('SIGKILL');

  const stderr = (proc: string) => {
    try {
      return lastLines(readFileSync(join(runDir, `${proc}.stderr.txt`), 'utf8'));
    } catch {
      return [];
    }
  };
  const result: SuiteReport = {
    schema: 'job-tracker/check-report@1',
    suite,
    passed: checks.every((c) => c.passed),
    checks,
    stderr: { server: stderr('server'), worker: stderr('worker') },
  };
  for (const c of checks) console.log(`${c.passed ? 'PASS' : 'FAIL'} ${c.name}: ${c.title}${c.passed ? '' : `\n     ${c.detail}`}`);
  console.log(`${suite}: ${checks.filter((c) => c.passed).length}/${checks.length} checks passed`);
  if (report) writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(`check runner error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
}
