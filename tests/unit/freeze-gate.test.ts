import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  evaluateGate,
  exerciseProblems,
  pilotCoverage,
  pilotEstimate,
  pilotExerciseCoverage,
  safeguardProblems,
  treeDigest,
  type GateInputs,
  type PilotAttempt,
  type PilotStage,
  type PlannedStage,
  type SafeguardEvidence,
} from '../../src/freeze/gate.ts';
import type { ShellHealth } from '../../src/audit/shell.ts';

const SHELL_OK: ShellHealth = { attempted: 3, succeeded: 2, failed: 1, malformedLines: 0, firstFailure: 'exit 1: tsc error' };
const SOCAT = 'Sandbox is required but failed to initialize: Sandbox dependencies not available: socat not installed.';
const SHELL_BROKEN: ShellHealth = { attempted: 2, succeeded: 0, failed: 2, malformedLines: 0, firstFailure: SOCAT };
const SHELL_NONE: ShellHealth = { attempted: 0, succeeded: 0, failed: 0, malformedLines: 0, firstFailure: null };

// Plans mirror workflowPlan (src/orchestrator/plan.ts) for the three workflow shapes.
const PLANS: Record<string, PlannedStage[]> = {
  'solo.CF.off': [{ id: 's1-implement', kind: 'implement', role: 'CF', permission: 'workspace-write', session: { kind: 'fresh' }, produces: null }],
  'pi.CF-AC.on': [
    { id: 's1-plan', kind: 'plan', role: 'CF', permission: 'read-only', session: { kind: 'fresh' }, produces: 'plan' },
    { id: 's2-implement', kind: 'implement', role: 'AC', permission: 'workspace-write', session: { kind: 'fresh' }, produces: null },
  ],
  'irf.CC-AF-CC.on': [
    { id: 's1-implement', kind: 'implement', role: 'CC', permission: 'workspace-write', session: { kind: 'fresh' }, produces: null },
    { id: 's2-review', kind: 'review', role: 'AF', permission: 'read-only', session: { kind: 'fresh' }, produces: 'findings' },
    { id: 's3-fix', kind: 'fix', role: 'CC', permission: 'workspace-write', session: { kind: 'resume', ofStage: 's1-implement' }, produces: null },
  ],
};
const CONDITIONS = Object.keys(PLANS);
const MODEL: Record<string, string> = { CF: 'gpt-6-astra', CC: 'gpt-6-astra-mini', AF: 'claude-opus-5-5', AC: 'claude-sonnet-5-5' };

const stage = (sp: PlannedStage, n: number, cond: string, over: Partial<PilotStage> = {}): PilotStage => ({
  id: sp.id,
  kind: sp.kind,
  role: sp.role,
  mode: sp.session.kind,
  sessionId: sp.session.kind === 'fresh' ? `${cond}-sess-${n}` : null,
  resumedSession: sp.session.kind === 'resume' ? `${cond}-sess-0` : null,
  requestedModel: MODEL[sp.role]!,
  resolvedModel: MODEL[sp.role]!,
  termination: 'completed',
  workspaceHashBefore: `h${n}`,
  workspaceHashAfter: sp.permission === 'read-only' ? `h${n}` : `h${n}x`,
  handoff: sp.produces ? { kind: sp.produces, status: 'ok', sha256: 'f'.repeat(64), file: `handoffs/${sp.produces}.md` } : null,
  usageCompleteness: 'complete',
  isolationMechanism: 'sandbox-exec',
  shell: sp.permission === 'workspace-write' ? SHELL_OK : null,
  ...over,
});

const attempt = (conditionId: string, over: Partial<PilotAttempt> = {}): PilotAttempt => ({
  conditionId,
  attempt: 1,
  phase: 'finished',
  outcome: 'completed',
  termination: 'completed',
  activeMs: 600_000,
  evaluation: { status: 'passed', durationMs: 30_000 },
  stages: (PLANS[conditionId] ?? []).map((sp, n) => stage(sp, n, conditionId)),
  ...over,
});

const withStage = (a: PilotAttempt, id: string, over: Partial<PilotStage>): PilotAttempt => ({ ...a, stages: a.stages.map((s) => (s.id === id ? { ...s, ...over } : s)) });

const SAFEGUARDS: SafeguardEvidence[] = [
  { id: 'paid-overflow-guard', kind: 'human-attestation', statement: 'Both accounts have no paid overflow enabled', refs: ['records/cohort-03-pilots/access-handoff.md'], attestedBy: 'operator', attestedAt: '2026-11-20', missingRefs: [] },
  { id: 'quota-pausing', kind: 'record', statement: 'Pilot slot paused on usage-limit and resumed', refs: ['records/cohort-03-pilots/pilot/slot-03/attempt-1/transitions.jsonl'], attestedBy: null, attestedAt: null, missingRefs: [] },
  { id: 'recovery', kind: 'record', statement: 'Interrupted pilot resumed from attempt state', refs: ['records/cohort-03-pilots/pilot/slot-05/attempt-2/attempt.json'], attestedBy: null, attestedAt: null, missingRefs: [] },
];

const goodInputs = (): GateInputs => ({
  conditions: CONDITIONS,
  plans: PLANS,
  attempts: CONDITIONS.map((c) => attempt(c)),
  preflight: { codex: { ok: true, termination: null }, claude: { ok: true, termination: null } },
  sandboxTool: '/usr/bin/sandbox-exec',
  scheduleReproduces: true,
  usageSemantics: { codex: { status: 'pilot-verified', turnCompletedScope: 'per-turn', cachedInputSubsetOfInput: true, reasoningIncludedInOutput: true } },
  priceSnapshot: { present: true },
  safeguards: SAFEGUARDS,
  repetitions: 10,
});

const ids = (i: GateInputs) => evaluateGate(i).unmet.map((u) => u.id);

describe('pilotCoverage', () => {
  it('reports a condition with no attempt as missing', () => {
    const c = pilotCoverage(CONDITIONS, [attempt('solo.CF.off')]);
    expect(c.missing).toEqual(['pi.CF-AC.on', 'irf.CC-AF-CC.on']);
    expect(c.covered).toEqual(['solo.CF.off']);
  });

  it('does not count operational or unfinished attempts as coverage', () => {
    const c = pilotCoverage(['solo.CF.off', 'pi.CF-AC.on'], [attempt('solo.CF.off', { outcome: 'operational', termination: 'auth-missing' }), attempt('pi.CF-AC.on', { phase: 'awaiting-evaluation', outcome: null })]);
    expect(c.missing).toEqual(['solo.CF.off', 'pi.CF-AC.on']);
    expect(c.operational).toEqual([{ conditionId: 'solo.CF.off', attempt: 1, termination: 'auth-missing' }]);
  });

  it('retains a scored failure as coverage', () => {
    expect(pilotCoverage(['solo.CF.off'], [attempt('solo.CF.off', { outcome: 'scored-failure', termination: 'task-timeout' })]).missing).toEqual([]);
  });
});

describe('exerciseProblems', () => {
  it('accepts a full solo, plan/implement and implement/review/fix pilot', () => {
    for (const c of CONDITIONS) expect(exerciseProblems(attempt(c), PLANS[c]!)).toEqual([]);
  });

  it('rejects an empty stage list even when the attempt finished', () => {
    const p = exerciseProblems(attempt('irf.CC-AF-CC.on', { stages: [] }), PLANS['irf.CC-AF-CC.on']!);
    expect(p).toEqual(expect.arrayContaining(['s1-implement did not run', 's2-review did not run', 's3-fix did not run']));
  });

  it('rejects an early scored failure that never reached review or fix', () => {
    const a = attempt('irf.CC-AF-CC.on', { outcome: 'scored-failure', termination: 'task-timeout' });
    const p = exerciseProblems({ ...a, stages: a.stages.slice(0, 1) }, PLANS['irf.CC-AF-CC.on']!);
    expect(p.join(' ')).toMatch(/s2-review did not run.*s3-fix did not run/);
  });

  it('rejects an operational attempt even with all stages recorded', () => {
    expect(exerciseProblems(attempt('solo.CF.off', { outcome: 'operational' }), PLANS['solo.CF.off']!).join(' ')).toMatch(/not a finished, non-operational/);
  });

  it('rejects a fix that started fresh instead of resuming the implementer', () => {
    const a = withStage(attempt('irf.CC-AF-CC.on'), 's3-fix', { mode: 'fresh', resumedSession: null, sessionId: 'new' });
    expect(exerciseProblems(a, PLANS['irf.CC-AF-CC.on']!).join(' ')).toMatch(/s3-fix should resume s1-implement.*did not resume/);
  });

  it('rejects a fix that resumed a different session', () => {
    const a = withStage(attempt('irf.CC-AF-CC.on'), 's3-fix', { resumedSession: 'someone-else' });
    expect(exerciseProblems(a, PLANS['irf.CC-AF-CC.on']!).join(' ')).toMatch(/did not resume the session of s1-implement/);
  });

  it('rejects a reviewer that shared the implementer session', () => {
    const a = withStage(attempt('irf.CC-AF-CC.on'), 's2-review', { sessionId: 'irf.CC-AF-CC.on-sess-0' });
    expect(exerciseProblems(a, PLANS['irf.CC-AF-CC.on']!).join(' ')).toMatch(/reused the session/);
  });

  it('rejects a fresh stage with no session id or a resumed mode', () => {
    expect(exerciseProblems(withStage(attempt('solo.CF.off'), 's1-implement', { sessionId: null }), PLANS['solo.CF.off']!).join(' ')).toMatch(/no session id/);
    expect(exerciseProblems(withStage(attempt('solo.CF.off'), 's1-implement', { mode: 'resume' }), PLANS['solo.CF.off']!).join(' ')).toMatch(/fresh session/);
  });

  it('rejects a missing, failed or wrong-kind handoff', () => {
    const plan = PLANS['pi.CF-AC.on']!;
    expect(exerciseProblems(withStage(attempt('pi.CF-AC.on'), 's1-plan', { handoff: null }), plan).join(' ')).toMatch(/no usable plan handoff/);
    expect(exerciseProblems(withStage(attempt('pi.CF-AC.on'), 's1-plan', { handoff: { kind: 'plan', status: 'empty', sha256: null, file: null } }), plan).join(' ')).toMatch(/plan empty/);
    expect(exerciseProblems(withStage(attempt('pi.CF-AC.on'), 's1-plan', { handoff: { kind: 'findings', status: 'ok', sha256: 'a', file: 'f' } }), plan).join(' ')).toMatch(/no usable plan handoff/);
  });

  it('rejects a read-only stage whose snapshot changed or was not hashed', () => {
    const plan = PLANS['irf.CC-AF-CC.on']!;
    expect(exerciseProblems(withStage(attempt('irf.CC-AF-CC.on'), 's2-review', { workspaceHashAfter: 'changed' }), plan).join(' ')).toMatch(/read-only snapshot/);
    expect(exerciseProblems(withStage(attempt('irf.CC-AF-CC.on'), 's2-review', { workspaceHashBefore: null, workspaceHashAfter: null }), plan).join(' ')).toMatch(/read-only snapshot/);
  });

  it('rejects partial or missing usage on any stage, including sensor repairs', () => {
    const a = attempt('solo.CF.off');
    const repair = { ...a.stages[0]!, id: 's1-implement-repair-1', kind: 'sensor-repair', mode: 'resume', resumedSession: 'solo.CF.off-sess-0', usageCompleteness: 'partial' };
    expect(exerciseProblems({ ...a, stages: [...a.stages, repair] }, PLANS['solo.CF.off']!)).toEqual(['s1-implement-repair-1 usage partial']);
    expect(exerciseProblems(withStage(a, 's1-implement', { usageCompleteness: 'missing' }), PLANS['solo.CF.off']!)).toEqual(['s1-implement usage missing']);
  });

  it('rejects a stage launched without OS isolation or with no stage record', () => {
    expect(exerciseProblems(withStage(attempt('solo.CF.off'), 's1-implement', { isolationMechanism: 'none' }), PLANS['solo.CF.off']!)).toEqual(['s1-implement isolation none']);
    expect(exerciseProblems(withStage(attempt('solo.CF.off'), 's1-implement', { isolationMechanism: null }), PLANS['solo.CF.off']!)).toEqual(['s1-implement isolation unrecorded']);
  });

  it('rejects a stage whose role differs from the plan or whose model was not recorded', () => {
    expect(exerciseProblems(withStage(attempt('solo.CF.off'), 's1-implement', { role: 'CC' }), PLANS['solo.CF.off']!).join(' ')).toMatch(/planned implement\/CF/);
    expect(exerciseProblems(withStage(attempt('solo.CF.off'), 's1-implement', { resolvedModel: null }), PLANS['solo.CF.off']!)).toEqual(['s1-implement resolved model unrecorded']);
  });

  it('rejects any attempt when the configuration has no plan', () => {
    expect(exerciseProblems(attempt('solo.CF.off'), [])).toContain('no planned stages for this configuration');
  });

  describe('properties', () => {
    it('never accepts an attempt missing any planned stage', () => {
      fc.assert(
        fc.property(fc.constantFrom(...CONDITIONS), fc.nat(), (c, k) => {
          const a = attempt(c);
          const drop = k % a.stages.length;
          expect(exerciseProblems({ ...a, stages: a.stages.filter((_, i) => i !== drop) }, PLANS[c]!).length).toBeGreaterThan(0);
        }),
      );
    });
  });
});

describe('pilotExerciseCoverage', () => {
  it('keeps a failed early pilot as coverage but reports the configuration unexercised', () => {
    const early = { ...attempt('irf.CC-AF-CC.on', { outcome: 'scored-failure' }), stages: [] };
    const atts = [attempt('solo.CF.off'), attempt('pi.CF-AC.on'), early];
    expect(pilotCoverage(CONDITIONS, atts).missing).toEqual([]);
    const e = pilotExerciseCoverage(CONDITIONS, PLANS, atts);
    expect(e.unexercised.map((u) => u.conditionId)).toEqual(['irf.CC-AF-CC.on']);
    expect(e.unexercised[0]!.problems[0]).toMatch(/^attempt 1: s1-implement did not run/);
  });

  it('is satisfied by a later full pilot after an early failure, and names it', () => {
    const atts = [{ ...attempt('solo.CF.off', { outcome: 'scored-failure' }), stages: [] }, attempt('solo.CF.off', { attempt: 2 })];
    expect(pilotExerciseCoverage(['solo.CF.off'], PLANS, atts).exercised).toEqual([{ conditionId: 'solo.CF.off', attempt: 2 }]);
  });

  it('reports a configuration with no pilot attempt', () => {
    expect(pilotExerciseCoverage(['solo.CF.off'], PLANS, []).unexercised).toEqual([{ conditionId: 'solo.CF.off', problems: ['no pilot attempt'] }]);
  });
});

describe('pilotEstimate', () => {
  it('is unavailable until every condition has an exercised pilot', () => {
    const r = pilotEstimate(CONDITIONS, PLANS, [attempt('solo.CF.off')], 10);
    expect(r.estimate).toBeNull();
    expect(r.gaps).toEqual([
      { conditionId: 'pi.CF-AC.on', attempt: null, reason: 'no-exercised-pilot' },
      { conditionId: 'irf.CC-AF-CC.on', attempt: null, reason: 'no-exercised-pilot' },
    ]);
  });

  it('scales observed pilot time by the repetitions and records the observations', () => {
    const plans = { a: PLANS['solo.CF.off']!, b: PLANS['solo.CF.off']! };
    const mk = (c: string, activeMs: number, durationMs: number) => ({ ...attempt('solo.CF.off', { activeMs, evaluation: { status: 'passed', durationMs } }), conditionId: c });
    const { estimate: e } = pilotEstimate(['a', 'b'], plans, [mk('a', 3_600_000, 60_000), mk('b', 1_800_000, 0)], 10);
    expect(e!.activeHours).toBeCloseTo(15);
    expect(e!.evaluationHours).toBeCloseTo(10 / 60);
    expect(e!.pilotActiveHours).toBeCloseTo(1.5);
    expect(e!.observations).toEqual([
      { conditionId: 'a', attempt: 1, activeMs: 3_600_000, evaluationMs: 60_000 },
      { conditionId: 'b', attempt: 1, activeMs: 1_800_000, evaluationMs: 0 },
    ]);
    expect(e!.basis).toMatch(/one exercised pilot per configuration/);
  });

  it('ignores an early failed pilot’s short duration in favour of the exercised one', () => {
    const atts = [{ ...attempt('solo.CF.off', { outcome: 'scored-failure', activeMs: 1000 }), stages: [] }, attempt('solo.CF.off', { attempt: 2, activeMs: 900_000 })];
    expect(pilotEstimate(['solo.CF.off'], PLANS, atts, 10).estimate!.observations[0]).toMatchObject({ attempt: 2, activeMs: 900_000 });
  });

  it.each([
    [{ activeMs: null }, 'active-missing'],
    [{ activeMs: -5 }, 'active-invalid'],
    [{ activeMs: 0 }, 'active-invalid'],
    [{ activeMs: Number.NaN }, 'active-invalid'],
    [{ evaluation: null }, 'evaluation-not-run'],
    [{ evaluation: { status: 'not-run', durationMs: null } }, 'evaluation-not-run'],
    [{ evaluation: { status: 'failed', durationMs: null } }, 'evaluation-duration-unknown'],
    [{ evaluation: { status: 'passed', durationMs: -1 } }, 'evaluation-duration-invalid'],
    [{ evaluation: { status: 'passed', durationMs: Number.POSITIVE_INFINITY } }, 'evaluation-duration-invalid'],
  ] as [Partial<PilotAttempt>, string][])('makes the estimate unavailable for %o (%s), never counting it as zero', (over, reason) => {
    const r = pilotEstimate(['solo.CF.off'], PLANS, [attempt('solo.CF.off', over)], 10);
    expect(r.estimate).toBeNull();
    expect(r.gaps).toEqual([{ conditionId: 'solo.CF.off', attempt: 1, reason }]);
  });

  it('is unavailable for invalid repetitions', () => {
    expect(pilotEstimate(['solo.CF.off'], PLANS, [attempt('solo.CF.off')], 0).estimate).toBeNull();
  });

  describe('properties', () => {
    it('is non-negative and linear in repetitions', () => {
      fc.assert(
        fc.property(fc.array(fc.integer({ min: 1, max: 1_800_000 }), { minLength: 1, maxLength: 24 }), fc.integer({ min: 1, max: 20 }), (ms, reps) => {
          const conds = ms.map((_, i) => `c${i}`);
          const plans = Object.fromEntries(conds.map((c) => [c, PLANS['solo.CF.off']!]));
          const atts = ms.map((m, i) => ({ ...attempt('solo.CF.off', { activeMs: m, evaluation: { status: 'passed', durationMs: m % 120_000 } }), conditionId: `c${i}` }));
          const one = pilotEstimate(conds, plans, atts, 1).estimate!;
          const many = pilotEstimate(conds, plans, atts, reps).estimate!;
          expect(one.activeHours).toBeGreaterThan(0);
          expect(many.activeHours).toBeCloseTo(one.activeHours * reps, 6);
          expect(many.evaluationHours).toBeCloseTo(one.evaluationHours * reps, 6);
          expect(many.observations).toHaveLength(conds.length);
        }),
      );
    });

    it('either yields an estimate or at least one gap, never both empty', () => {
      fc.assert(
        fc.property(fc.option(fc.double({ noNaN: false }), { nil: null }), fc.option(fc.double({ noNaN: false }), { nil: null }), (activeMs, durationMs) => {
          const r = pilotEstimate(['solo.CF.off'], PLANS, [attempt('solo.CF.off', { activeMs, evaluation: { status: 'passed', durationMs } })], 10);
          expect(r.estimate === null).toBe(r.gaps.length > 0);
          if (r.estimate) expect(r.estimate.evaluationHours).toBeGreaterThanOrEqual(0);
        }),
      );
    });
  });
});

describe('safeguardProblems', () => {
  it('passes complete record and attestation evidence', () => {
    expect(safeguardProblems(SAFEGUARDS)).toEqual([]);
  });

  it('requires every safeguard', () => {
    expect(safeguardProblems([]).map((u) => u.id)).toEqual(['safeguard:paid-overflow-guard', 'safeguard:quota-pausing', 'safeguard:recovery']);
  });

  it('rejects entries without refs, with unresolved refs, or without a statement', () => {
    const [g, ...rest] = SAFEGUARDS;
    expect(safeguardProblems([{ ...g!, refs: [] }, ...rest])[0]!.detail).toMatch(/cites no record/);
    expect(safeguardProblems([{ ...g!, missingRefs: ['x.md'] }, ...rest])[0]!.detail).toMatch(/not found: x.md/);
    expect(safeguardProblems([{ ...g!, statement: ' ' }, ...rest])[0]!.detail).toMatch(/no statement/);
  });

  it('rejects a human attestation without attester or date, and unknown kinds', () => {
    const [g, ...rest] = SAFEGUARDS;
    expect(safeguardProblems([{ ...g!, attestedBy: null }, ...rest])[0]!.detail).toMatch(/attestedBy/);
    expect(safeguardProblems([{ ...g!, attestedAt: 'last week' }, ...rest])[0]!.detail).toMatch(/attestedAt/);
    expect(safeguardProblems([{ ...g!, kind: 'vibes' }, ...rest])[0]!.detail).toMatch(/unknown evidence kind/);
  });
});

describe('treeDigest', () => {
  it('changes when a file’s content changes', () => {
    expect(treeDigest([{ path: 'a', sha256: '1' }])).not.toBe(treeDigest([{ path: 'a', sha256: '2' }]));
  });

  it('changes when a file is renamed', () => {
    expect(treeDigest([{ path: 'a', sha256: '1' }])).not.toBe(treeDigest([{ path: 'b', sha256: '1' }]));
  });

  describe('properties', () => {
    it('is independent of listing order', () => {
      fc.assert(
        fc.property(fc.uniqueArray(fc.record({ path: fc.string({ minLength: 1 }), sha256: fc.stringMatching(/^[0-9a-f]{64}$/) }), { selector: (f) => f.path }), (files) => {
          expect(treeDigest([...files].reverse())).toBe(treeDigest(files));
          expect(treeDigest(files)).toMatch(/^[0-9a-f]{64}$/);
        }),
      );
    });
  });
});

describe('evaluateGate', () => {
  it('passes when every condition holds and returns the estimate', () => {
    const g = evaluateGate(goodInputs());
    expect(g.unmet).toEqual([]);
    expect(g.ready).toBe(true);
    expect(g.estimate!.observations).toHaveLength(CONDITIONS.length);
  });

  it('regression: blocks a pilot set whose implement/review/fix pilot has no stages', () => {
    const atts = goodInputs().attempts.map((a) => (a.conditionId === 'irf.CC-AF-CC.on' ? { ...a, stages: [] } : a));
    const g = evaluateGate({ ...goodInputs(), attempts: atts });
    expect(g.ready).toBe(false);
    expect(g.unmet.map((u) => u.id)).toEqual(expect.arrayContaining(['pilot-exercise', 'pilot-estimate']));
    expect(g.unmet.map((u) => u.id)).not.toContain('pilots');
  });

  it('regression: blocks when the estimate is missing because an active duration is unknown', () => {
    const atts = goodInputs().attempts.map((a, i) => (i === 0 ? { ...a, activeMs: null } : a));
    const g = evaluateGate({ ...goodInputs(), attempts: atts });
    expect(g.ready).toBe(false);
    expect(g.estimate).toBeNull();
    expect(g.unmet.find((u) => u.id === 'pilot-estimate')!.detail).toMatch(/solo.CF.off active-missing/);
  });

  it('regression: blocks when an evaluation duration is unknown instead of treating it as zero', () => {
    const atts = goodInputs().attempts.map((a, i) => (i === 1 ? { ...a, evaluation: { status: 'passed', durationMs: null } } : a));
    const g = evaluateGate({ ...goodInputs(), attempts: atts });
    expect(g.ready).toBe(false);
    expect(g.estimateGaps).toEqual([{ conditionId: 'pi.CF-AC.on', attempt: 1, reason: 'evaluation-duration-unknown' }]);
  });

  it('regression: blocks without paid-overflow, quota-pausing and recovery evidence', () => {
    expect(ids({ ...goodInputs(), safeguards: [] })).toEqual(['safeguard:paid-overflow-guard', 'safeguard:quota-pausing', 'safeguard:recovery']);
  });

  it('blocks on missing subscription access and names the provider', () => {
    const g = evaluateGate({ ...goodInputs(), preflight: { codex: { ok: false, termination: 'auth-missing' }, claude: { ok: true, termination: null } } });
    expect(g.ready).toBe(false);
    expect(g.unmet.map((u) => u.id)).toContain('subscription-access:codex');
  });

  it('blocks when no OS sandbox can be applied', () => {
    expect(ids({ ...goodInputs(), sandboxTool: null })).toContain('isolation');
  });

  it('blocks while Codex usage semantics remain unsettled', () => {
    expect(ids({ ...goodInputs(), usageSemantics: { codex: { status: 'unverified', turnCompletedScope: null, cachedInputSubsetOfInput: null, reasoningIncludedInOutput: null } } })).toContain('usage-semantics:codex');
  });

  it('blocks on an unreproducible schedule and on missing pilots', () => {
    expect(ids({ ...goodInputs(), scheduleReproduces: false, attempts: [] })).toEqual(expect.arrayContaining(['schedule', 'pilots', 'pilot-exercise', 'pilot-estimate']));
  });

  it('blocks on a pilot stage served by a model other than the one requested, even in a failed pilot', () => {
    const atts = goodInputs().attempts.map((a, i) => (i === 0 ? withStage({ ...a, outcome: 'scored-failure' }, 's1-implement', { resolvedModel: 'gpt-6-astra-mini' }) : a));
    expect(ids({ ...goodInputs(), attempts: atts })).toContain('resolved-models');
  });

  it('does not block on a missing price snapshot but records it', () => {
    const g = evaluateGate({ ...goodInputs(), priceSnapshot: { present: false } });
    expect(g.ready).toBe(true);
    expect(g.warnings.join(' ')).toMatch(/price/);
  });
});

describe('working shell', () => {
  it('fails a planned implement stage whose every shell command failed', () => {
    const a = withStage(attempt('pi.CF-AC.on'), 's2-implement', { shell: SHELL_BROKEN });
    expect(exerciseProblems(a, PLANS['pi.CF-AC.on']!)).toEqual([`s2-implement shell: all 2 shell command(s) failed (${SOCAT})`]);
  });

  it('fails a planned implement stage that ran no command, or has no event stream', () => {
    expect(exerciseProblems(withStage(attempt('solo.CF.off'), 's1-implement', { shell: SHELL_NONE }), PLANS['solo.CF.off']!)).toEqual(['s1-implement shell: ran no shell command']);
    expect(exerciseProblems(withStage(attempt('solo.CF.off'), 's1-implement', { shell: null }), PLANS['solo.CF.off']!)).toEqual(['s1-implement shell: no event stream recorded']);
  });

  it('does not judge fix, sensor-repair or read-only stages: a failing build there is not a broken shell', () => {
    expect(exerciseProblems(withStage(attempt('irf.CC-AF-CC.on'), 's3-fix', { shell: SHELL_BROKEN }), PLANS['irf.CC-AF-CC.on']!)).toEqual([]);
    expect(exerciseProblems(withStage(attempt('irf.CC-AF-CC.on'), 's3-fix', { shell: null }), PLANS['irf.CC-AF-CC.on']!)).toEqual([]);
    const base = attempt('solo.CF.off');
    const repair: PilotStage = { ...base.stages[0]!, id: 's1-implement-repair-1', mode: 'resume', resumedSession: base.stages[0]!.sessionId, shell: SHELL_BROKEN };
    expect(exerciseProblems({ ...base, stages: [...base.stages, repair] }, PLANS['solo.CF.off']!).filter((x) => x.includes('shell'))).toEqual([]);
    expect(exerciseProblems(withStage(attempt('pi.CF-AC.on'), 's1-plan', { shell: null }), PLANS['pi.CF-AC.on']!)).toEqual([]);
  });

  it('blocks the gate through pilot-exercise', () => {
    const attempts = CONDITIONS.map((c) => attempt(c));
    attempts[1] = withStage(attempts[1]!, 's2-implement', { shell: SHELL_BROKEN });
    const ids = evaluateGate({ ...goodInputs(), attempts }).unmet.map((u) => u.id);
    expect(ids).toContain('pilot-exercise');
  });

  describe('properties', () => {
    it('an implement stage is blocked exactly when it has no successful command; a fix stage never is', () => {
      fc.assert(
        fc.property(fc.nat({ max: 50 }), fc.nat({ max: 50 }), fc.constantFrom('s1-implement', 's3-fix'), (ok, bad, id) => {
          const shell: ShellHealth = { attempted: ok + bad, succeeded: ok, failed: bad, malformedLines: 0, firstFailure: bad > 0 ? 'x' : null };
          const problems = exerciseProblems(withStage(attempt('irf.CC-AF-CC.on'), id, { shell }), PLANS['irf.CC-AF-CC.on']!).filter((x) => x.includes('shell'));
          return problems.length === (id === 's1-implement' && ok === 0 ? 1 : 0);
        }),
      );
    });
  });
});
