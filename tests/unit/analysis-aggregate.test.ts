import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { scaleSnapshot } from '../../src/accounting/prices.ts';
import { aggregate, AnalysisValidationError, type AnalysisOptions } from '../../src/analysis/aggregate.ts';
import { COMMITTED, fullCampaign, MATRIX, MODELS, PROV, SCHEDULE, SNAP, SETTLED, synth } from './support/synthetic-records.ts';

const OPTS: AnalysisOptions = {
  label: 'cohort-03',
  dataset: 'synthetic',
  matrix: MATRIX,
  schedule: SCHEDULE,
  roles: MODELS.roles,
  bootstrap: { seed: 20261114, resamples: 500, confidence: 0.95 },
};

const cond = (a: ReturnType<typeof aggregate>, id: string) => {
  for (const w of Object.values(a.workflows)) {
    const c = w.conditions.find((x) => x.conditionId === id);
    if (c) return c;
  }
  throw new Error(`no ${id}`);
};

describe('aggregate: structure and denominators', () => {
  const recs = fullCampaign((s) => ({ accepted: s.block % 2 === 0 ? true : s.conditionId.startsWith('solo') ? false : true, termination: s.block % 2 === 0 || !s.conditionId.startsWith('solo') ? 'completed' : 'task-timeout' }));
  const a = aggregate(recs, OPTS);

  it('separates the three workflows, each with its own eight conditions in canonical order', () => {
    expect(Object.keys(a.workflows)).toEqual(['solo', 'pi', 'irf']);
    expect(a.workflows.solo!.conditions.map((c) => c.conditionId)).toEqual(MATRIX.canonicalConditionOrder.slice(0, 8));
    expect(a.workflows.pi!.conditions).toHaveLength(8);
    expect(a.workflows.irf!.conditions).toHaveLength(8);
    expect(a.workflows.pi!.controls).toEqual(MATRIX.canonicalConditionOrder.slice(0, 8));
  });

  it('reports a complete campaign with 240 scored workflows and labels the dataset', () => {
    expect(a.dataset).toBe('synthetic');
    expect(a.completeness).toMatchObject({ scheduledSlots: 240, scoredSlots: 240, complete: true, missingSlots: [] });
  });

  it('counts accepted out of scored, with the Wilson interval and termination counts', () => {
    const c = cond(a, 'solo.CF.off');
    expect(c).toMatchObject({ scored: 10, expected: 10, accepted: 5, outcomes: { completed: 5, 'task-timeout': 5 } });
    expect(c.acceptance.estimate).toBe(0.5);
    expect(c.acceptance.lower).toBeCloseTo(0.2366, 4);
    expect(c.assignment).toEqual(['CF']);
    expect(c.checks).toBe('off');
  });

  it('includes failed workflows in the cost numerator; failure cost is reported separately', () => {
    const c = cond(a, 'solo.CF.off');
    const total = BigInt(c.totalCost.picoUsd!);
    const fail = BigInt(c.failureCost.picoUsd!);
    expect(fail * 2n).toBe(total); // identical synthetic usage per workflow, half failed
    expect(c.costPerAccepted.status).toBe('exact');
    expect(c.costPerAccepted.numeratorPicoUsd).toBe(total.toString());
    expect(c.costPerAccepted.accepted).toBe(5);
    expect(c.costPerAccepted.usd).toBeCloseTo(Number(total) / 5 / 1e12, 12);
  });

  it('sums role costs per stage kind and role to the condition total', () => {
    const c = cond(a, 'irf.CC-AF-CC.on');
    expect(Object.keys(c.byRole)).toEqual(['implement:CC', 'review:AF', 'fix:CC']);
    const sum = Object.values(c.byRole).reduce((s, r) => s + BigInt(r.cost.picoUsd!), 0n);
    expect(sum.toString()).toBe(c.totalCost.picoUsd);
  });

  it('summarises elapsed time and token categories with every observation in schedule order', () => {
    const c = cond(a, 'pi.AF-AC.on');
    expect(c.elapsedMs).toMatchObject({ n: 10, median: 600_000, min: 600_000, max: 600_000 });
    expect(c.elapsedMs.observations).toHaveLength(10);
    expect(c.tokens.input_tokens!.n).toBe(10);
    expect(c.tokens.input_tokens!.median).toBe(10_000 + 20_000);
    expect(c.tokens.output_tokens!.median).toBe(2000);
    expect(c.tokensNotExact).toBe(0);
    expect(c.workflows.map((w) => w.block)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('computes a bootstrap only on exact costs and records its settings', () => {
    const c = cond(a, 'solo.CF.off');
    expect(c.bootstrap.status).toBe('computed');
    expect(c.bootstrap.exact!.resamples).toBe(500);
    expect(c.bootstrap.exact!.undefinedFraction).toBeGreaterThanOrEqual(0);
  });
});

describe('aggregate: zero successes, unavailable and bounded costs', () => {
  it('zero accepted gives no finite cost per accepted workflow and a fully undefined bootstrap', () => {
    const a = aggregate(fullCampaign((s) => (s.conditionId === 'solo.AC.on' ? { termination: 'stage-timeout' } : {})), OPTS);
    const c = cond(a, 'solo.AC.on');
    expect(c.accepted).toBe(0);
    expect(c.costPerAccepted).toMatchObject({ status: 'undefined', usd: null, lowerUsd: null, upperUsd: null });
    expect(c.totalCost.status).toBe('exact');
    expect(c.bootstrap.exact!.undefinedFraction).toBe(1);
    expect(c.bootstrap.exact!.upper).toBeNull();
  });

  it('a missing stage record makes the condition cost lower-bound only and suppresses the interval', () => {
    const a = aggregate(fullCampaign((s) => (s.conditionId === 'pi.CF-CC.off' && s.block === 3 ? { missingStages: [1], termination: 'task-timeout' } : {})), OPTS);
    const c = cond(a, 'pi.CF-CC.off');
    expect(c.totalCost.status).toBe('unavailable');
    expect(c.costPerAccepted.status).toBe('unavailable');
    expect(c.costPerAccepted.usd).toBeNull();
    expect(c.bootstrap.status).toBe('suppressed');
    expect(c.measurement).toEqual({ complete: 9, partial: 1, missing: 0 });
    expect(c.tokensNotExact).toBe(1);
    expect(c.tokens.input_tokens!.n).toBe(9);
  });

  it('unsettled Codex semantics leave Codex conditions as lower bounds, never a single finite figure', () => {
    const a = aggregate(fullCampaign(() => ({}), 10, SNAP, COMMITTED), OPTS);
    const codex = cond(a, 'solo.CC.on');
    expect(codex.totalCost.status).toBe('lower-bound');
    expect(codex.costPerAccepted.status).toBe('lower-bound');
    expect(codex.costPerAccepted.usd).toBeNull();
    expect(codex.costPerAccepted.lowerUsd).not.toBeNull();
    expect(codex.bootstrap.status).toBe('suppressed');
    const claude = cond(a, 'solo.AC.on');
    expect(claude.costPerAccepted.status).toBe('exact');
  });
});

describe('aggregate: partial campaigns, operational attempts and exclusions', () => {
  it('reports an incomplete campaign with its missing slots, pending attempts excluded from scoring', () => {
    const recs = fullCampaign(() => ({}), 2);
    recs.pop();
    recs.push(synth({ ...SCHEDULE.blocks[1]!.slots[23]!, phase: 'running' }));
    const a = aggregate(recs, OPTS);
    expect(a.completeness.complete).toBe(false);
    expect(a.completeness.scoredSlots).toBe(47);
    expect(a.completeness.missingSlots).toHaveLength(240 - 47);
    expect(a.completeness.pendingAttempts).toEqual([{ block: 2, slot: 24, attempt: 1, conditionId: SCHEDULE.blocks[1]!.slots[23]!.conditionId, phase: 'running' }]);
    const c = cond(a, SCHEDULE.blocks[1]!.slots[23]!.conditionId);
    expect(c.scored).toBe(1);
    expect(c.expected).toBe(10);
  });

  it('keeps operational attempts out of the denominators but reports their usage, cost and waits', () => {
    const recs = fullCampaign(() => ({}));
    const slot = SCHEDULE.blocks[0]!.slots[0]!;
    const idx = recs.findIndex((r) => r.block === 1 && r.slot === 1);
    recs[idx] = synth({ ...slot, attempt: 2, replaces: 1, waitBeforeMs: 3_600_000 });
    recs.push(synth({ ...slot, attempt: 1, termination: 'quota-exhausted', tokens: 5000 }));
    const a = aggregate(recs, OPTS);
    expect(cond(a, slot.conditionId).scored).toBe(10);
    expect(a.operational.attempts).toBe(1);
    expect(a.operational.byTermination).toEqual({ 'quota-exhausted': 1 });
    expect(a.operational.cost.status).toBe('exact');
    expect(BigInt(a.operational.cost.picoUsd!)).toBeGreaterThan(0n);
    expect(a.operational.waitMs).toBe(3_600_000);
    expect(a.operational.exclusions).toEqual([expect.objectContaining({ block: 1, slot: 1, attempt: 1, conditionId: slot.conditionId, termination: 'quota-exhausted', replacedBy: 2 })]);
    expect(cond(a, slot.conditionId).operational).toMatchObject({ attempts: 1 });
  });

  it('sums evaluator time separately from active workflow time', () => {
    const a = aggregate(fullCampaign(() => ({ evaluatorMs: 10_000 })), OPTS);
    expect(a.overhead.evaluatorMs).toBe(240 * 10_000);
    expect(cond(a, 'solo.CF.on').evaluatorMs.median).toBe(10_000);
  });
});

describe('aggregate: validation', () => {
  const base = () => fullCampaign(() => ({}), 1);
  const fails = (recs: ReturnType<typeof base>, re: RegExp) => {
    let err: unknown;
    try {
      aggregate(recs, OPTS);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AnalysisValidationError);
    expect((err as AnalysisValidationError).problems.join('\n')).toMatch(re);
  };

  it('rejects a duplicated attempt', () => {
    const r = base();
    fails([...r, r[0]!], /duplicate attempt/);
  });
  it('rejects two scored attempts in one slot', () => {
    const r = base();
    fails([...r, synth({ ...SCHEDULE.blocks[0]!.slots[0]!, attempt: 2, replaces: 1 })], /more than one scored attempt/);
  });
  it('rejects a condition that disagrees with the frozen schedule', () => {
    const r = base();
    const wrong = SCHEDULE.blocks[0]!.slots[1]!.conditionId;
    r[0] = synth({ ...SCHEDULE.blocks[0]!.slots[0]!, conditionId: wrong });
    fails(r, /schedule/);
  });
  it('rejects an unknown condition, a foreign campaign and a dangling replacement link', () => {
    fails([...base().slice(1), synth({ block: 1, slot: 1, conditionId: 'solo.XX.off', campaign: 'cohort-03' })], /unknown condition/);
    fails([...base().slice(1), synth({ ...SCHEDULE.blocks[0]!.slots[0]!, campaign: 'pilot-01' })], /campaign/);
    const r = base();
    r[0] = synth({ ...SCHEDULE.blocks[0]!.slots[0]!, attempt: 3, replaces: 2 });
    fails(r, /replaces attempt 2/);
  });
  it('rejects records valued against more than one price snapshot', () => {
    const r = base();
    r[0] = synth(SCHEDULE.blocks[0]!.slots[0]!, SNAP, SETTLED, { ...PROV, priceSnapshot: { file: 'prices/other.csv', sha256: 'other' } });
    fails(r, /price snapshot/);
  });
  it('rejects an accepted workflow that did not complete, and a scored one that was never evaluated', () => {
    const r = base();
    r[0] = synth({ ...SCHEDULE.blocks[0]!.slots[0]!, termination: 'task-timeout', accepted: true });
    fails(r, /accepted without completing/);
    const q = base();
    q[0] = synth({ ...SCHEDULE.blocks[0]!.slots[0]!, accepted: null });
    fails(q, /no acceptance verdict/);
  });
  it('rejects more scored workflows than the condition expects', () => {
    const extra = synth({ block: 11, slot: 1, conditionId: 'solo.CF.off' });
    fails([...fullCampaign(() => ({})), extra], /block 11|more than/);
  });
});

describe('aggregate: properties', () => {
  it('is invariant to the order records are read in', () => {
    const recs = fullCampaign((s) => ({ termination: (s.block + s.slot) % 3 === 0 ? 'stage-timeout' : 'completed', tokens: 1000 * ((s.block * 7 + s.slot) % 11) + 500, activeMs: 1000 * s.slot }), 3);
    const a = JSON.stringify(aggregate(recs, OPTS));
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: recs.length, maxLength: recs.length }), (keys) => {
        const shuffled = recs.map((r, i) => [keys[i]!, r] as const).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
        expect(JSON.stringify(aggregate(shuffled, OPTS))).toBe(a);
      }),
      { numRuns: 8 },
    );
  });

  it('repricing every rate by k scales every cost numerator by exactly k within fixed tiers and changes no measured quantity', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 50 }), (k) => {
        const f = (s: { block: number; slot: number }) => ({ termination: s.slot % 4 === 0 ? 'task-timeout' : 'completed', tokens: 2000 + 100 * s.slot });
        const a = aggregate(fullCampaign(f, 2), OPTS);
        const b = aggregate(fullCampaign(f, 2, scaleSnapshot(SNAP, BigInt(k))), OPTS);
        for (const [wf, w] of Object.entries(a.workflows)) {
          w.conditions.forEach((c, i) => {
            const d = b.workflows[wf]!.conditions[i]!;
            expect(BigInt(d.totalCost.picoUsd!)).toBe(BigInt(c.totalCost.picoUsd!) * BigInt(k));
            if (c.costPerAccepted.numeratorPicoUsd) expect(BigInt(d.costPerAccepted.numeratorPicoUsd!)).toBe(BigInt(c.costPerAccepted.numeratorPicoUsd) * BigInt(k));
            expect(d.tokens).toEqual(c.tokens);
            expect(d.acceptance).toEqual(c.acceptance);
            expect(d.elapsedMs).toEqual(c.elapsedMs);
          });
        }
      }),
      { numRuns: 5 },
    );
  });

  it('accepted never exceeds scored, and condition totals equal the sum of their workflows', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 24, maxLength: 24 }), (acc) => {
        const a = aggregate(fullCampaign((s) => ({ termination: acc[s.slot - 1] ? 'completed' : 'repair-budget-exhausted' }), 1), OPTS);
        for (const w of Object.values(a.workflows))
          for (const c of w.conditions) {
            expect(c.accepted).toBeLessThanOrEqual(c.scored);
            const sum = c.workflows.reduce((s, x) => s + BigInt(x.cost.picoUsd!), 0n);
            expect(sum.toString()).toBe(c.totalCost.picoUsd);
          }
      }),
      { numRuns: 10 },
    );
  });
});
