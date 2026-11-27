import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoleKey, StageRequest, StageResult, StageTermination } from '../../src/adapters/types.ts';
import { BENCHMARK_ROOT } from '../../src/fixtures.ts';
import type { CheckRun } from '../../src/feedback/types.ts';
import { workflowPlan, type LimitsConfig } from '../../src/orchestrator/plan.ts';
import { loadPrompts } from '../../src/orchestrator/run.ts';
import { parseConditionId } from '../../src/orchestrator/schedule.ts';
import { mapStageTermination, runWorkflow, type WorkflowDeps, type WorkflowInput } from '../../src/orchestrator/workflow.ts';

const limits = JSON.parse(readFileSync(join(BENCHMARK_ROOT, 'config', 'limits.json'), 'utf8')) as LimitsConfig;
const prompts = loadPrompts();
const MIN = 60_000;
const ROLES: Record<RoleKey, { requestedModel: string; effort: string }> = {
  CF: { requestedModel: 'gpt-6-astra', effort: 'low' },
  CC: { requestedModel: 'gpt-6-luna', effort: 'high' },
  AF: { requestedModel: 'claude-opus-5-5', effort: 'medium' },
  AC: { requestedModel: 'claude-haiku-5-5', effort: 'medium' },
};

type StageScript = { termination?: StageTermination; finalMessage?: string | null; sessionId?: string | null; minutes?: number; writes?: boolean; detail?: string };

function checkRun(status: CheckRun['status']): CheckRun {
  return {
    schema: 'harness-benchmark/check-run@1',
    status,
    reason: null,
    startedAt: '2026-11-14T00:00:00.000Z',
    durationMs: 1000,
    ceilingMs: 120_000,
    snapshotHash: 'h',
    fixedFileChanges: [],
    suites: [{ suite: 'contract', status: status === 'passed' ? 'passed' : 'failed', checks: [{ name: 'contract.submit-job', title: 't', passed: status === 'passed', detail: 'status: expected 201, observed 500' }], output: [], stderr: { server: [], worker: [] }, durationMs: 1 }],
  };
}

function harness(conditionId: string, scripts: StageScript[], checks: CheckRun['status'][] = [], extra: Partial<WorkflowDeps> = {}) {
  let clock = Date.parse('2026-11-14T00:00:00Z');
  const log: string[] = [];
  const requests: StageRequest[] = [];
  const transitions: { type: string; [k: string]: unknown }[] = [];
  const written = new Map<string, string>();
  const hashes = new Map<string, number>();
  const copies: [string, string][] = [];
  let fresh = 0;
  let call = 0;
  let checkCall = 0;
  const deps: WorkflowDeps = {
    now: () => clock,
    wallClock: () => new Date(clock),
    runStage: async (req) => {
      log.push(`runStage:${req.stageId.split('--')[1]}`);
      requests.push(req);
      const s = scripts[call++];
      if (!s) throw new Error(`unscripted stage ${req.stageId}`);
      const start = clock;
      clock += (s.minutes ?? 1) * MIN;
      if (s.writes ?? req.permission === 'workspace-write') hashes.set(req.workspaceDir, (hashes.get(req.workspaceDir) ?? 0) + 1);
      const sessionId = s.sessionId !== undefined ? s.sessionId : req.mode.kind === 'resume' ? req.mode.sessionId : `00000000-0000-4000-8000-00000000000${++fresh}`;
      return {
        stageId: req.stageId,
        role: req.role,
        provider: req.role.startsWith('C') ? 'openai' : 'anthropic',
        tool: req.role.startsWith('C') ? 'codex' : 'claude-code',
        toolVersion: 'x',
        mode: req.mode.kind,
        requestedModel: req.requestedModel,
        resolvedModel: req.requestedModel,
        resolvedModelSource: 'test',
        requestedEffort: req.effort,
        appliedEffort: null,
        sessionId,
        termination: s.termination ?? 'completed',
        terminationDetail: s.detail ?? null,
        exitCode: 0,
        signal: null,
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(clock).toISOString(),
        durationMs: clock - start,
        finalMessage: s.finalMessage === undefined ? 'Done.' : s.finalMessage,
        usage: { source: 'test', semantics: 'test', completeness: 'complete', raw: [] },
        recordFiles: [],
        settings: {},
      } satisfies StageResult;
    },
    runChecks: async (o) => {
      log.push('checks');
      clock += 5000;
      const status = checks[checkCall++];
      if (!status) throw new Error('unscripted check run');
      expect(o.timeoutMs).toBeGreaterThan(0);
      return checkRun(status);
    },
    copyTree: (from, to) => {
      copies.push([from, to]);
      hashes.set(to, hashes.get(from) ?? 0);
    },
    treeHash: (dir) => `${dir}#${hashes.get(dir) ?? 0}`,
    writeText: (p, t) => void written.set(p, t),
    transition: (e) => {
      transitions.push(e);
      log.push(`transition:${e.type}`);
    },
    ...extra,
  };
  const c = parseConditionId(conditionId);
  const input: WorkflowInput = {
    attemptKey: 'test-b01-s01-a1',
    condition: c,
    plan: workflowPlan(c, limits),
    roles: ROLES,
    ...prompts,
    maxRepairs: 2,
    workflowCeilingMs: 30 * MIN,
    checkCeilingMs: 120_000,
    feedbackMaxBytes: 4000,
    dirs: { workspace: '/w/workspace', runtime: '/w/runtime', records: '/w/records' },
  };
  return { deps, input, log, requests, transitions, written, copies, run: () => runWorkflow(input, deps) };
}

const stageIds = (reqs: StageRequest[]) => reqs.map((r) => r.stageId.split('--')[1]);

describe('solo', () => {
  it('checks off: one fresh implementer, no checks, completed', async () => {
    const h = harness('solo.CC.off', [{}]);
    const out = await h.run();
    expect(out.termination).toBe('completed');
    expect(stageIds(h.requests)).toEqual(['s1-implement']);
    expect(h.requests[0]).toMatchObject({ role: 'CC', requestedModel: 'gpt-6-luna', effort: 'high', permission: 'workspace-write', mode: { kind: 'fresh' }, workspaceDir: '/w/workspace', toolHome: '/w/runtime/homes/s1-implement' });
    expect(h.log).not.toContain('checks');
    expect(out.finalWorkspace).toBe('/w/workspace');
  });

  it('checkpoints each stage start before invoking the adapter', async () => {
    const h = harness('solo.CF.off', [{}]);
    await h.run();
    expect(h.log.indexOf('transition:stage-started')).toBeLessThan(h.log.indexOf('runStage:s1-implement'));
    expect(h.transitions.map((t) => t.type)).toEqual(['workflow-started', 'stage-started', 'stage-ended', 'feedback-loop', 'workflow-ended']);
  });

  it('checks on: failing checks resume the same session, sharing the stage budget, until they pass', async () => {
    const h = harness('solo.AF.on', [{ minutes: 10 }, { minutes: 2 }, { minutes: 2 }], ['failed', 'failed', 'passed']);
    const out = await h.run();
    expect(out.termination).toBe('completed');
    expect(out.sensorRepairs).toBe(2);
    expect(stageIds(h.requests)).toEqual(['s1-implement', 's1-implement-repair-1', 's1-implement-repair-2']);
    const sid = h.requests[0] && out.results[0]!.sessionId;
    expect(h.requests.slice(1).map((r) => r.mode)).toEqual([{ kind: 'resume', sessionId: sid }, { kind: 'resume', sessionId: sid }]);
    expect(new Set(h.requests.map((r) => r.toolHome)).size).toBe(1);
    expect(new Set(h.requests.map((r) => r.deadlineAt)).size).toBe(1);
    expect(h.requests[1]!.prompt).toContain('contract.submit-job');
    expect([...h.written.keys()].filter((k) => k.includes('/checks/'))).toEqual(['/w/records/checks/01.json', '/w/records/checks/02.json', '/w/records/checks/03.json']);
  });

  it('checks on: a third failure ends as repair-budget-exhausted without a third repair', async () => {
    const h = harness('solo.AF.on', [{}, {}, {}], ['failed', 'failed', 'failed']);
    const out = await h.run();
    expect(out.termination).toBe('repair-budget-exhausted');
    expect(h.requests).toHaveLength(3);
  });

  it('a stage killed at its own budget is stage-timeout; adapters receive the stage deadline', async () => {
    const h = harness('solo.CC.off', [{ termination: 'stage-timeout', minutes: 30 }]);
    const out = await h.run();
    expect(out.termination).toBe('stage-timeout');
    expect(h.requests[0]!.deadlineAt - Date.parse('2026-11-14T00:00:00Z')).toBe(30 * MIN);
  });

  it('an adapter error is a runner infrastructure failure, not a crash', async () => {
    const h = harness('solo.CC.off', [{}], [], { runStage: async () => Promise.reject(new Error('boom')) });
    const out = await h.run();
    expect(out).toMatchObject({ termination: 'runner-infrastructure-failure', detail: 'runner error: boom' });
  });

  it('passes the isolation factory result into each request', async () => {
    const seen: string[] = [];
    const h = harness('solo.CC.off', [{}], [], {
      isolation: (s) => {
        seen.push(s.permission);
        return { mechanism: 'none', wrap: (a) => a, describe: () => ({}) };
      },
    });
    await h.run();
    expect(seen).toEqual(['workspace-write']);
    expect(h.requests[0]!.isolation?.mechanism).toBe('none');
  });
});

describe('plan -> implement', () => {
  it('planner works read-only on a copy; a fresh implementer gets only task, repo, and the plan', async () => {
    const h = harness('pi.AF-CC.off', [{ finalMessage: '# Plan\n\n## Approach\nUse SQLite.', writes: false }, {}]);
    const out = await h.run();
    expect(out.termination).toBe('completed');
    expect(stageIds(h.requests)).toEqual(['s1-plan', 's2-implement']);
    const [plan, impl] = h.requests;
    expect(plan).toMatchObject({ role: 'AF', permission: 'read-only', mode: { kind: 'fresh' }, workspaceDir: '/w/runtime/snapshots/s1-plan' });
    expect(h.copies).toEqual([['/w/workspace', '/w/runtime/snapshots/s1-plan']]);
    expect(impl).toMatchObject({ role: 'CC', mode: { kind: 'fresh' }, workspaceDir: '/w/workspace' });
    expect(impl!.toolHome).not.toBe(plan!.toolHome);
    expect(impl!.prompt).toContain('Use SQLite.');
    expect(h.written.get('/w/records/handoffs/plan.md')).toBe('# Plan\n\n## Approach\nUse SQLite.');
    expect(out.stages[0]!.handoff).toMatchObject({ kind: 'plan', status: 'ok', file: 'handoffs/plan.md' });
  });

  it('a missing or empty plan is failed-required-handoff and the implementer never runs', async () => {
    for (const finalMessage of [null, '   ']) {
      const h = harness('pi.CF-AC.on', [{ finalMessage, writes: false }]);
      const out = await h.run();
      expect(out.termination).toBe('failed-required-handoff');
      expect(h.requests).toHaveLength(1);
      expect(out.finalWorkspace).toBeNull();
    }
  });

  it('a planner that changes its workspace copy is an isolation failure (operational)', async () => {
    const h = harness('pi.CF-CC.off', [{ finalMessage: '# Plan', writes: true }]);
    const out = await h.run();
    expect(out.termination).toBe('runner-infrastructure-failure');
    expect(out.detail).toMatch(/read-only/);
  });

  it('a planner killed when the workflow ceiling binds before its own budget is task-timeout', () => {
    expect(mapStageTermination('stage-timeout', { stageStart: 0, budgetMs: 25 * MIN, workflowDeadline: 20 * MIN })).toBe('task-timeout');
    expect(mapStageTermination('stage-timeout', { stageStart: 0, budgetMs: 25 * MIN, workflowDeadline: 25 * MIN })).toBe('stage-timeout');
    expect(mapStageTermination('model-error-exit', { stageStart: 0, budgetMs: 1, workflowDeadline: 0 })).toBe('model-error-exit');
  });

  it('never starts a review stage (implement passes checks, workflow completes)', async () => {
    const h = harness('pi.AF-AC.on', [{ finalMessage: '# Plan', writes: false }, {}], ['passed']);
    const out = await h.run();
    expect(out.termination).toBe('completed');
    expect(out.stages.map((s) => s.kind)).toEqual(['plan', 'implement']);
  });
});

describe('implement -> review -> fix', () => {
  it('reviewer is fresh and read-only on a snapshot; the fix resumes the original implementer session and home', async () => {
    const h = harness('irf.CC-AF-CC.off', [{}, { finalMessage: '# Review findings\n\n1. [major] src/app.ts — wrong status', writes: false }, {}]);
    const out = await h.run();
    expect(out.termination).toBe('completed');
    const [impl, review, fix] = h.requests;
    expect(review).toMatchObject({ role: 'AF', permission: 'read-only', mode: { kind: 'fresh' }, workspaceDir: '/w/runtime/snapshots/s2-review' });
    expect(fix).toMatchObject({ role: 'CC', mode: { kind: 'resume', sessionId: out.results[0]!.sessionId }, toolHome: impl!.toolHome, workspaceDir: impl!.workspaceDir });
    expect(fix!.prompt).toContain('wrong status');
    expect(fix!.prompt).not.toContain('{{');
  });

  it('runs the fix stage even when the review reports no findings', async () => {
    const h = harness('irf.AC-CF-AC.off', [{}, { finalMessage: '# Review findings\n\nNo findings.', writes: false }, {}]);
    const out = await h.run();
    expect(stageIds(h.requests)).toEqual(['s1-implement', 's2-review', 's3-fix']);
    expect(out.termination).toBe('completed');
  });

  it('shares two sensor repairs across the whole workflow', async () => {
    // implement: fail, repair 1, fail, repair 2, fail -> continue to review; fix: fail with none left.
    const h = harness('irf.CC-CF-CC.on', [{}, {}, {}, { finalMessage: '# Review findings\n\nNo findings.', writes: false }, {}], ['failed', 'failed', 'failed', 'failed']);
    const out = await h.run();
    expect(stageIds(h.requests)).toEqual(['s1-implement', 's1-implement-repair-1', 's1-implement-repair-2', 's2-review', 's3-fix']);
    expect(out.termination).toBe('repair-budget-exhausted');
    expect(out.sensorRepairs).toBe(2);
  });

  it('a missing review artifact is failed-required-handoff and the fix never runs', async () => {
    const h = harness('irf.AC-AF-AC.on', [{}, { finalMessage: '', writes: false }], ['passed']);
    const out = await h.run();
    expect(out.termination).toBe('failed-required-handoff');
    expect(stageIds(h.requests)).toEqual(['s1-implement', 's2-review']);
    expect(out.finalWorkspace).toBe('/w/workspace');
  });

  it("one provider's quota exhaustion ends the attempt as operational and stops the workflow", async () => {
    const h = harness('irf.CC-AF-CC.off', [{}, { termination: 'quota-exhausted', finalMessage: null, writes: false, detail: '429' }]);
    const out = await h.run();
    expect(out).toMatchObject({ termination: 'quota-exhausted', detail: '429' });
    expect(h.requests).toHaveLength(2);
  });

  it('cannot fix without a session to resume', async () => {
    const h = harness('irf.CC-AF-CC.off', [{ sessionId: null }, { finalMessage: '# Review findings\n\nNo findings.', writes: false }]);
    const out = await h.run();
    expect(out.termination).toBe('runner-infrastructure-failure');
    expect(out.detail).toMatch(/no session to resume/);
  });

  it('a stage that starts after the workflow ceiling is task-timeout', async () => {
    const h = harness('irf.CC-AF-CC.off', [{ minutes: 15 }, { minutes: 16, finalMessage: '# Review findings\n\nNo findings.', writes: false }]);
    const out = await h.run();
    expect(out.termination).toBe('task-timeout');
    expect(h.requests).toHaveLength(2);
  });

  it('a stage budget is clipped to the workflow ceiling and unused time does not roll over', async () => {
    const h = harness('irf.CC-AF-CC.off', [{ minutes: 1 }, { minutes: 1, finalMessage: '# Review findings\n\nNo findings.', writes: false }, {}]);
    await h.run();
    const t0 = Date.parse('2026-11-14T00:00:00Z');
    expect(h.requests.map((r) => (r.deadlineAt - t0) / MIN)).toEqual([15, 1 + 5, 2 + 10]);
  });
});
