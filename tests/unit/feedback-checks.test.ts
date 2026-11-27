import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BENCHMARK_ROOT } from '../../src/fixtures.ts';
import { overallStatus, parseSuiteReport, runDeterministicChecks, type CheckRunDeps } from '../../src/feedback/checks.ts';
import { selectSandbox } from '../../src/evaluator/sandbox.ts';
import type { CommandResult } from '../../src/evaluator/processes.ts';
import type { PreparedWorkspace } from '../../src/evaluator/workspace.ts';

const TMP_ROOT = process.env.HARNESS_TEST_TMP ?? join(BENCHMARK_ROOT, '.runs', 'unit-tmp');
mkdirSync(TMP_ROOT, { recursive: true });
const made: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(TMP_ROOT, 'chk-'));
  made.push(d);
  return d;
};
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const report = (suite: string, checks: { name: string; passed: boolean; detail?: string }[], stderr = { server: ['s'], worker: ['w'] }) =>
  JSON.stringify({ schema: 'job-tracker/check-report@1', suite, passed: checks.every((c) => c.passed), checks: checks.map((c) => ({ title: 't', detail: '', ...c })), stderr });

const ok = (o: Partial<CommandResult> = {}): CommandResult => ({ ok: true, exitCode: 0, timedOut: false, durationMs: 100, output: [], ...o });

function fakeDeps(o: {
  prepare?: Partial<PreparedWorkspace>;
  results?: Record<string, CommandResult>;
  reports?: Record<string, string | undefined>;
  tickMs?: number;
}) {
  let t = 0;
  const calls: { argv: string[]; timeoutMs: number }[] = [];
  const discarded: string[] = [];
  const deps: CheckRunDeps = {
    now: () => t,
    wallClock: () => new Date(Date.UTC(2026, 10, 14)),
    sandbox: (mode, paths) => selectSandbox('off', 'linux', () => undefined, paths),
    prepare: (_w, _s, workDir) => ({ status: 'ready', appDir: join(workDir, 'app'), snapshotHash: 'abc', snapshotFiles: 3, snapshotBytes: 10, ignored: [], fixedChanges: [], ...o.prepare }),
    async run(r) {
      calls.push({ argv: r.argv, timeoutMs: r.timeoutMs });
      t += o.tickMs ?? 1_000;
      const key = r.label;
      return o.results?.[key] ?? ok();
    },
    readText: (p) => {
      const suite = p.endsWith('smoke.json') ? 'smoke' : 'contract';
      return o.reports && suite in o.reports ? o.reports[suite] : report(suite, [{ name: `${suite}.a`, passed: true }]);
    },
    discard: (d) => void discarded.push(d),
  };
  return { deps, calls, discarded };
}

const opts = () => {
  const root = tmp();
  return { workspaceDir: join(root, 'workspace'), workDir: join(root, 'check-1'), timeoutMs: 120_000, isolation: 'off' as const };
};

describe('runDeterministicChecks', () => {
  it('builds, then runs the protected smoke and contract suites with report paths, and passes', async () => {
    const f = fakeDeps({});
    const r = await runDeterministicChecks(opts(), f.deps);
    expect(r.status).toBe('passed');
    expect(r.suites.map((s) => [s.suite, s.status])).toEqual([['build', 'passed'], ['smoke', 'passed'], ['contract', 'passed']]);
    expect(f.calls.map((c) => c.argv.slice(0, 4))).toEqual([
      ['npm', 'run', 'build'],
      ['npm', 'run', '--silent', 'check:smoke'],
      ['npm', 'run', '--silent', 'check:contract'],
    ]);
    expect(f.calls[1]!.argv.slice(4, 6)).toEqual(['--', '--report']);
    expect(f.calls[0]!.timeoutMs).toBe(60_000);
    expect(f.calls[2]!.timeoutMs).toBe(118_000);
    expect(f.discarded).toHaveLength(1);
    expect(r).toMatchObject({ schema: 'harness-benchmark/check-run@1', snapshotHash: 'abc', ceilingMs: 120_000, reason: null });
  });

  it('records failing checks and stderr from a suite report', async () => {
    const f = fakeDeps({
      results: { 'check:contract': ok({ ok: false, exitCode: 1 }) },
      reports: { contract: report('contract', [{ name: 'contract.retry-transient', passed: false, detail: 'attempts: expected 2, observed 1' }], { server: [], worker: ['boom'] }) },
    });
    const r = await runDeterministicChecks(opts(), f.deps);
    expect(r.status).toBe('failed');
    expect(r.suites[2]).toMatchObject({ suite: 'contract', status: 'failed', stderr: { server: [], worker: ['boom'] } });
    expect(r.suites[2]!.checks[0]).toMatchObject({ name: 'contract.retry-transient', passed: false });
  });

  it('marks smoke and contract not run when the build fails, keeping the compiler output', async () => {
    const f = fakeDeps({ results: { build: ok({ ok: false, exitCode: 2, output: ['src/server.ts(1,1): error TS1005'] }) } });
    const r = await runDeterministicChecks(opts(), f.deps);
    expect(r.status).toBe('failed');
    expect(r.suites.map((s) => s.status)).toEqual(['failed', 'not-run', 'not-run']);
    expect(r.suites[0]!.output).toEqual(['src/server.ts(1,1): error TS1005']);
    expect(r.suites[0]!.checks[0]!.detail).toBe('npm run build exited with code 2');
    expect(f.calls).toHaveLength(1);
  });

  it('enforces one ceiling across build and suites', async () => {
    const f = fakeDeps({ tickMs: 70_000, results: { 'check:smoke': ok({ ok: false, exitCode: null, timedOut: true }) } });
    const r = await runDeterministicChecks(opts(), f.deps);
    expect(r.status).toBe('failed');
    expect(r.suites.map((s) => s.status)).toEqual(['passed', 'timed-out', 'timed-out']);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.timeoutMs).toBe(50_000);
  });

  it('treats a suite that exits without a valid report as runner infrastructure failure', async () => {
    const f = fakeDeps({ results: { 'check:smoke': ok({ ok: false, exitCode: 2, output: ['check runner error: listen EPERM'] }) }, reports: { smoke: undefined } });
    const r = await runDeterministicChecks(opts(), f.deps);
    expect(r.status).toBe('infrastructure-failure');
    expect(r.reason).toMatch(/check:smoke produced no valid report \(exit 2\).*EPERM/);
  });

  it('rejects a report that contradicts the suite exit code', async () => {
    const f = fakeDeps({ results: { 'check:contract': ok({ ok: false, exitCode: 1 }) } });
    const r = await runDeterministicChecks(opts(), f.deps);
    expect(r.status).toBe('infrastructure-failure');
  });

  it('fails the build check for an empty or oversized workspace without running anything', async () => {
    const f = fakeDeps({ prepare: { status: 'missing-output' } });
    const r = await runDeterministicChecks(opts(), f.deps);
    expect(r.status).toBe('failed');
    expect(r.suites[0]!.checks[0]!.detail).toMatch(/no files/);
    expect(f.calls).toHaveLength(0);
    const big = await runDeterministicChecks(opts(), fakeDeps({ prepare: { status: 'snapshot-too-large' } }).deps);
    expect(big.suites[0]!.checks[0]!.detail).toMatch(/5,000-file/);
  });

  it('records edits to protected files without honouring them', async () => {
    const f = fakeDeps({ prepare: { fixedChanges: [{ path: 'checks/contract.ts', change: 'modified' }] } });
    const r = await runDeterministicChecks(opts(), f.deps);
    expect(r.fixedFileChanges).toEqual([{ path: 'checks/contract.ts', change: 'modified' }]);
  });

  it('refuses a check directory inside the workspace', async () => {
    const o = opts();
    const r = await runDeterministicChecks({ ...o, workDir: join(o.workspaceDir, 'x') }, fakeDeps({}).deps);
    expect(r).toMatchObject({ status: 'infrastructure-failure', reason: 'check directory must not be inside the workspace' });
  });
});

describe('parseSuiteReport', () => {
  it('accepts a valid report for the named suite only', () => {
    const text = report('smoke', [{ name: 'smoke.health', passed: false, detail: 'x' }]);
    expect(parseSuiteReport(text, 'smoke')).toEqual({ passed: false, checks: [{ name: 'smoke.health', title: 't', passed: false, detail: 'x' }], stderr: { server: ['s'], worker: ['w'] } });
    expect(parseSuiteReport(text, 'contract')).toBeUndefined();
    expect(parseSuiteReport('{"schema":"job-tracker/check-report@1","suite":"smoke","checks":[]}', 'smoke')).toBeUndefined();
    expect(parseSuiteReport('nope', 'smoke')).toBeUndefined();
  });

  describe('properties', () => {
    it('never throws on arbitrary text or JSON', () => {
      fc.assert(fc.property(fc.oneof(fc.string(), fc.json()), (s) => void parseSuiteReport(s, 'contract')));
    });

    it('derives passed from the checks, never from the claimed flag', () => {
      fc.assert(
        fc.property(fc.array(fc.record({ name: fc.string(), passed: fc.boolean() }), { minLength: 1, maxLength: 8 }), fc.boolean(), (checks, claimed) => {
          const text = JSON.stringify({ schema: 'job-tracker/check-report@1', suite: 'smoke', passed: claimed, checks });
          expect(parseSuiteReport(text, 'smoke')!.passed).toBe(checks.every((c) => c.passed));
        }),
      );
    });

    it('overallStatus passes only when every suite passed', () => {
      const status = fc.constantFrom('passed', 'failed', 'not-run', 'timed-out' as const);
      fc.assert(
        fc.property(fc.array(status, { maxLength: 3 }), (ss) => {
          const suites = ss.map((s) => ({ suite: 'build' as const, status: s as 'passed', checks: [], output: [], stderr: { server: [], worker: [] }, durationMs: 0 }));
          expect(overallStatus(suites) === 'passed').toBe(ss.length > 0 && ss.every((s) => s === 'passed'));
        }),
      );
    });
  });
});
