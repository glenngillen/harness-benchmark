/**
 * CI-ONLY integration and browser discrimination: runs the real evaluator, as a separate process,
 * against every reference. Requires `npm run fixtures:install`, Chromium (`npx playwright install
 * --with-deps chromium`), and on Linux a working bubblewrap. Never run in the local agent loop.
 *
 *   correct                   passes every case
 *   each broken reference     fails its own behaviour (and still starts: A1 passes unless A1 is the fault)
 *   T1-probes-evaluator       fails on its base fault; under isolation its probe cannot read or write the evaluator
 *   T2-rewrites-fixed-files   passes, because the protected package.json is restored; the change is recorded
 *   missing snapshot          rejected as missing output
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BENCHMARK_ROOT, loadBrokenManifest, loadTamperManifest, materialiseReference } from '../../src/fixtures.ts';
import { evaluatorSourceHash, type Verdict } from '../../src/evaluator/evaluate.ts';
import { superviseEvaluation } from '../../src/evaluator/supervise.ts';
import type { IsolationMode } from '../../src/evaluator/sandbox.ts';

const ISOLATION = (process.env.HARNESS_EVAL_ISOLATION ?? 'required') as IsolationMode;
const RUN_ROOT = join(BENCHMARK_ROOT, '.runs', 'integration', `${Date.now()}-${process.pid}`);
const TIMEOUT_MS = 240_000;
const hashBefore = evaluatorSourceHash();

async function evaluate(name: string, materialise = true): Promise<Verdict> {
  const dir = join(RUN_ROOT, name);
  mkdirSync(dir, { recursive: true });
  const snapshot = join(dir, 'snapshot');
  if (materialise) materialiseReference(name, snapshot);
  const outcome = await superviseEvaluation({ snapshotDir: snapshot, workDir: join(dir, 'work'), verdictPath: join(dir, 'verdict.json'), isolation: ISOLATION });
  if (outcome.kind !== 'verdict') throw new Error(`${name}: ${outcome.reason}`);
  const v = outcome.verdict;
  if (v.status === 'infrastructure-failure') throw new Error(`${name}: infrastructure failure: ${v.reason}\n${readFileSync(join(dir, 'verdict.json'), 'utf8')}`);
  return v;
}

const failingBehaviours = (v: Verdict) => Object.entries(v.behaviours).filter(([, b]) => !b.passed).map(([k]) => k).sort();
const failures = (v: Verdict) => v.cases.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`).join('\n');

// Sequential because scored evaluations ran one at a time. The A1 startup failures in run
// 43671644525 (2026-11-15) and the 2026-11-24 manual run were not CPU load, as first assumed: the
// fixtures' openDatabase set busy_timeout after switching to WAL, so when the server and worker
// opened the database together the loser crashed with "database is locked". Fixed in the fixtures
// for cohort-03; tests/unit/fixture-db-open.test.ts covers it.
describe.sequential('evaluator discrimination against the references', () => {
  it('passes the correct reference on every case', { timeout: TIMEOUT_MS }, async () => {
    const v = await evaluate('correct');
    expect(failures(v)).toBe('');
    expect(v.status).toBe('passed');
    expect(v.durationMs).toBeLessThan(v.ceilingMs);
    if (ISOLATION === 'required') expect(v.isolation?.mechanism).not.toBe('none');
  });

  for (const ref of loadBrokenManifest()) {
    it(`rejects ${ref.id} on ${ref.behaviour}`, { timeout: TIMEOUT_MS }, async () => {
      const v = await evaluate(ref.id);
      expect(v.status).toBe('failed');
      expect(failingBehaviours(v)).toContain(ref.behaviour);
      if (ref.behaviour !== 'A1') expect(v.behaviours.A1.passed, failures(v)).toBe(true);
    });
  }

  const tamper = new Map(loadTamperManifest().map((t) => [t.id, t]));

  it('T1: a snapshot probing for the evaluator gains nothing and cannot touch it', { timeout: TIMEOUT_MS }, async () => {
    const t = tamper.get('T1-probes-evaluator')!;
    const v = await evaluate(t.id);
    expect(v.status).toBe(t.expect.status);
    expect(failingBehaviours(v)).toEqual(t.expect.failing);
    const probe = v.appOutput.server.find((l) => l.includes('tamper-probe:'));
    expect(probe).toBeDefined();
    if (v.isolation?.mechanism !== 'none') {
      expect(probe).not.toMatch(/read=ok/);
      expect(probe).not.toMatch(/write=ok/);
    }
    expect(evaluatorSourceHash()).toBe(hashBefore);
  });

  it('T2: rewritten fixed files are recorded and never honoured', { timeout: TIMEOUT_MS }, async () => {
    const t = tamper.get('T2-rewrites-fixed-files')!;
    const v = await evaluate(t.id);
    expect(v.status, failures(v)).toBe(t.expect.status);
    expect(v.snapshot.fixedFileChanges).toContainEqual({ path: 'package.json', change: 'modified' });
  });

  it('rejects a missing snapshot as missing output', { timeout: TIMEOUT_MS }, async () => {
    const v = await evaluate('missing-snapshot', false);
    expect(v.status).toBe('failed');
    expect(v.reason).toBe('missing-output');
  });
});
