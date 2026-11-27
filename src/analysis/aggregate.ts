/**
 * Credential-free aggregation of saved per-attempt accounting into per-condition results
 * (methodology sections 8, 10 and 11). Pure: the input is a list of `AttemptAccounting` records
 * (regenerated from saved records with one price snapshot), the frozen matrix and schedule.
 *
 * - The three workflows stay separate. Solo conditions are listed once and referenced as controls
 *   by the collaboration workflows; nothing is pooled and no pairing score is computed.
 * - Every scored workflow, accepted or not, enters its condition's cost numerator.
 * - Zero accepted: cost per accepted workflow is `undefined`, never $0 or a finite stand-in.
 * - A condition cost is only as good as its worst workflow: one unavailable stage makes the total
 *   unavailable, one unbounded category makes it a lower bound, and the bootstrap is suppressed.
 * - Operational attempts never enter a denominator, but their usage, cost and waits are reported.
 * - Records are put into canonical order first, so the output is independent of read order.
 *
 * Validation refuses to aggregate rather than guess: duplicate attempts, two scored attempts in a
 * slot, conditions that disagree with the frozen schedule, unknown conditions, foreign campaigns,
 * dangling replacement links, mixed price snapshots, impossible verdicts, and excess observations.
 */
import { exactTokens, type AttemptAccounting } from '../accounting/record.ts';
import { CATEGORIES, sumVectors, type Category, type Quantity, type TokenVector } from '../accounting/quantity.ts';
import { costFromJson, costJson, costStatus, sumCosts, type Cost, type CostJson } from '../accounting/value.ts';
import { picoToUsd } from '../accounting/prices.ts';
import type { Schedule } from '../orchestrator/schedule.ts';
import type { BlockAuditStatus } from '../audit/quota.ts';
import { bootstrapCostPerAccepted, summarise, wilson, type BootstrapOptions, type BootstrapResult, type Proportion, type Summary } from './stats.ts';

export const ANALYSIS_SCHEMA = 'harness-benchmark/analysis@1';

export type Dataset = 'observed' | 'pilot' | 'synthetic';

export interface AnalysisMatrix {
  cohort: string;
  repetitions: number;
  canonicalConditionOrder: string[];
  workflows: Record<string, { label?: string; stages: string[] }>;
}

export interface RoleInfo {
  label: string;
  tier: string;
  provider: string;
  requestedModel: string;
  effort: string;
}

export interface AnalysisOptions {
  /** The campaign label every record must carry (e.g. `cohort-03`). */
  label: string;
  /** `synthetic` for test fixtures, `pilot` for unscored pilots, `observed` for the scored cohort. */
  dataset: Dataset;
  matrix: AnalysisMatrix;
  /** The frozen schedule; null for a campaign without one (pilots). */
  schedule: Schedule | null;
  roles: Record<string, RoleInfo>;
  bootstrap: BootstrapOptions;
  /**
   * Quota audit coverage per block that has records (methodology section 8). Records must already
   * carry the audit's decisions (reclassified attempts are operational). A block whose audit is
   * missing, has pending flags, or misses a scored failure leaves an observed cohort incomplete.
   * Omitted: no audit requirement (pilots, synthetic fixtures).
   */
  audits?: BlockAuditStatus[];
}

export class AnalysisValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`analysis refused: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

export type CostPerAcceptedStatus = 'exact' | 'bounded' | 'lower-bound' | 'unavailable' | 'undefined';

export interface CostPerAccepted {
  status: CostPerAcceptedStatus;
  accepted: number;
  /** Single figure, only when the total is exact and accepted > 0. */
  usd: number | null;
  lowerUsd: number | null;
  upperUsd: number | null;
  /** Exact numerator (Σ cost over all scored workflows), for audit and repricing checks. */
  numeratorPicoUsd: string | null;
  numeratorLowerPicoUsd: string | null;
  numeratorUpperPicoUsd: string | null;
  note: string;
}

export interface WorkflowRow {
  block: number;
  slot: number;
  attempt: number;
  accepted: boolean;
  termination: string | null;
  activeMs: number | null;
  evaluatorMs: number | null;
  sensorRepairs: number;
  measurement: AttemptAccounting['measurement'];
  tokens: Record<Category, number | null>;
  cost: CostJson;
}

export interface ConditionBootstrap {
  status: 'computed' | 'bounds' | 'suppressed' | 'not-run';
  reason: string | null;
  /** All workflow costs exact. */
  exact: BootstrapResult | null;
  /** Some costs bounded (none unbounded): the same resampling over lower-bound and upper-bound costs. */
  lowerCosts: BootstrapResult | null;
  upperCosts: BootstrapResult | null;
}

export interface ConditionSummary {
  conditionId: string;
  workflow: string;
  assignment: string[];
  assignmentLabels: string[];
  /** Short model names per stage, e.g. `Haiku 5.5`, for figure labels. */
  assignmentModels: string[];
  /** Fixed effort per stage: part of each configuration, not a comparable unit across models. */
  assignmentEfforts: string[];
  stages: string[];
  checks: string;
  expected: number;
  scored: number;
  accepted: number;
  acceptance: Proportion;
  outcomes: Record<string, number>;
  totalCost: CostJson;
  acceptedCost: CostJson;
  failureCost: CostJson;
  costPerAccepted: CostPerAccepted;
  bootstrap: ConditionBootstrap;
  byRole: Record<string, { stages: number; tokens: Record<Category, Quantity>; cost: CostJson }>;
  tokens: Record<Category | 'total', Summary>;
  /** Scored workflows with at least one non-exact token category. */
  tokensNotExact: number;
  elapsedMs: Summary;
  elapsedMissing: number;
  evaluatorMs: Summary;
  sensorRepairs: Summary;
  measurement: { complete: number; partial: number; missing: number };
  operational: { attempts: number; cost: CostJson };
  workflows: WorkflowRow[];
}

export interface Exclusion {
  block: number;
  slot: number;
  attempt: number;
  conditionId: string;
  termination: string | null;
  terminationDetail: string | null;
  replaces: number | null;
  replacedBy: number | null;
  activeMs: number | null;
  measurement: AttemptAccounting['measurement'];
  cost: CostJson;
}

export interface Analysis {
  schema: typeof ANALYSIS_SCHEMA;
  label: string;
  cohort: string;
  dataset: Dataset;
  provenance: AttemptAccounting['provenance'] | null;
  bootstrap: BootstrapOptions;
  completeness: {
    scheduledSlots: number;
    scoredSlots: number;
    complete: boolean;
    missingSlots: Array<{ block: number; slot: number; conditionId: string }>;
    pendingAttempts: Array<{ block: number; slot: number; attempt: number; conditionId: string; phase: string }>;
    /** Null when no audit requirement applies. `complete` is false while any block's audit is incomplete. */
    audit: { complete: boolean; blocks: BlockAuditStatus[] } | null;
  };
  workflows: Record<string, { label: string; conditions: ConditionSummary[]; controls: string[] }>;
  operational: { attempts: number; byTermination: Record<string, number>; tokens: Record<Category, Quantity>; cost: CostJson; waitMs: number; exclusions: Exclusion[] };
  overhead: { evaluatorMs: number; waitMs: number; manualHandling: number; activeMsScored: number; activeMsOperational: number };
}

/** Display label: `plan -> implement` → `Plan → implement`; `solo` → `Solo`. */
export function workflowLabel(key: string, label?: string): string {
  const s = (label ?? key).replace(/->/g, '→');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** `claude-opus-5-5` → `Opus 5.5`; `gpt-6-astra` → `GPT-6 Astra`. Display only. */
export function modelShort(id: string): string {
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  const c = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  if (c) return `${cap(c[1]!)} ${c[2]}.${c[3]}`;
  const g = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/.exec(id);
  if (g) return `GPT-${g[1]} ${cap(g[2]!)}`;
  return id;
}

const key = (r: { block: number; slot: number }) => `${r.block}/${r.slot}`;
const byOrder = (a: AttemptAccounting, b: AttemptAccounting) => a.block - b.block || a.slot - b.slot || a.attempt - b.attempt;
const quantities = (t: TokenVector): Record<Category, Quantity> => Object.fromEntries(CATEGORIES.map((c) => [c, { lo: t[c].lo, hi: t[c].hi }])) as Record<Category, Quantity>;

function validate(records: AttemptAccounting[], o: AnalysisOptions): string[] {
  const p: string[] = [];
  const known = new Set(o.matrix.canonicalConditionOrder);
  const scheduled = new Map<string, string>();
  for (const b of o.schedule?.blocks ?? []) for (const s of b.slots) scheduled.set(key(s), s.conditionId);
  const seen = new Set<string>();
  const scoredIn = new Map<string, number>();
  const perCondition = new Map<string, number>();
  const snapshots = new Set<string>();
  const semantics = new Set<string>();
  const attemptsIn = new Map<string, Map<number, AttemptAccounting>>();
  for (const r of records) {
    const where = `block ${r.block} slot ${r.slot} attempt ${r.attempt}`;
    if (r.campaign !== o.label) p.push(`${where}: campaign ${r.campaign} is not ${o.label}`);
    if (!known.has(r.conditionId)) p.push(`${where}: unknown condition ${r.conditionId}`);
    if (o.schedule) {
      const s = scheduled.get(key(r));
      if (s === undefined) p.push(`${where}: block ${r.block} slot ${r.slot} is not in the frozen schedule`);
      else if (s !== r.conditionId) p.push(`${where}: condition ${r.conditionId} disagrees with the schedule (${s})`);
    }
    const id = `${key(r)}/${r.attempt}`;
    if (seen.has(id)) p.push(`${where}: duplicate attempt`);
    seen.add(id);
    const slotAttempts = attemptsIn.get(key(r)) ?? new Map();
    slotAttempts.set(r.attempt, r);
    attemptsIn.set(key(r), slotAttempts);
    snapshots.add(`${r.provenance.priceSnapshot.file}@${r.provenance.priceSnapshot.sha256}`);
    semantics.add(`${r.provenance.usageSemantics.file}@${r.provenance.usageSemantics.sha256}`);
    if (r.scored) {
      scoredIn.set(key(r), (scoredIn.get(key(r)) ?? 0) + 1);
      perCondition.set(r.conditionId, (perCondition.get(r.conditionId) ?? 0) + 1);
      if (r.accepted === null) p.push(`${where}: scored workflow has no acceptance verdict`);
      if (r.accepted === true && r.termination !== 'completed') p.push(`${where}: accepted without completing (${r.termination})`);
    } else if (r.accepted === true) p.push(`${where}: unscored attempt marked accepted`);
  }
  for (const r of records) {
    if (r.replaces === null) continue;
    const prior = attemptsIn.get(key(r))?.get(r.replaces);
    if (!prior) p.push(`block ${r.block} slot ${r.slot} attempt ${r.attempt}: replaces attempt ${r.replaces}, which is not in the records`);
    else if (prior.scored) p.push(`block ${r.block} slot ${r.slot} attempt ${r.attempt}: replaces scored attempt ${r.replaces} (scored failures are never retried)`);
  }
  for (const [k, n] of scoredIn) if (n > 1) p.push(`slot ${k}: more than one scored attempt (${n})`);
  for (const [c, n] of perCondition) if (n > o.matrix.repetitions) p.push(`${c}: ${n} scored workflows, more than the ${o.matrix.repetitions} expected`);
  if (snapshots.size > 1) p.push(`records valued against more than one price snapshot: ${[...snapshots].sort().join(', ')}`);
  if (semantics.size > 1) p.push(`records normalised with more than one usage-semantics file: ${[...semantics].sort().join(', ')}`);
  return p;
}

function divide(total: Cost, accepted: number): CostPerAccepted {
  const base = {
    accepted,
    numeratorPicoUsd: costStatus(total) === 'exact' ? total.lo!.toString() : null,
    numeratorLowerPicoUsd: total.lo === null ? null : total.lo.toString(),
    numeratorUpperPicoUsd: total.hi === null ? null : total.hi.toString(),
  };
  if (accepted === 0) return { ...base, status: 'undefined', usd: null, lowerUsd: null, upperUsd: null, note: 'no accepted workflows: no finite cost per accepted workflow' };
  const status = costStatus(total);
  const lo = total.lo === null ? null : picoToUsd(total.lo) / accepted;
  const hi = total.hi === null ? null : picoToUsd(total.hi) / accepted;
  switch (status) {
    case 'exact':
      return { ...base, status, usd: lo, lowerUsd: lo, upperUsd: hi, note: 'Σ estimated cost of all scored workflows ÷ accepted' };
    case 'bounded':
      return { ...base, status, usd: null, lowerUsd: lo, upperUsd: hi, note: 'bounds: some usage tier or counter semantics undetermined' };
    case 'lower-bound':
      return { ...base, status, usd: null, lowerUsd: lo, upperUsd: null, note: 'lower bound only: some usage category unknown' };
    default:
      return { ...base, status: 'unavailable', usd: null, lowerUsd: null, upperUsd: null, note: 'unavailable: a stage cost has no price row or no stage record' };
  }
}

function bootstrapFor(conditionId: string, rows: WorkflowRow[], o: BootstrapOptions): ConditionBootstrap {
  const none = { exact: null, lowerCosts: null, upperCosts: null };
  if (rows.length === 0) return { status: 'not-run', reason: 'no scored workflows', ...none };
  const bad = rows.filter((r) => r.cost.status === 'unavailable' || r.cost.status === 'lower-bound');
  if (bad.length) return { status: 'suppressed', reason: `${bad.length} workflow cost(s) unavailable or unbounded`, ...none };
  if (rows.every((r) => r.cost.status === 'exact')) {
    return { status: 'computed', reason: null, ...none, exact: bootstrapCostPerAccepted(rows.map((r) => ({ cost: r.cost.usd!, accepted: r.accepted })), conditionId, o) };
  }
  return {
    status: 'bounds',
    reason: 'some workflow costs are bounded; the same resampling is reported over lower and upper bounds',
    exact: null,
    lowerCosts: bootstrapCostPerAccepted(rows.map((r) => ({ cost: r.cost.lowerUsd!, accepted: r.accepted })), conditionId, o),
    upperCosts: bootstrapCostPerAccepted(rows.map((r) => ({ cost: r.cost.upperUsd!, accepted: r.accepted })), conditionId, o),
  };
}

function summariseCondition(conditionId: string, scored: AttemptAccounting[], operational: AttemptAccounting[], o: AnalysisOptions): ConditionSummary {
  const [workflow, assignment, checks] = conditionId.split('.') as [string, string, string];
  const roles = assignment.split('-');
  const costs = scored.map((r) => costFromJson(r.totals.cost));
  const rows: WorkflowRow[] = scored.map((r) => ({
    block: r.block,
    slot: r.slot,
    attempt: r.attempt,
    accepted: r.accepted === true,
    termination: r.termination,
    activeMs: r.activeMs,
    evaluatorMs: r.evaluation?.durationMs ?? null,
    sensorRepairs: r.sensorRepairs,
    measurement: r.measurement,
    tokens: exactTokens(r.totals.tokens) as Record<Category, number | null>,
    cost: r.totals.cost,
  }));
  const accepted = rows.filter((r) => r.accepted).length;
  const total = sumCosts(costs);
  const outcomes: Record<string, number> = {};
  for (const r of rows) outcomes[r.termination ?? 'unknown'] = (outcomes[r.termination ?? 'unknown'] ?? 0) + 1;

  const byRole: ConditionSummary['byRole'] = {};
  const roleAcc = new Map<string, { stages: number; tokens: TokenVector[]; costs: Cost[] }>();
  for (const r of scored)
    for (const s of r.stages) {
      const k = `${s.kind ?? 'unknown'}:${s.role ?? 'unknown'}`;
      const acc = roleAcc.get(k) ?? { stages: 0, tokens: [], costs: [] };
      acc.stages++;
      acc.tokens.push(s.tokens);
      acc.costs.push(costFromJson(s.cost));
      roleAcc.set(k, acc);
    }
  for (const [k, v] of roleAcc) byRole[k] = { stages: v.stages, tokens: quantities(sumVectors(v.tokens)), cost: costJson(sumCosts(v.costs)) };

  const tokens = Object.fromEntries(CATEGORIES.map((c) => [c, summarise(rows.flatMap((r) => (r.tokens[c] === null ? [] : [r.tokens[c]!])))])) as ConditionSummary['tokens'];
  tokens.total = summarise(rows.flatMap((r) => (CATEGORIES.every((c) => r.tokens[c] !== null) ? [CATEGORIES.reduce((s, c) => s + r.tokens[c]!, 0)] : [])));
  const elapsed = rows.flatMap((r) => (r.activeMs === null ? [] : [r.activeMs]));

  return {
    conditionId,
    workflow,
    assignment: roles,
    assignmentLabels: roles.map((k) => o.roles[k]?.label ?? k),
    assignmentModels: roles.map((k) => (o.roles[k] ? modelShort(o.roles[k]!.requestedModel) : k)),
    assignmentEfforts: roles.map((k) => o.roles[k]?.effort ?? 'unknown'),
    stages: o.matrix.workflows[workflow]?.stages ?? [],
    checks,
    expected: o.matrix.repetitions,
    scored: rows.length,
    accepted,
    acceptance: wilson(accepted, rows.length, o.bootstrap.confidence),
    outcomes,
    totalCost: costJson(total),
    acceptedCost: costJson(sumCosts(costs.filter((_, i) => rows[i]!.accepted))),
    failureCost: costJson(sumCosts(costs.filter((_, i) => !rows[i]!.accepted))),
    costPerAccepted: divide(total, accepted),
    bootstrap: bootstrapFor(conditionId, rows, o.bootstrap),
    byRole,
    tokens,
    tokensNotExact: rows.filter((r) => CATEGORIES.some((c) => r.tokens[c] === null)).length,
    elapsedMs: summarise(elapsed),
    elapsedMissing: rows.length - elapsed.length,
    evaluatorMs: summarise(rows.flatMap((r) => (r.evaluatorMs === null ? [] : [r.evaluatorMs]))),
    sensorRepairs: summarise(rows.map((r) => r.sensorRepairs)),
    measurement: { complete: rows.filter((r) => r.measurement === 'complete').length, partial: rows.filter((r) => r.measurement === 'partial').length, missing: rows.filter((r) => r.measurement === 'missing').length },
    operational: { attempts: operational.length, cost: costJson(sumCosts(operational.map((r) => costFromJson(r.totals.cost)))) },
    workflows: rows,
  };
}

/** Pure: validate and aggregate. Throws `AnalysisValidationError` listing every problem found. */
export function aggregate(input: readonly AttemptAccounting[], o: AnalysisOptions): Analysis {
  const records = [...input].sort(byOrder);
  const problems = validate(records, o);
  if (problems.length) throw new AnalysisValidationError(problems);

  const finished = records.filter((r) => r.phase === 'finished');
  const scored = finished.filter((r) => r.scored);
  const operational = finished.filter((r) => !r.scored);
  const pending = records.filter((r) => r.phase !== 'finished');

  const workflows: Analysis['workflows'] = {};
  const soloIds = o.matrix.canonicalConditionOrder.filter((c) => c.startsWith('solo.'));
  for (const [wf, def] of Object.entries(o.matrix.workflows)) {
    const ids = o.matrix.canonicalConditionOrder.filter((c) => c.startsWith(`${wf}.`));
    workflows[wf] = {
      label: workflowLabel(wf, def.label),
      conditions: ids.map((id) => summariseCondition(id, scored.filter((r) => r.conditionId === id), operational.filter((r) => r.conditionId === id), o)),
      controls: wf === 'solo' ? [] : soloIds,
    };
  }

  const auditBlocks = o.audits ? [...o.audits].sort((a, b) => a.block - b.block) : null;
  const audit = auditBlocks ? { complete: auditBlocks.every((b) => b.status === 'complete'), blocks: auditBlocks } : null;

  const scoredSlots = new Set(scored.map(key));
  const slots = o.schedule ? o.schedule.blocks.flatMap((b) => b.slots) : [];
  const scheduledSlots = o.schedule ? slots.length : o.matrix.canonicalConditionOrder.length * o.matrix.repetitions;
  const missingSlots = slots.filter((s) => !scoredSlots.has(key(s))).map((s) => ({ block: s.block, slot: s.slot, conditionId: s.conditionId }));

  const byTermination: Record<string, number> = {};
  for (const r of operational) byTermination[r.termination ?? 'unknown'] = (byTermination[r.termination ?? 'unknown'] ?? 0) + 1;
  const exclusions: Exclusion[] = operational.map((r) => ({
    block: r.block,
    slot: r.slot,
    attempt: r.attempt,
    conditionId: r.conditionId,
    termination: r.termination,
    terminationDetail: r.terminationDetail,
    replaces: r.replaces,
    replacedBy: records.find((x) => x.block === r.block && x.slot === r.slot && x.replaces === r.attempt)?.attempt ?? null,
    activeMs: r.activeMs,
    measurement: r.measurement,
    cost: r.totals.cost,
  }));
  const sum = (xs: Array<number | null | undefined>) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
  const waitMs = sum(records.map((r) => r.waitBeforeMs));

  return {
    schema: ANALYSIS_SCHEMA,
    label: o.label,
    cohort: o.matrix.cohort,
    dataset: o.dataset,
    provenance: records[0]?.provenance ?? null,
    bootstrap: o.bootstrap,
    completeness: {
      scheduledSlots,
      scoredSlots: scoredSlots.size,
      complete: scoredSlots.size === scheduledSlots && pending.length === 0 && (audit === null || audit.complete),
      missingSlots,
      pendingAttempts: pending.map((r) => ({ block: r.block, slot: r.slot, attempt: r.attempt, conditionId: r.conditionId, phase: r.phase })),
      audit,
    },
    workflows,
    operational: {
      attempts: operational.length,
      byTermination,
      tokens: quantities(sumVectors(operational.map((r) => r.totals.tokens))),
      cost: costJson(sumCosts(operational.map((r) => costFromJson(r.totals.cost)))),
      waitMs,
      exclusions,
    },
    overhead: {
      evaluatorMs: sum(records.map((r) => r.evaluation?.durationMs)),
      waitMs,
      manualHandling: records.filter((r) => r.manualHandling !== null).length,
      activeMsScored: sum(scored.map((r) => r.activeMs)),
      activeMsOperational: sum(operational.map((r) => r.activeMs)),
    },
  };
}
