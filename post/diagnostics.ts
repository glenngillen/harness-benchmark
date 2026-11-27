/**
 * Post-hoc diagnostics for the article (pure functions). These describe WHY scored workflows were
 * rejected and what the deterministic checks caught. They never change a verdict, an acceptance, a
 * denominator or a cost: acceptance stays "completed and every evaluator case passed"
 * (methodology section 9), and per-behaviour results are the secondary diagnostic that section allows.
 *
 * This directory sits outside src/ on purpose: it was written after the runner was frozen, and the
 * freeze manifest digests src/ as the runner. Nothing here is used by the runner or the evaluator.
 */

export const START_CASE = 'A1.starts-and-answers-health';
export const INFLIGHT_CASE = 'A7.inflight-resumed';
/** Prefix of the evaluator's failure detail for the attempt-count assertion in A7.inflight-resumed. */
export const ATTEMPT_COUNT_DETAIL = 'attempts must count the interrupted attempt';

export interface DiagnosticCase {
  id: string;
  passed: boolean;
  detail: string;
}

export interface DiagnosticRow {
  conditionId: string;
  block: number;
  slot: number;
  scored: boolean;
  accepted: boolean | null;
  /** The evaluator's own build of the frozen snapshot; null when the verdict did not record one. */
  buildOk: boolean | null;
  cases: DiagnosticCase[];
  checkRuns: Array<{ status: string; failedSuites: string[] }>;
}

export const CLASSES = ['accepted', 'build-failed', 'did-not-start', 'inflight-attempt-count-only', 'other'] as const;
export type RejectionClass = (typeof CLASSES)[number];

/** One class per workflow, checked in this order: accepted, build failed, never answered health, only the attempt-count assertion, anything else. */
export function classifyRejection(r: DiagnosticRow): RejectionClass {
  if (r.accepted === true) return 'accepted';
  if (r.buildOk === false) return 'build-failed';
  const failed = r.cases.filter((c) => !c.passed);
  if (failed.some((c) => c.id === START_CASE)) return 'did-not-start';
  if (failed.length === 1 && failed[0]!.id === INFLIGHT_CASE && failed[0]!.detail.startsWith(ATTEMPT_COUNT_DETAIL)) return 'inflight-attempt-count-only';
  return 'other';
}

export type RejectionCounts = { conditionId: string; scored: number } & Record<RejectionClass, number>;

export function rejectionTable(rows: readonly DiagnosticRow[]): RejectionCounts[] {
  const by = new Map<string, RejectionCounts>();
  for (const r of rows) {
    if (!r.scored) continue;
    const c = by.get(r.conditionId) ?? { conditionId: r.conditionId, scored: 0, accepted: 0, 'build-failed': 0, 'did-not-start': 0, 'inflight-attempt-count-only': 0, other: 0 };
    c.scored += 1;
    c[classifyRejection(r)] += 1;
    by.set(r.conditionId, c);
  }
  return [...by.values()].sort((a, b) => (a.conditionId < b.conditionId ? -1 : a.conditionId > b.conditionId ? 1 : 0));
}

export interface CheckRunCounts {
  workflowsWithChecks: number;
  runs: number;
  passedRuns: number;
  failedRuns: number;
  failedBySuite: Record<string, number>;
  /** Workflows whose last check run passed, split by independent acceptance. */
  finalPassedAccepted: number;
  finalPassedRejected: number;
  finalFailed: number;
}

/** Deterministic check runs over scored workflows (only checks-on workflows have any). */
export function checkRunTable(rows: readonly DiagnosticRow[]): CheckRunCounts {
  const t: CheckRunCounts = { workflowsWithChecks: 0, runs: 0, passedRuns: 0, failedRuns: 0, failedBySuite: {}, finalPassedAccepted: 0, finalPassedRejected: 0, finalFailed: 0 };
  for (const r of rows) {
    if (!r.scored || r.checkRuns.length === 0) continue;
    t.workflowsWithChecks += 1;
    for (const run of r.checkRuns) {
      t.runs += 1;
      if (run.status === 'passed') t.passedRuns += 1;
      else {
        t.failedRuns += 1;
        for (const s of run.failedSuites) t.failedBySuite[s] = (t.failedBySuite[s] ?? 0) + 1;
      }
    }
    const last = r.checkRuns[r.checkRuns.length - 1]!;
    if (last.status !== 'passed') t.finalFailed += 1;
    else if (r.accepted === true) t.finalPassedAccepted += 1;
    else t.finalPassedRejected += 1;
  }
  t.failedBySuite = Object.fromEntries(Object.entries(t.failedBySuite).sort(([a], [b]) => (a < b ? -1 : 1)));
  return t;
}

/**
 * The walkthrough's declared selection rule, fixed before looking at any trace: the first scored
 * workflow in the seeded schedule (lowest block, then lowest slot). The seed, not an outcome, chooses it.
 */
export function selectTraceKey(rows: readonly DiagnosticRow[]): { block: number; slot: number } | null {
  let best: { block: number; slot: number } | null = null;
  for (const r of rows) {
    if (!r.scored) continue;
    if (!best || r.block < best.block || (r.block === best.block && r.slot < best.slot)) best = { block: r.block, slot: r.slot };
  }
  return best;
}
