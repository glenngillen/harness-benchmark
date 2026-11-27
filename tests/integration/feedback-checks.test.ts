/**
 * CI-ONLY: runs the real deterministic build-time checks (build, smoke, contract) in the OS sandbox
 * against materialised references, and one complete feedback loop with a scripted repair standing
 * in for a model. Requires `npm run fixtures:install` and, on Linux, a working bubblewrap. Never
 * run in the local agent loop; no model CLI is involved.
 *
 *   correct                       every check passes
 *   scaffold                      the starting state fails the build-time checks
 *   A6-no-retry                   fails contract.retry-transient only
 *   A7 / A8                       pass every build-time check (persistence and UI are evaluator-only)
 *   A6 + edited checks/           the workspace's edits to checks/ and package.json change nothing; they are recorded
 *   loop                          A6 fails, a scripted repair restores retry.ts, the re-check passes
 */
import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BENCHMARK_ROOT, listFiles, materialiseReference } from '../../src/fixtures.ts';
import { runDeterministicChecks } from '../../src/feedback/checks.ts';
import { runFeedbackLoop } from '../../src/feedback/loop.ts';
import type { IsolationMode } from '../../src/evaluator/sandbox.ts';
import type { CheckRun } from '../../src/feedback/types.ts';

const ISOLATION = (process.env.HARNESS_EVAL_ISOLATION ?? 'required') as IsolationMode;
const RUN_ROOT = join(BENCHMARK_ROOT, '.runs', 'integration-checks', `${Date.now()}-${process.pid}`);
const TIMEOUT_MS = 200_000;
let seq = 0;

function workspace(name: string): string {
  const dir = join(RUN_ROOT, name, 'workspace');
  if (name === 'scaffold') {
    const src = join(BENCHMARK_ROOT, 'fixtures', 'scaffold');
    for (const f of listFiles(src)) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      cpSync(join(src, f), join(dir, f));
    }
  } else materialiseReference(name.replace(/\+.*$/, ''), dir);
  return dir;
}

const check = (ws: string, label: string) => runDeterministicChecks({ workspaceDir: ws, workDir: join(RUN_ROOT, `${label}-check-${++seq}`), timeoutMs: 120_000, isolation: ISOLATION });

function failing(run: CheckRun): string[] {
  if (run.status === 'infrastructure-failure') throw new Error(`infrastructure failure: ${run.reason}`);
  return run.suites.flatMap((s) => [...s.checks.filter((c) => !c.passed).map((c) => c.name), ...(s.status === 'not-run' || s.status === 'timed-out' ? [`${s.suite}:${s.status}`] : [])]);
}

describe.concurrent('deterministic build-time checks against the references', () => {
  it('pass the correct reference', { timeout: TIMEOUT_MS }, async () => {
    const run = await check(workspace('correct'), 'correct');
    expect(failing(run)).toEqual([]);
    expect(run.status).toBe('passed');
    expect(run.durationMs).toBeLessThan(run.ceilingMs);
  });

  it('fail the starting scaffold', { timeout: TIMEOUT_MS }, async () => {
    const names = failing(await check(workspace('scaffold'), 'scaffold'));
    expect(names).toContain('smoke.worker-up');
    expect(names).toContain('contract.submit-job');
  });

  it('fail A6-no-retry on the retry check only', { timeout: TIMEOUT_MS }, async () => {
    expect(failing(await check(workspace('A6-no-retry'), 'a6'))).toEqual(['contract.retry-transient']);
  });

  for (const ref of ['A7-no-crash-recovery', 'A8-ui-hides-errors']) {
    it(`pass ${ref}, which only the independent evaluator rejects`, { timeout: TIMEOUT_MS }, async () => {
      expect(failing(await check(workspace(ref), ref))).toEqual([]);
    });
  }

  it('ignore workspace edits to checks/ and package.json, recording them', { timeout: TIMEOUT_MS }, async () => {
    const ws = workspace('A6-no-retry+tamper');
    writeFileSync(join(ws, 'checks', 'contract.ts'), 'export const CONTRACT_CHECKS = [];\n');
    const pkg = JSON.parse(readFileSync(join(ws, 'package.json'), 'utf8'));
    pkg.scripts['check:contract'] = 'true';
    writeFileSync(join(ws, 'package.json'), JSON.stringify(pkg));
    const run = await check(ws, 'tamper');
    expect(failing(run)).toEqual(['contract.retry-transient']);
    expect(run.fixedFileChanges).toEqual([
      { path: 'checks/contract.ts', change: 'modified' },
      { path: 'package.json', change: 'modified' },
    ]);
  });

  it('runs a whole feedback loop: failure, bounded feedback, scripted repair, passing re-check', { timeout: 2 * TIMEOUT_MS }, async () => {
    const ws = workspace('A6-no-retry+loop');
    const prompts: string[] = [];
    const t0 = performance.now();
    const result = await runFeedbackLoop(
      { checkCondition: 'on', position: 'final', repairsUsed: 0, maxRepairs: 2, stageDeadlineAt: t0 + 10 * 60_000, workflowDeadlineAt: t0 + 30 * 60_000, checkCeilingMs: 120_000, feedbackMaxBytes: 4_000 },
      {
        now: () => performance.now(),
        wallClock: () => new Date(),
        runChecks: (timeoutMs) => runDeterministicChecks({ workspaceDir: ws, workDir: join(RUN_ROOT, `loop-check-${++seq}`), timeoutMs, isolation: ISOLATION }),
        async repair(prompt) {
          prompts.push(prompt);
          cpSync(join(BENCHMARK_ROOT, 'fixtures', 'references', 'correct', 'src', 'retry.ts'), join(ws, 'src', 'retry.ts'));
          return { kind: 'returned' };
        },
        repairTemplate: readFileSync(join(BENCHMARK_ROOT, 'prompts', 'sensor-repair.md'), 'utf8'),
      },
    );
    expect(result).toMatchObject({ outcome: 'proceed', termination: null, repairsUsed: 1 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('[contract] contract.retry-transient: FAILED');
    expect(Buffer.byteLength(prompts[0]!)).toBeLessThan(4_000 + 1_000);
    expect(prompts[0]).not.toMatch(/eval-|cases\.ts|verdict/);
  });
});
