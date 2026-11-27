/**
 * Per-attempt accounting record (`accounting.json`, methodology section 10). Pure assembly from the
 * saved `attempt.json`, each stage's `stage.json`, the price snapshot and the usage semantics. Every
 * attempt gets one, scored or operational, so interrupted and excluded work stays visible.
 *
 * Invariants (unit- and property-tested): role totals and the workflow total are exact sums of the
 * stage figures; one unknown stage cost makes the workflow total non-exact; a stage directory with
 * no `stage.json` (the runner died mid-stage) is listed with unknown usage, never dropped.
 */
import type { AttemptRecord, StageSummary } from '../orchestrator/state.ts';
import { classify } from '../orchestrator/state.ts';
import { normaliseStage, type NormalisedStage, type UsageSemantics } from './normalise.ts';
import type { PriceSnapshot } from './prices.ts';
import { CATEGORIES, sumVectors, unknownVector, type TokenVector } from './quantity.ts';
import { costJson, priceRowFor, sumCosts, valueBuckets, type Cost, type CostJson } from './value.ts';

export const ACCOUNTING_SCHEMA = 'harness-benchmark/accounting@1';

export interface RoleConfig {
  provider: string;
  priceRow: string;
}

export interface AccountingInput {
  attempt: AttemptRecord & { environment?: unknown; scoredTerminationBeforeEvaluation?: string };
  /** Stage directory name (`stages/<id>`) → parsed stage.json, or null when the file is absent. */
  stageRecords: Map<string, unknown>;
  roles: Record<string, RoleConfig>;
  snapshot: PriceSnapshot;
  semantics: UsageSemantics;
  provenance: { priceSnapshot: { file: string; sha256: string }; usageSemantics: { file: string; sha256: string } };
}

export interface StageAccounting {
  order: number;
  id: string;
  kind: string | null;
  role: string | null;
  provider: string | null;
  tool: string | null;
  toolVersion: string | null;
  mode: string | null;
  sessionId: string | null;
  requestedModel: string | null;
  resolvedModel: string | null;
  requestedEffort: string | null;
  appliedEffort: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  termination: string | null;
  terminationDetail: string | null;
  recordDir: string;
  stageRecordPresent: boolean;
  settings: unknown;
  rawUsage: unknown;
  normalised: NormalisedStage | null;
  tokens: TokenVector;
  byModel: Array<{ model: string; auxiliary: boolean; priceRow: string; cost: CostJson }>;
  cost: CostJson;
}

export interface AttemptAccounting {
  schema: typeof ACCOUNTING_SCHEMA;
  campaign: string;
  block: number;
  slot: number;
  conditionId: string;
  attempt: number;
  replaces: number | null;
  phase: string;
  outcome: string | null;
  /** True for a finished, non-operational attempt: the one counted in its condition. */
  scored: boolean;
  accepted: boolean | null;
  termination: string | null;
  terminationDetail: string | null;
  scoredTerminationBeforeEvaluation: string | null;
  /** Set when the quota audit reclassified this attempt (methodology section 8); null otherwise. */
  reclassification: { auditFile: string; flagIds: string[]; originalTermination: string | null; originalTerminationDetail: string | null; originalOutcome: string | null; originalAccepted: boolean | null } | null;
  startedAt: string;
  endedAt: string | null;
  activeMs: number | null;
  waitBeforeMs: number;
  waitReason: string | null;
  manualHandling: string | null;
  sensorRepairs: number;
  evaluation: { status: string; durationMs: number | null; snapshotHash: string | null } | null;
  environment: unknown;
  provenance: AccountingInput['provenance'];
  /** `complete` only when every stage's usage is complete and every stage record exists. */
  measurement: 'complete' | 'partial' | 'missing';
  stages: StageAccounting[];
  byRole: Record<string, { stages: number; tokens: TokenVector; cost: CostJson }>;
  totals: { tokens: TokenVector; cost: CostJson };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function reclassificationOf(a: AttemptRecord): AttemptAccounting['reclassification'] {
  const r = (a as AttemptRecord & { reclassification?: NonNullable<AttemptAccounting['reclassification']> }).reclassification;
  return r ? { auditFile: r.auditFile, flagIds: [...r.flagIds], originalTermination: r.originalTermination, originalTerminationDetail: r.originalTerminationDetail ?? null, originalOutcome: r.originalOutcome, originalAccepted: r.originalAccepted ?? null } : null;
}
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Pure: build the record. Stage order follows attempt.json; stage directories it does not list follow. */
export function accountAttempt(i: AccountingInput): AttemptAccounting {
  const a = i.attempt;
  const listed: StageSummary[] = Array.isArray(a.stages) ? a.stages : [];
  const dirs = [...listed.map((s) => s.recordDir), ...[...i.stageRecords.keys()].filter((d) => !listed.some((s) => s.recordDir === d)).sort()];
  const costs: Cost[] = [];
  const stages: StageAccounting[] = dirs.map((dir, idx) => {
    const summary = listed.find((s) => s.recordDir === dir);
    const rec = i.stageRecords.get(dir);
    const s = isObj(rec) ? rec : null;
    const role = str(s?.role) ?? summary?.role ?? null;
    const roleCfg = role ? i.roles[role] : undefined;
    const provider = str(s?.provider) ?? roleCfg?.provider ?? null;
    const requestedModel = str(s?.requestedModel) ?? summary?.requestedModel ?? null;
    let normalised: NormalisedStage | null = null;
    let tokens = unknownVector();
    let cost: Cost = { lo: null, hi: null, reasons: [`${dir}: no stage.json (interrupted before the stage returned); usage unknown`] };
    let byModel: StageAccounting['byModel'] = [];
    if (s) {
      normalised = normaliseStage(s, i.semantics);
      tokens = sumVectors(normalised.buckets.map((b) => b.tokens));
      const v = valueBuckets(normalised.buckets, i.snapshot, (b) => priceRowFor({ provider: provider ?? 'unknown', model: b.model, requestedModel, rolePriceRow: roleCfg?.priceRow ?? null }));
      cost = v.cost;
      byModel = v.byModel.map((m, k) => ({ model: m.model, auxiliary: normalised!.buckets[k]!.auxiliary, priceRow: m.priceRow, cost: costJson(m.cost) }));
    }
    costs.push(cost);
    return {
      order: idx + 1,
      id: summary?.id ?? dir.replace(/^stages\//, ''),
      kind: summary?.kind ?? null,
      role,
      provider,
      tool: str(s?.tool),
      toolVersion: str(s?.toolVersion),
      mode: str(s?.mode) ?? summary?.mode ?? null,
      sessionId: str(s?.sessionId) ?? summary?.sessionId ?? null,
      requestedModel,
      resolvedModel: str(s?.resolvedModel) ?? summary?.resolvedModel ?? null,
      requestedEffort: str(s?.requestedEffort),
      appliedEffort: str(s?.appliedEffort),
      startedAt: str(s?.startedAt) ?? summary?.startedAt ?? null,
      endedAt: str(s?.endedAt) ?? summary?.endedAt ?? null,
      durationMs: numOrNull(s?.durationMs) ?? summary?.durationMs ?? null,
      termination: str(s?.termination) ?? summary?.termination ?? null,
      terminationDetail: str(s?.terminationDetail) ?? summary?.terminationDetail ?? null,
      recordDir: dir,
      stageRecordPresent: s !== null,
      settings: s?.settings ?? null,
      rawUsage: s?.usage ?? null,
      normalised,
      tokens,
      byModel,
      cost: costJson(cost),
    };
  });

  const byRole: AttemptAccounting['byRole'] = {};
  for (const role of [...new Set(stages.map((s) => s.role ?? 'unknown'))].sort()) {
    const idx = stages.flatMap((s, k) => ((s.role ?? 'unknown') === role ? [k] : []));
    byRole[role] = { stages: idx.length, tokens: sumVectors(idx.map((k) => stages[k]!.tokens)), cost: costJson(sumCosts(idx.map((k) => costs[k]!))) };
  }

  const completeness = stages.map((s) => (s.normalised ? s.normalised.completeness : 'missing'));
  const measurement = stages.length === 0 ? 'complete' : completeness.every((c) => c === 'complete') ? 'complete' : completeness.every((c) => c === 'missing') ? 'missing' : 'partial';
  let scored = false;
  try {
    scored = a.phase === 'finished' && a.termination !== null && classify(a.termination) !== 'operational' && a.outcome !== 'operational';
  } catch {
    scored = false;
  }

  return {
    schema: ACCOUNTING_SCHEMA,
    campaign: a.campaign,
    block: a.block,
    slot: a.slot,
    conditionId: a.conditionId,
    attempt: a.attempt,
    replaces: a.replaces,
    phase: a.phase,
    outcome: a.outcome,
    scored,
    accepted: a.accepted,
    termination: a.termination,
    terminationDetail: a.terminationDetail,
    scoredTerminationBeforeEvaluation: a.scoredTerminationBeforeEvaluation ?? null,
    reclassification: reclassificationOf(a),
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    activeMs: a.activeMs,
    waitBeforeMs: a.waitBeforeMs,
    waitReason: a.waitReason,
    manualHandling: a.manualHandling,
    sensorRepairs: a.sensorRepairs,
    evaluation: a.evaluation ? { status: a.evaluation.status, durationMs: a.evaluation.durationMs, snapshotHash: a.evaluation.snapshotHash } : null,
    environment: a.environment ?? null,
    provenance: i.provenance,
    measurement,
    stages,
    byRole,
    totals: { tokens: sumVectors(stages.map((s) => s.tokens)), cost: costJson(sumCosts(costs)) },
  };
}

/** Exact token totals per category, or null where any contributing count is not exact. */
export function exactTokens(t: TokenVector): Record<string, number | null> {
  return Object.fromEntries(CATEGORIES.map((c) => [c, t[c].hi !== null && t[c].lo === t[c].hi ? t[c].lo : null]));
}
