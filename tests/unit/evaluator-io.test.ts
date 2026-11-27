import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { createHttpClient, parseJson } from '../../src/evaluator/http.ts';
import { AppUnreachable } from '../../src/evaluator/expect.ts';
import { AppProcesses, appEnv, runBuild, tail } from '../../src/evaluator/processes.ts';
import { selectSandbox } from '../../src/evaluator/sandbox.ts';
import { evaluatorCommand, parseVerdict, superviseEvaluation, SUPERVISOR_GRACE_MS } from '../../src/evaluator/supervise.ts';
import { VERDICT_SCHEMA } from '../../src/evaluator/evaluate.ts';

const noSandbox = selectSandbox('off', 'linux', () => undefined, { hidden: [], writable: [], readable: [] });

function fakeChild(pid = 4242) {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(child, { pid, stdout: new PassThrough(), stderr: new PassThrough() });
  return child;
}

// ------------------------------------------------------------------ HTTP client

function fakeRequest(respond: (opts: any, body: Buffer | undefined) => { status?: number; headers?: Record<string, string>; body?: string; error?: string; hang?: boolean }) {
  const seen: { url: string; opts: any; body?: Buffer }[] = [];
  const fn = (url: URL, opts: any, cb: (res: any) => void) => {
    const req = new EventEmitter() as any;
    req.destroy = vi.fn();
    req.end = (body?: Buffer) => {
      seen.push({ url: url.toString(), opts, body });
      const r = respond(opts, body);
      queueMicrotask(() => {
        if (r.error) return req.emit('error', new Error(r.error));
        if (r.hang) return req.emit('timeout');
        const res = new PassThrough() as any;
        res.statusCode = r.status ?? 200;
        res.headers = r.headers ?? {};
        cb(res);
        res.end(r.body ?? '');
      });
    };
    return req;
  };
  return { fn: fn as any, seen };
}

describe('createHttpClient', () => {
  it('sends exactly the given headers and body and parses JSON', async () => {
    const { fn, seen } = fakeRequest(() => ({ status: 201, headers: { 'content-type': 'application/json' }, body: '{"id":"x"}' }));
    const http = createHttpClient(() => 'http://127.0.0.1:9', fn);
    const r = await http.request({ method: 'POST', path: '/api/jobs', body: '{"input":"a"}' });
    expect(r).toEqual({ status: 201, contentType: 'application/json', text: '{"id":"x"}', json: { id: 'x' } });
    expect(seen[0]!.url).toBe('http://127.0.0.1:9/api/jobs');
    expect(seen[0]!.opts.headers).toEqual({ connection: 'close', 'content-length': 13 });
    expect(seen[0]!.opts.headers['content-type']).toBeUndefined();
  });

  it('turns transport errors and timeouts into AppUnreachable', async () => {
    const refused = createHttpClient(() => 'http://127.0.0.1:9', fakeRequest(() => ({ error: 'connect ECONNREFUSED' })).fn);
    await expect(refused.request({ method: 'GET', path: '/health' })).rejects.toBeInstanceOf(AppUnreachable);
    const hung = createHttpClient(() => 'http://127.0.0.1:9', fakeRequest(() => ({ hang: true })).fn, 10);
    await expect(hung.request({ method: 'GET', path: '/health' })).rejects.toThrow(/no response within 10 ms/);
  });

  it('parseJson never throws', () => {
    fc.assert(fc.property(fc.string(), (s) => void parseJson(s)));
    expect(parseJson('not json')).toBeUndefined();
  });
});

// ------------------------------------------------------------------ processes

describe('appEnv and tail', () => {
  it('builds the app environment from scratch', () => {
    const env = appEnv({ path: '/bin', workDir: '/w', port: 5, databasePath: '/w/app/state/jobs.db' });
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/w/home', TMPDIR: '/w/tmp', PORT: '5', DATABASE_PATH: '/w/app/state/jobs.db' });
    expect(Object.keys(env)).not.toContain('NODE_OPTIONS');
  });

  it('keeps the last lines and redacts likely secrets', () => {
    expect(tail('a\nb\nc\n', 2)).toEqual(['b', 'c']);
    expect(tail('API_KEY=abc123 token: xyz')).toEqual(['API_KEY=[redacted] token: [redacted]']);
  });

  it('tail never returns more than n bounded lines', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 50 }), (s, n) => {
        const t = tail(s, n);
        expect(t.length).toBeLessThanOrEqual(n);
        for (const l of t) expect(l.length).toBeLessThanOrEqual(500);
      }),
    );
  });
});

describe('AppProcesses', () => {
  const workDir = new URL('../../.runs/unit-tmp/processes', import.meta.url).pathname;

  it('starts both documented commands in their own process groups and signals the group', async () => {
    const children: ChildProcess[] = [];
    const spawned: { cmd: string; args: string[]; opts: any }[] = [];
    const kills: [number, string][] = [];
    const app = new AppProcesses({
      appDir: `${workDir}/app`,
      workDir,
      sandbox: noSandbox,
      path: '/bin',
      getPort: async () => 40001,
      spawn: (cmd, args, opts) => {
        spawned.push({ cmd, args, opts });
        const c = fakeChild(1000 + children.length);
        children.push(c);
        return c;
      },
      kill: (pid, sig) => void kills.push([pid, sig]),
    });
    await app.start();
    expect(spawned.map((s) => [s.cmd, ...s.args])).toEqual([
      ['npm', 'run', 'start:server'],
      ['npm', 'run', 'start:worker'],
    ]);
    expect(spawned[0]!.opts).toMatchObject({ detached: true, env: { PORT: '40001' } });
    expect(app.baseUrl()).toBe('http://127.0.0.1:40001');
    await app.signal('worker', 'SIGKILL');
    expect(kills).toEqual([[-1001, 'SIGKILL']]);
    expect(await app.waitForExit('worker', 5)).toBe(false);
    children[1]!.emit('exit', null, 'SIGKILL');
    expect(await app.waitForExit('worker', 5)).toBe(true);
    await app.signal('worker', 'SIGTERM');
    expect(kills).toHaveLength(1);
    children[0]!.emit('exit', 0, null);
    await app.killAll();
    expect(kills.slice(1)).toEqual([
      [-1000, 'SIGKILL'],
      [-1001, 'SIGKILL'],
    ]);
  });
});

describe('runBuild', () => {
  const workDir = new URL('../../.runs/unit-tmp/build', import.meta.url).pathname;

  it('reports success, failure output, and kills the group on timeout', async () => {
    const ok = runBuild({ appDir: workDir, workDir, sandbox: noSandbox, path: '/bin', timeoutMs: 1000, spawn: () => {
      const c = fakeChild();
      queueMicrotask(() => c.emit('close', 0));
      return c;
    } });
    expect((await ok).ok).toBe(true);

    const failed = await runBuild({ appDir: workDir, workDir, sandbox: noSandbox, path: '/bin', timeoutMs: 1000, spawn: () => {
      const c = fakeChild();
      queueMicrotask(() => {
        (c.stdout as PassThrough).write('src/a.ts(1,1): error TS1005\n');
        setTimeout(() => c.emit('close', 2), 5);
      });
      return c;
    } });
    expect(failed).toMatchObject({ ok: false, exitCode: 2, timedOut: false, output: ['src/a.ts(1,1): error TS1005'] });

    const kills: number[] = [];
    const slow = await runBuild({ appDir: workDir, workDir, sandbox: noSandbox, path: '/bin', timeoutMs: 5, kill: (pid) => {
      kills.push(pid);
    }, spawn: () => {
      const c = fakeChild(77);
      setTimeout(() => c.emit('close', null), 30);
      return c;
    } });
    expect(slow).toMatchObject({ ok: false, timedOut: true });
    expect(kills).toEqual([-77]);
  });
});

// ------------------------------------------------------------------ supervisor

describe('superviseEvaluation', () => {
  const o = { snapshotDir: '/s', workDir: '/w', verdictPath: '/v.json', isolation: 'required' as const, ceilingMs: 50 };
  const valid = JSON.stringify({ schema: VERDICT_SCHEMA, status: 'failed', cases: [], behaviours: {} });

  it('runs the CLI with explicit arguments and a minimal environment', async () => {
    const seen: any[] = [];
    const r = await superviseEvaluation(o, {
      env: { PATH: '/bin', HOME: '/h', NODE_OPTIONS: '--import evil', SECRET_TOKEN: 'x' },
      read: () => valid,
      spawn: (cmd, args, opts) => {
        seen.push({ cmd, args, opts });
        const c = fakeChild();
        queueMicrotask(() => c.emit('exit', 0));
        return c;
      },
    });
    expect(r.kind).toBe('verdict');
    expect(seen[0].args).toEqual(evaluatorCommand(o).args);
    expect(seen[0].opts.env).toEqual({ PATH: '/bin', HOME: '/h' });
  });

  it('is an infrastructure failure when the verdict is missing, invalid, or the child hangs', async () => {
    const exits = (read: () => string) =>
      superviseEvaluation(o, { read, spawn: () => {
        const c = fakeChild();
        queueMicrotask(() => c.emit('exit', 1));
        return c;
      } });
    expect((await exits(() => { throw new Error('ENOENT'); })).kind).toBe('infrastructure-failure');
    expect((await exits(() => '{"schema":"harness-benchmark/evaluation-crash@1","status":"infrastructure-failure"}')).kind).toBe('infrastructure-failure');

    vi.useFakeTimers();
    try {
      const kills: number[] = [];
      const child = fakeChild(9);
      const p = superviseEvaluation(o, { read: () => valid, spawn: () => child, kill: (pid) => {
        kills.push(pid);
        child.emit('exit', null);
      } });
      await vi.advanceTimersByTimeAsync(50 + SUPERVISOR_GRACE_MS);
      const r = await p;
      expect(r).toMatchObject({ kind: 'infrastructure-failure', timedOut: true });
      expect(kills).toEqual([-9]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('parseVerdict never throws and accepts only verdict documents', () => {
    fc.assert(fc.property(fc.string(), (s) => void parseVerdict(s)));
    expect(parseVerdict(valid)).toBeDefined();
    expect(parseVerdict('{"status":"passed"}')).toBeUndefined();
  });
});
