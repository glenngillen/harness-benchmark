import { BEHAVIOURS, type Behaviour, type CaseResult, type EvaluationStatus } from './types.ts';

export type Preflight = 'ready' | 'missing-output' | 'snapshot-too-large' | 'build-failed';

export interface SummaryInput {
  catalogue: readonly { id: string; behaviour: Behaviour; title: string }[];
  preflight: Preflight;
  results: readonly CaseResult[];
  infrastructure: string | null;
  ceilingReached: boolean;
}

export interface BehaviourSummary {
  passed: boolean;
  cases: number;
  passedCases: number;
}

export interface Summary {
  status: EvaluationStatus;
  reason: string;
  cases: CaseResult[];
  behaviours: Record<Behaviour, BehaviourSummary>;
  passedCases: number;
  totalCases: number;
}

/**
 * Pure: the evaluation outcome. Every catalogued case appears exactly once (missing ones are failed
 * as not run). `passed` requires every case to pass; an infrastructure problem is operational and
 * overrides any app outcome; an app that produced nothing usable fails every case.
 */
export function summarise(input: SummaryInput): Summary {
  const byId = new Map(input.results.map((r) => [r.id, r]));
  const notRun = input.preflight !== 'ready' ? `not run: ${input.preflight}` : 'not run';
  const cases = input.catalogue.map(
    (c) =>
      (input.preflight === 'ready' ? byId.get(c.id) : undefined) ?? { id: c.id, behaviour: c.behaviour, title: c.title, passed: false, detail: notRun, durationMs: 0 },
  );
  const behaviours = Object.fromEntries(
    BEHAVIOURS.map((b) => {
      const own = cases.filter((c) => c.behaviour === b);
      const passedCases = own.filter((c) => c.passed).length;
      return [b, { passed: own.length > 0 && passedCases === own.length, cases: own.length, passedCases }];
    }),
  ) as Record<Behaviour, BehaviourSummary>;
  const passedCases = cases.filter((c) => c.passed).length;
  const base = { cases, behaviours, passedCases, totalCases: cases.length };
  if (input.infrastructure !== null) return { ...base, status: 'infrastructure-failure', reason: input.infrastructure };
  if (input.preflight !== 'ready') return { ...base, status: 'failed', reason: input.preflight };
  if (passedCases === cases.length && cases.length > 0) return { ...base, status: 'passed', reason: 'all cases passed' };
  return { ...base, status: 'failed', reason: input.ceilingReached ? 'ceiling-reached' : 'cases-failed' };
}
