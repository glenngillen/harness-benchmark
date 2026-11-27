import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BENCHMARK_ROOT } from '../../src/fixtures.ts';
import { STAGE_SEQUENCE, StageLedger, workflowPlan, type LimitsConfig } from '../../src/orchestrator/plan.ts';
import { parseConditionId } from '../../src/orchestrator/schedule.ts';

const limits = JSON.parse(readFileSync(join(BENCHMARK_ROOT, 'config', 'limits.json'), 'utf8')) as LimitsConfig;
const MIN = 60_000;

describe('workflowPlan', () => {
  it('solo: one fresh implementer with the whole budget, final', () => {
    const p = workflowPlan(parseConditionId('solo.CC.on'), limits);
    expect(p.map((s) => [s.id, s.role, s.permission, s.session.kind, s.budgetMs, s.position])).toEqual([['s1-implement', 'CC', 'workspace-write', 'fresh', 30 * MIN, 'final']]);
  });

  it('plan -> implement: read-only planner then a fresh implementer, and no review stage', () => {
    const p = workflowPlan(parseConditionId('pi.AF-CC.off'), limits);
    expect(p.map((s) => s.kind)).toEqual(['plan', 'implement']);
    expect(p[0]).toMatchObject({ role: 'AF', permission: 'read-only', produces: 'plan', budgetMs: 5 * MIN, implementing: false });
    expect(p[1]).toMatchObject({ role: 'CC', permission: 'workspace-write', session: { kind: 'fresh' }, consumes: 'plan', budgetMs: 25 * MIN, position: 'final' });
    expect(p.some((s) => s.kind === 'review' || s.kind === 'fix')).toBe(false);
  });

  it('implement -> review -> fix: the fix resumes the original implementer stage', () => {
    const p = workflowPlan(parseConditionId('irf.AC-CF-AC.on'), limits);
    expect(p.map((s) => `${s.kind}:${s.role}`)).toEqual(['implement:AC', 'review:CF', 'fix:AC']);
    expect(p[0]).toMatchObject({ position: 'intermediate', budgetMs: 15 * MIN });
    expect(p[1]).toMatchObject({ permission: 'read-only', produces: 'findings', budgetMs: 5 * MIN, handoffMaxBytes: 8000 });
    expect(p[2]).toMatchObject({ session: { kind: 'resume', ofStage: 's1-implement' }, consumes: 'findings', position: 'final', budgetMs: 10 * MIN });
  });

  it('stage budgets never exceed the workflow ceiling', () => {
    for (const id of JSON.parse(readFileSync(join(BENCHMARK_ROOT, 'config', 'matrix.json'), 'utf8')).canonicalConditionOrder as string[]) {
      const c = parseConditionId(id);
      const p = workflowPlan(c, limits);
      expect(p.map((s) => s.kind)).toEqual(STAGE_SEQUENCE[c.workflow]);
      expect(p.reduce((a, s) => a + s.budgetMs, 0)).toBeLessThanOrEqual(limits.workflowCeilingMinutes * MIN);
      expect(p.filter((s) => s.position === 'final')).toHaveLength(1);
    }
  });
});

describe('StageLedger', () => {
  const irf = workflowPlan(parseConditionId('irf.CC-AF-CC.on'), limits);

  it('accepts the planned sequence with repairs on implementing stages', () => {
    const l = new StageLedger(irf, 2);
    l.startStage('s1-implement');
    expect(l.startRepair('s1-implement')).toBe(1);
    l.startStage('s2-review');
    l.startStage('s3-fix');
    expect(l.startRepair('s3-fix')).toBe(2);
    expect(l.repairsUsed).toBe(2);
  });

  it('refuses an extra, repeated, or out-of-order stage', () => {
    const pi = new StageLedger(workflowPlan(parseConditionId('pi.CF-CC.on'), limits), 2);
    pi.startStage('s1-plan');
    pi.startStage('s2-implement');
    expect(() => pi.startStage('s3-review')).toThrow(/not scheduled/);
    const l = new StageLedger(irf, 2);
    expect(() => l.startStage('s2-review')).toThrow(/not scheduled/);
    l.startStage('s1-implement');
    expect(() => l.startStage('s1-implement')).toThrow(/not scheduled/);
  });

  it('refuses a third repair and a repair of a read-only or earlier stage', () => {
    const l = new StageLedger(irf, 2);
    l.startStage('s1-implement');
    l.startRepair('s1-implement');
    l.startRepair('s1-implement');
    expect(() => l.startRepair('s1-implement')).toThrow(/limit/);
    const m = new StageLedger(irf, 2);
    m.startStage('s1-implement');
    m.startStage('s2-review');
    expect(() => m.startRepair('s2-review')).toThrow(/not allowed/);
    expect(() => m.startRepair('s1-implement')).toThrow(/not allowed/);
  });
});
