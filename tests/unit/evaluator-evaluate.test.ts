import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { join } from 'node:path';
import { BENCHMARK_ROOT } from '../../src/fixtures.ts';
import { evaluateSnapshot, hiddenRoots, publicPath, scrubPaths, VERDICT_SCHEMA, type EvaluateDeps } from '../../src/evaluator/evaluate.ts';
import { CASES } from '../../src/evaluator/cases.ts';
import { InfrastructureError } from '../../src/evaluator/expect.ts';
import { selectSandbox } from '../../src/evaluator/sandbox.ts';
import type { PreparedWorkspace } from '../../src/evaluator/workspace.ts';
import { createSimulation, type SimFault } from './support/sim-app.ts';

const WORK = join(BENCHMARK_ROOT, '.runs', 'unit-tmp', 'evaluate-test');
const ready = (appDir: string): PreparedWorkspace => ({
  status: 'ready',
  appDir,
  snapshotHash: 'a'.repeat(64),
  snapshotFiles: 12,
  snapshotBytes: 3456,
  ignored: [],
  fixedChanges: [{ path: 'package.json', change: 'modified' }],
});

function deps(faults: SimFault[] = [], over: Partial<EvaluateDeps> = {}) {
  const sim = createSimulation(faults);
  const calls: string[] = [];
  let hash = 0;
  const d: EvaluateDeps = {
    clock: sim.clock,
    wallClock: () => new Date(Date.UTC(2026, 10, 14, 0, 0, 0) + sim.clock.now() - Date.UTC(2026, 10, 14)),
    sourceHash: () => `hash-${hash}`,
    sandbox: (mode, paths) => selectSandbox(mode, 'linux', () => undefined, paths),
    prepare: (_s, _sc, work) => (calls.push('prepare'), ready(join(work, 'app'))),
    build: async () => (calls.push('build'), { ok: true, exitCode: 0, timedOut: false, durationMs: 900, output: [] }),
    app: () => Object.assign(sim.app, { killAll: async () => void calls.push('killAll'), output: () => [`${WORK}/app/dist/server.js: listening`] }),
    http: () => sim.http,
    browser: () => ({ ...sim.browser, close: async () => void calls.push('closeBrowser') }),
    discard: () => void calls.push('discard'),
    cases: CASES,
    ...over,
  };
  return { d, calls, bumpHash: () => (hash += 1) };
}

const opts = { snapshotDir: join(BENCHMARK_ROOT, '.runs', 'unit-tmp', 'snapshot'), workDir: WORK, isolation: 'auto' as const, nonce: 'feedface' };

describe('evaluateSnapshot', () => {
  it('passes a correct app and records evidence without absolute host paths', async () => {
    const { d, calls } = deps();
    const v = await evaluateSnapshot(opts, d);
    expect(v.schema).toBe(VERDICT_SCHEMA);
    expect(v.status).toBe('passed');
    expect(v.totalCases).toBe(CASES.length);
    expect(v.snapshot).toMatchObject({ path: '.runs/unit-tmp/snapshot', hash: 'a'.repeat(64), fixedFileChanges: [{ path: 'package.json', change: 'modified' }] });
    expect(v.isolation).toMatchObject({ mechanism: 'none', writable: ['.runs/unit-tmp/evaluate-test'] });
    expect(v.nonce).toBe('feedface');
    expect(v.appOutput.server).toEqual(['<workspace>/app/dist/server.js: listening']);
    expect(calls).toEqual(['prepare', 'build', 'closeBrowser', 'killAll', 'discard']);
    expect(JSON.stringify(v)).not.toContain(BENCHMARK_ROOT);
  });

  it('rejects a broken app on its behaviour', async () => {
    const v = await evaluateSnapshot(opts, deps(['A6-no-retry']).d);
    expect(v.status).toBe('failed');
    expect(v.reason).toBe('cases-failed');
    expect(v.behaviours.A6.passed).toBe(false);
    expect(v.behaviours.A2.passed).toBe(true);
  });

  it('rejects missing output without building or running anything', async () => {
    const { d, calls } = deps([], { prepare: (_s, _sc, work) => ({ ...ready(join(work, 'app')), status: 'missing-output', snapshotHash: null }) });
    const v = await evaluateSnapshot(opts, d);
    expect(v.status).toBe('failed');
    expect(v.reason).toBe('missing-output');
    expect(calls).toEqual([]);
  });

  it('rejects a build failure as app-caused', async () => {
    const { d, calls } = deps([], { build: async () => ({ ok: false, exitCode: 2, timedOut: false, durationMs: 3000, output: [`${WORK}/app/src/a.ts(1,1): error TS1005`] }) });
    const v = await evaluateSnapshot(opts, d);
    expect(v.status).toBe('failed');
    expect(v.reason).toBe('build-failed');
    expect(v.build?.output).toEqual(['<workspace>/app/src/a.ts(1,1): error TS1005']);
    expect(calls).toEqual(['prepare', 'discard']);
  });

  it('is operational when protected inputs are unavailable or isolation is required but missing', async () => {
    const missing = await evaluateSnapshot(opts, deps([], { prepare: () => { throw new InfrastructureError('protected scaffold dependencies are not installed'); } }).d);
    expect(missing.status).toBe('infrastructure-failure');
    const noSandbox = await evaluateSnapshot({ ...opts, isolation: 'required' }, deps().d);
    expect(noSandbox.status).toBe('infrastructure-failure');
    expect(noSandbox.reason).toMatch(/no supported sandbox/);
  });

  it('is operational when the evaluator sources change during evaluation', async () => {
    const { d, bumpHash } = deps();
    const build = d.build;
    d.build = async (o) => (bumpHash(), build(o));
    const v = await evaluateSnapshot(opts, d);
    expect(v.status).toBe('infrastructure-failure');
    expect(v.reason).toBe('evaluator sources changed during evaluation');
  });

  it('refuses a work directory inside the snapshot', async () => {
    const v = await evaluateSnapshot({ ...opts, workDir: join(opts.snapshotDir, 'eval') }, deps().d);
    expect(v.status).toBe('infrastructure-failure');
  });
});

describe('path privacy helpers', () => {
  const root = '/w/repo/.worktrees/x/examples/bench';
  it('reduces host paths to benchmark-relative or placeholder form', () => {
    expect(publicPath('/w/repo/.worktrees/x/examples/bench/.runs/a', root, '/home/me')).toBe('.runs/a');
    expect(publicPath('/w/repo/.worktrees/x', root, '/home/me')).toBe('../..');
    expect(publicPath('/home/me/.ssh', root, '/home/me')).toBe('~/.ssh');
    expect(publicPath('/etc/passwd', root, '/home/me')).toBe('<outside worktree>');
  });

  const gitAt = (...dirs: string[]) => (p: string) => dirs.includes(p);

  it('hides the worktree, the checkout that contains it, and the home directory', () => {
    expect(hiddenRoots(root, '/home/me', gitAt('/w/repo/.worktrees/x'))).toEqual(['/w/repo/.worktrees/x', '/w/repo', '/home/me']);
  });

  it('hides a standalone clone, where the benchmark is the repository root', () => {
    expect(hiddenRoots('/srv/hb', '/home/me', gitAt('/srv/hb'))).toEqual(['/srv/hb', '/home/me']);
  });

  it('hides only the benchmark itself when no repository contains it', () => {
    expect(hiddenRoots('/work', '/home/me', gitAt())).toEqual(['/work', '/home/me']);
    expect(hiddenRoots('/work/repo/examples/harness-benchmark', '/home/me', gitAt())).toEqual(['/work/repo/examples/harness-benchmark', '/home/me']);
  });

  it('refuses to hide the filesystem root, which would hide node and npm from the app', () => {
    expect(() => hiddenRoots('/srv/hb', '/', gitAt('/srv/hb'))).toThrow(InfrastructureError);
    expect(() => hiddenRoots('/hb', '/home/me', gitAt('/'))).toThrow(/filesystem root/);
  });

  describe('properties', () => {
    const seg = fc.stringMatching(/^[a-z]{1,6}$/);
    const absPath = fc.array(seg, { minLength: 1, maxLength: 5 }).map((s) => `/${s.join('/')}`);
    it('never hides "/" and always hides the benchmark or a directory containing it', () => {
      fc.assert(
        fc.property(absPath, fc.array(absPath, { maxLength: 3 }), (bench, gits) => {
          const roots = hiddenRoots(bench, '/home/me', gitAt(...gits));
          expect(roots).not.toContain('/');
          expect(roots.some((r) => bench === r || bench.startsWith(`${r}/`))).toBe(true);
        }),
      );
    });
  });

  it('scrubs the longest matching prefix first', () => {
    expect(scrubPaths(['/a/b/c and /a/x'], { '/a': '<A>', '/a/b': '<B>' })).toEqual(['<B>/c and <A>/x']);
  });

  it('never leaves a replaced path in scrubbed output', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.stringMatching(/^\/[a-z]{2,8}(\/[a-z]{1,8}){0,3}$/), (lines, path) => {
        const out = scrubPaths(lines.map((l) => `${l}${path}${l}`), { [path]: '<P>' });
        for (const l of out) expect(l.includes(path)).toBe(false);
      }),
    );
  });
});
