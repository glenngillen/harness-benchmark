/**
 * Text outputs of the analysis: CSV tables (one set per workflow, never pooled) and a Markdown
 * summary. Pure string builders; the CLI writes them. Every table states its denominators, and a
 * missing or undefined figure is an explicit word, never a blank or a zero.
 */
import { CATEGORIES } from '../accounting/quantity.ts';
import type { CostJson } from '../accounting/value.ts';
import type { Analysis, ConditionSummary } from './aggregate.ts';
import type { BootstrapResult } from './stats.ts';

export function csvField(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)))) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvField).join(',')).join('\n') + '\n';
}

/** Single-figure text for a cost: `$1.234567`, `$1.2–$1.4 (bounds)`, `≥ $1.2 (lower bound)`, `unavailable`. */
export function costText(c: { status: string } & Pick<CostJson, 'usd' | 'lowerUsd' | 'upperUsd'>, digits = 4): string {
  const f = (x: number) => `$${x.toFixed(digits)}`;
  switch (c.status) {
    case 'exact':
      return f(c.usd!);
    case 'bounded':
      return `${f(c.lowerUsd!)}–${f(c.upperUsd!)} (bounds)`;
    case 'lower-bound':
      return `≥ ${f(c.lowerUsd!)} (lower bound)`;
    default:
      return 'unavailable';
  }
}

export function cpaText(c: ConditionSummary, digits = 4): string {
  if (c.costPerAccepted.status === 'undefined') return 'undefined (0 accepted)';
  return costText(c.costPerAccepted, digits);
}

export function bootstrapText(c: ConditionSummary, digits = 4): string {
  const b = c.bootstrap;
  const one = (r: BootstrapResult) => `${r.lower === null ? 'unbounded' : `$${r.lower.toFixed(digits)}`} – ${r.upper === null ? 'unbounded' : `$${r.upper.toFixed(digits)}`}; ${(r.undefinedFraction * 100).toFixed(1)}% undefined`;
  if (b.status === 'computed') return one(b.exact!);
  if (b.status === 'bounds') return `lower costs ${one(b.lowerCosts!)}; upper costs ${one(b.upperCosts!)}`;
  return `suppressed (${b.reason})`;
}

const pct = (x: number | null) => (x === null ? null : Number((x * 100).toFixed(2)));
const minutes = (ms: number | null) => (ms === null ? null : Number((ms / 60_000).toFixed(3)));
const usdField = (x: number | null) => (x === null ? null : Number(x.toFixed(9)));

const CONDITION_HEADER = [
  'cohort', 'dataset', 'workflow', 'condition', 'assignment', 'checks', 'expected', 'scored', 'accepted', 'acceptance_pct', 'wilson95_lower_pct', 'wilson95_upper_pct',
  'total_cost_status', 'total_cost_usd', 'total_cost_lower_usd', 'total_cost_upper_usd', 'failure_cost_status', 'failure_cost_usd', 'failure_cost_lower_usd',
  'cost_per_accepted_status', 'cost_per_accepted_usd', 'cost_per_accepted_lower_usd', 'cost_per_accepted_upper_usd',
  'bootstrap_status', 'bootstrap95_lower_usd', 'bootstrap95_upper_usd', 'bootstrap_undefined_fraction', 'bootstrap_note',
  'elapsed_n', 'elapsed_missing', 'elapsed_median_min', 'elapsed_q1_min', 'elapsed_q3_min', 'elapsed_min_min', 'elapsed_max_min',
  'tokens_total_median', 'tokens_total_q1', 'tokens_total_q3', 'tokens_not_exact', 'measurement_complete', 'measurement_partial', 'measurement_missing',
  'sensor_repairs_total', 'operational_attempts', 'operational_cost_status', 'operational_cost_usd', 'operational_cost_lower_usd', 'outcomes',
];

function conditionRow(a: Analysis, c: ConditionSummary): unknown[] {
  const b = c.bootstrap.exact;
  return [
    a.cohort, a.dataset, c.workflow, c.conditionId, c.assignmentLabels.join(' -> '), c.checks, c.expected, c.scored, c.accepted, pct(c.acceptance.estimate), pct(c.acceptance.lower), pct(c.acceptance.upper),
    c.totalCost.status, usdField(c.totalCost.usd), usdField(c.totalCost.lowerUsd), usdField(c.totalCost.upperUsd), c.failureCost.status, usdField(c.failureCost.usd), usdField(c.failureCost.lowerUsd),
    c.costPerAccepted.status, usdField(c.costPerAccepted.usd), usdField(c.costPerAccepted.lowerUsd), usdField(c.costPerAccepted.upperUsd),
    c.bootstrap.status, b ? (b.lower === null ? 'unbounded' : usdField(b.lower)) : null, b ? (b.upper === null ? 'unbounded' : usdField(b.upper)) : null, b ? b.undefinedFraction : null, c.bootstrap.status === 'computed' ? null : bootstrapText(c, 6),
    c.elapsedMs.n, c.elapsedMissing, minutes(c.elapsedMs.median), minutes(c.elapsedMs.q1), minutes(c.elapsedMs.q3), minutes(c.elapsedMs.min), minutes(c.elapsedMs.max),
    c.tokens.total.median, c.tokens.total.q1, c.tokens.total.q3, c.tokensNotExact, c.measurement.complete, c.measurement.partial, c.measurement.missing,
    c.sensorRepairs.observations.reduce((s, x) => s + x, 0), c.operational.attempts, c.operational.cost.status, usdField(c.operational.cost.usd), usdField(c.operational.cost.lowerUsd),
    Object.entries(c.outcomes).map(([k, n]) => `${k}=${n}`).join('; '),
  ];
}

export function conditionsCsv(a: Analysis, workflow: string): string {
  return toCsv(CONDITION_HEADER, a.workflows[workflow]!.conditions.map((c) => conditionRow(a, c)));
}

export function workflowsCsv(a: Analysis, workflow: string): string {
  const header = ['cohort', 'dataset', 'condition', 'block', 'slot', 'attempt', 'termination', 'accepted', 'active_min', 'evaluator_s', 'sensor_repairs', 'measurement', 'cost_status', 'cost_usd', 'cost_lower_usd', 'cost_upper_usd', ...CATEGORIES];
  const rows = a.workflows[workflow]!.conditions.flatMap((c) =>
    c.workflows.map((w) => [a.cohort, a.dataset, c.conditionId, w.block, w.slot, w.attempt, w.termination, w.accepted, minutes(w.activeMs), w.evaluatorMs === null ? null : w.evaluatorMs / 1000, w.sensorRepairs, w.measurement, w.cost.status, usdField(w.cost.usd), usdField(w.cost.lowerUsd), usdField(w.cost.upperUsd), ...CATEGORIES.map((k) => (w.tokens[k] === null ? 'unknown' : w.tokens[k]))]),
  );
  return toCsv(header, rows);
}

export function rolesCsv(a: Analysis, workflow: string): string {
  const header = ['cohort', 'dataset', 'condition', 'stage_role', 'stages', 'cost_status', 'cost_usd', 'cost_lower_usd', 'cost_upper_usd', ...CATEGORIES.flatMap((k) => [`${k}_lower`, `${k}_upper`])];
  const rows = a.workflows[workflow]!.conditions.flatMap((c) =>
    Object.entries(c.byRole).map(([role, r]) => [a.cohort, a.dataset, c.conditionId, role, r.stages, r.cost.status, usdField(r.cost.usd), usdField(r.cost.lowerUsd), usdField(r.cost.upperUsd), ...CATEGORIES.flatMap((k) => [r.tokens[k].lo, r.tokens[k].hi === null ? 'unbounded' : r.tokens[k].hi])]),
  );
  return toCsv(header, rows);
}

export function operationalCsv(a: Analysis): string {
  const header = ['cohort', 'dataset', 'condition', 'block', 'slot', 'attempt', 'termination', 'detail', 'replaces', 'replaced_by', 'active_min', 'measurement', 'cost_status', 'cost_usd', 'cost_lower_usd', 'cost_upper_usd'];
  return toCsv(header, a.operational.exclusions.map((e) => [a.cohort, a.dataset, e.conditionId, e.block, e.slot, e.attempt, e.termination, e.terminationDetail, e.replaces, e.replacedBy, minutes(e.activeMs), e.measurement, e.cost.status, usdField(e.cost.usd), usdField(e.cost.lowerUsd), usdField(e.cost.upperUsd)]));
}

const md = (s: string) => s.replace(/\|/g, '\\|');

export function summaryMarkdown(a: Analysis, snapshotDate: string): string {
  const out: string[] = [];
  const status = a.dataset === 'synthetic' ? 'SYNTHETIC FIXTURE — not an observation' : a.dataset === 'pilot' ? 'PILOT — unscored, not part of the results' : a.completeness.complete ? 'complete scored cohort' : `INCOMPLETE — ${a.completeness.scoredSlots} of ${a.completeness.scheduledSlots} scheduled workflows scored; methodology only, not results`;
  out.push(`# Analysis summary: ${a.label}`, '', `- Status: **${status}**`, `- Cohort: ${a.cohort}`, `- Price snapshot: ${a.provenance ? `${a.provenance.priceSnapshot.file} (sha256 ${a.provenance.priceSnapshot.sha256.slice(0, 12)}…)` : 'none'}, cost.dev ${snapshotDate}`);
  out.push(`- Bootstrap: percentile, ${a.bootstrap.resamples} resamples, seed ${a.bootstrap.seed} XOR fnv1a32(condition)`, '- Dollars are API-equivalent estimates from that snapshot, not subscription charges or quota consumption.', '- Intervals are conditional on this workload and these configurations.', '');
  for (const [wf, w] of Object.entries(a.workflows)) {
    out.push(`## ${w.label}`, '');
    if (w.controls.length) out.push(`Solo controls are the solo table's conditions (${w.controls.length}); their observations are not counted again.`, '');
    out.push('| Condition | Checks | Accepted / scored | Acceptance (95% Wilson) | Total estimated cost | Cost per accepted | Bootstrap 95% | Median active min (IQR) | Operational attempts |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const c of w.conditions) {
      const acc = c.acceptance.estimate === null ? 'n/a' : `${(c.acceptance.estimate * 100).toFixed(0)}% (${(c.acceptance.lower! * 100).toFixed(0)}–${(c.acceptance.upper! * 100).toFixed(0)}%)`;
      const el = c.elapsedMs.median === null ? 'n/a' : `${(c.elapsedMs.median / 60_000).toFixed(1)} (${(c.elapsedMs.q1! / 60_000).toFixed(1)}–${(c.elapsedMs.q3! / 60_000).toFixed(1)})`;
      out.push(`| ${md(c.assignmentLabels.join(' → '))} | ${c.checks} | ${c.accepted} / ${c.scored} | ${acc} | ${md(costText(c.totalCost))} | ${md(cpaText(c))} | ${md(bootstrapText(c))} | ${el} | ${c.operational.attempts} |`);
    }
    out.push('', `Per-workflow rows: \`${a.label}-${wf}-workflows.csv\`; role costs: \`${a.label}-${wf}-roles.csv\`.`, '');
  }
  out.push('## Operational overhead (excluded from denominators)', '', `- Attempts: ${a.operational.attempts} (${Object.entries(a.operational.byTermination).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'})`, `- Estimated cost: ${costText(a.operational.cost)}`, `- Waiting before attempts: ${(a.overhead.waitMs / 3_600_000).toFixed(2)} h; manual handling: ${a.overhead.manualHandling}`, `- Active time: scored ${(a.overhead.activeMsScored / 3_600_000).toFixed(2)} h, operational ${(a.overhead.activeMsOperational / 3_600_000).toFixed(2)} h; independent evaluation ${(a.overhead.evaluatorMs / 3_600_000).toFixed(2)} h`, '');
  if (!a.completeness.complete) out.push(`## Missing slots`, '', `${a.completeness.missingSlots.length} scheduled slot(s) have no scored workflow; ${a.completeness.pendingAttempts.length} attempt(s) unfinished.`, '');
  const auditGaps = a.completeness.audit?.blocks.filter((b) => b.status !== 'complete') ?? [];
  if (auditGaps.length) out.push(`## Quota audit`, '', ...auditGaps.map((b) => `- Block ${b.block}: audit ${b.status}; ${b.pendingFlags} pending flag(s); ${b.unscanned.length} scored failure(s) not scanned${b.stalePatterns ? '; made with a different pattern list' : ''}.`), '');
  return out.join('\n');
}
