/**
 * SYNTHETIC test records for the analysis slice. Nothing here is an observation: every attempt is
 * built in memory from invented token counts and accounted with the real accounting code, so the
 * aggregation is tested end to end without touching records/.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseUsageSemantics, type UsageSemantics } from '../../../src/accounting/normalise.ts';
import { parsePriceSnapshot, type PriceSnapshot } from '../../../src/accounting/prices.ts';
import { accountAttempt, type AttemptAccounting } from '../../../src/accounting/record.ts';
import { ATTEMPT_SCHEMA, type AttemptRecord, type StageSummary } from '../../../src/orchestrator/state.ts';
import type { MatrixConfig, Schedule } from '../../../src/orchestrator/schedule.ts';

export const ROOT = resolve(import.meta.dirname, '../../..');
export const SNAP = parsePriceSnapshot(readFileSync(join(ROOT, 'prices', 'cost-dev-2026-11-13.csv'), 'utf8'));
export const COMMITTED = parseUsageSemantics(JSON.parse(readFileSync(join(ROOT, 'config', 'usage-semantics.json'), 'utf8')));
export const SETTLED: UsageSemantics = { ...COMMITTED, codex: { status: 'verified', turnCompletedScope: 'per-turn', cachedInputSubsetOfInput: true, reasoningIncludedInOutput: true, cacheWrites: 'verified-not-billed' } };
export const MATRIX = JSON.parse(readFileSync(join(ROOT, 'config', 'matrix.json'), 'utf8')) as MatrixConfig & { workflows: Record<string, { label?: string; stages: string[] }> };
export const SCHEDULE = JSON.parse(readFileSync(join(ROOT, 'config', 'schedule.json'), 'utf8')) as Schedule;
export const MODELS = JSON.parse(readFileSync(join(ROOT, 'config', 'models.json'), 'utf8')) as { roles: Record<string, { label: string; tier: string; provider: string; requestedModel: string; effort: string; priceRow: string }> };
export const ROLES = Object.fromEntries(Object.entries(MODELS.roles).map(([k, r]) => [k, { provider: r.provider, priceRow: r.priceRow }]));
export const PROV = { priceSnapshot: { file: 'prices/cost-dev-2026-11-13.csv', sha256: 'synthetic-price-hash' }, usageSemantics: { file: 'config/usage-semantics.json', sha256: 'synthetic-semantics-hash' } };

const MODEL: Record<string, string> = { CF: 'gpt-6-astra', CC: 'gpt-6-luna', AF: 'claude-opus-5-5', AC: 'claude-haiku-5-5' };

const mu = (input: number, out: number) => ({ inputTokens: input, outputTokens: out, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 0 });

function stageRecord(role: string, input: number, out: number) {
  const model = MODEL[role]!;
  const base = { role, requestedModel: model, resolvedModel: model, requestedEffort: 'x', appliedEffort: 'x', sessionId: 's', termination: 'completed', terminationDetail: null, startedAt: '2026-11-14T00:00:00.000Z', endedAt: '2026-11-14T00:01:00.000Z', durationMs: 60_000, settings: {} };
  if (role.startsWith('A')) {
    return { ...base, provider: 'anthropic', tool: 'claude-code', toolVersion: '2.1.323', mode: 'fresh', usage: { source: 's', semantics: 's', completeness: 'complete', raw: [{ kind: 'result', index: 0, sinceLastResult: { [model]: mu(input, out) }, modelUsage: { [model]: mu(input, out) } }], supplementary: {} } };
  }
  return { ...base, provider: 'openai', tool: 'codex', toolVersion: '0.169.0', mode: 'fresh', usage: { source: 's', semantics: 's', completeness: 'complete', raw: [{ input_tokens: input, cached_input_tokens: 0, output_tokens: out, reasoning_output_tokens: 0 }], supplementary: {} } };
}

export function stagesFor(conditionId: string): Array<{ kind: string; role: string }> {
  const [wf, assignment] = conditionId.split('.') as [string, string];
  const roles = assignment.split('-');
  return MATRIX.workflows[wf]!.stages.map((kind, i) => ({ kind, role: roles[i]! }));
}

export interface SynthOptions {
  block: number;
  slot: number;
  conditionId: string;
  attempt?: number;
  replaces?: number | null;
  termination?: string;
  accepted?: boolean | null;
  phase?: AttemptRecord['phase'];
  activeMs?: number | null;
  evaluatorMs?: number | null;
  waitBeforeMs?: number;
  /** Token scale: stage i uses (input, output) = (base × (i + 1), base / 10). */
  tokens?: number;
  /** Stage indices whose stage.json is absent (runner died mid-stage). */
  missingStages?: number[];
  sensorRepairs?: number;
  campaign?: string;
}

/** The raw saved form: `attempt.json` and each `stages/<id>/stage.json` (null = absent). */
export function synthRaw(o: SynthOptions): { attempt: AttemptRecord; records: Map<string, unknown> } {
  const termination = o.termination ?? 'completed';
  const operational = ['auth-missing', 'quota-exhausted', 'provider-outage', 'model-substituted', 'runner-infrastructure-failure', 'evaluator-infrastructure-failure'].includes(termination);
  const phase = o.phase ?? 'finished';
  const accepted = o.accepted !== undefined ? o.accepted : operational || phase !== 'finished' ? null : termination === 'completed';
  const base = o.tokens ?? 10_000;
  const stages = stagesFor(o.conditionId);
  const summaries: StageSummary[] = stages.map((s, i) => ({
    id: `s${i + 1}-${s.kind}`,
    kind: s.kind,
    role: s.role,
    mode: 'fresh',
    resumedSession: null,
    sessionId: 's',
    requestedModel: MODEL[s.role]!,
    resolvedModel: MODEL[s.role]!,
    termination: 'completed',
    terminationDetail: null,
    startedAt: '2026-11-14T00:00:00.000Z',
    endedAt: '2026-11-14T00:01:00.000Z',
    durationMs: 60_000,
    promptSha256: 'p',
    workspaceHashBefore: null,
    workspaceHashAfter: null,
    handoff: null,
    usageCompleteness: 'complete',
    recordDir: `stages/s${i + 1}-${s.kind}`,
  }));
  const records = new Map<string, unknown>(stages.map((s, i) => [`stages/s${i + 1}-${s.kind}`, (o.missingStages ?? []).includes(i) ? null : stageRecord(s.role, base * (i + 1), Math.floor(base / 10))]));
  const attempt: AttemptRecord = {
    schema: ATTEMPT_SCHEMA,
    campaign: o.campaign ?? 'cohort-03',
    block: o.block,
    slot: o.slot,
    conditionId: o.conditionId,
    attempt: o.attempt ?? 1,
    replaces: o.replaces ?? null,
    phase,
    startedAt: '2026-11-14T00:00:00.000Z',
    endedAt: phase === 'finished' ? '2026-11-14T00:10:00.000Z' : null,
    activeMs: o.activeMs === undefined ? 600_000 : o.activeMs,
    waitBeforeMs: o.waitBeforeMs ?? 0,
    waitReason: o.waitBeforeMs ? 'quota' : null,
    termination: phase === 'running' ? null : (termination as AttemptRecord['termination']),
    terminationDetail: null,
    outcome: phase !== 'finished' ? null : operational ? 'operational' : termination === 'completed' ? 'completed' : 'scored-failure',
    accepted,
    evaluation: operational || phase !== 'finished' ? null : { status: accepted ? 'passed' : 'failed', verdictFile: 'verdict.json', durationMs: o.evaluatorMs === undefined ? 30_000 : o.evaluatorMs, snapshotHash: 'h', reason: null },
    sensorRepairs: o.sensorRepairs ?? 0,
    stages: summaries,
    finalSnapshotHash: 'h',
    manualHandling: null,
  };
  return { attempt, records };
}

export function synth(o: SynthOptions, snapshot: PriceSnapshot = SNAP, semantics: UsageSemantics = SETTLED, provenance = PROV): AttemptAccounting {
  const { attempt, records } = synthRaw(o);
  return accountAttempt({ attempt, stageRecords: records, roles: ROLES, snapshot, semantics, provenance });
}

/** One scored attempt for every slot of the frozen schedule (`blocks` blocks), all accepted unless `f` says otherwise. */
export function fullCampaign(f: (slot: { block: number; slot: number; conditionId: string }) => Partial<SynthOptions> = () => ({}), blocks = 10, snapshot: PriceSnapshot = SNAP, semantics: UsageSemantics = SETTLED): AttemptAccounting[] {
  return SCHEDULE.blocks.slice(0, blocks).flatMap((b) => b.slots.map((s) => synth({ ...s, ...f(s) }, snapshot, semantics)));
}
