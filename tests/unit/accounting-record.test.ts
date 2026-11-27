import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseUsageSemantics, type UsageSemantics } from '../../src/accounting/normalise.ts';
import { parsePriceSnapshot, picoPerToken } from '../../src/accounting/prices.ts';
import { CATEGORIES } from '../../src/accounting/quantity.ts';
import { accountAttempt, exactTokens, type AccountingInput } from '../../src/accounting/record.ts';
import { accountTree, findAttemptDirs, loadAccountingContext, readStageRecords } from '../../src/accounting/tree.ts';
import { costFromJson, sumCosts } from '../../src/accounting/value.ts';
import { captureEnvironment, type EnvironmentDeps } from '../../src/orchestrator/environment.ts';
import { ATTEMPT_SCHEMA, type AttemptRecord, type StageSummary } from '../../src/orchestrator/state.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const TMP_ROOT = process.env.HARNESS_TEST_TMP ?? join(ROOT, '.runs', 'unit-tmp');
mkdirSync(TMP_ROOT, { recursive: true });
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const SNAP = parsePriceSnapshot(readFileSync(join(ROOT, 'prices', 'cost-dev-2026-11-13.csv'), 'utf8'));
const COMMITTED = parseUsageSemantics(JSON.parse(readFileSync(join(ROOT, 'config', 'usage-semantics.json'), 'utf8')));
const SETTLED: UsageSemantics = { ...COMMITTED, codex: { status: 'verified', turnCompletedScope: 'per-turn', cachedInputSubsetOfInput: true, reasoningIncludedInOutput: true, cacheWrites: 'verified-not-billed' } };
const ROLES = {
  CF: { provider: 'openai', priceRow: 'openai:gpt-6-astra' },
  CC: { provider: 'openai', priceRow: 'openai:gpt-6-luna' },
  AF: { provider: 'anthropic', priceRow: 'anthropic:claude-opus-5-5' },
  AC: { provider: 'anthropic', priceRow: 'anthropic:claude-haiku-5-5' },
};
const PROV = { priceSnapshot: { file: 'prices/x.csv', sha256: 'a' }, usageSemantics: { file: 'config/usage-semantics.json', sha256: 'b' } };

const mu = (input: number, out: number) => ({ inputTokens: input, outputTokens: out, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 0 });
const claudeStage = (role: 'AF' | 'AC', model: string, input: number, out: number, extra: Record<string, unknown> = {}) => ({
  stageId: `k--${role}`,
  role,
  provider: 'anthropic',
  tool: 'claude-code',
  toolVersion: '2.1.323',
  mode: 'fresh',
  requestedModel: model,
  resolvedModel: model,
  requestedEffort: 'medium',
  appliedEffort: 'medium',
  sessionId: 's',
  termination: 'completed',
  terminationDetail: null,
  startedAt: '2026-11-14T00:00:00.000Z',
  endedAt: '2026-11-14T00:01:00.000Z',
  durationMs: 60_000,
  settings: { effort: 'medium' },
  usage: { source: 's', semantics: 's', completeness: 'complete', raw: [{ kind: 'result', index: 0, sinceLastResult: { [model]: mu(input, out) }, modelUsage: { [model]: mu(input, out) } }], supplementary: {} },
  ...extra,
});
const codexStage = (role: 'CF' | 'CC', model: string, input: number, out: number) => ({
  ...claudeStage('AF', model, 0, 0),
  role,
  provider: 'openai',
  tool: 'codex',
  toolVersion: '0.169.0',
  usage: { source: 's', semantics: 's', completeness: 'complete', raw: [{ input_tokens: input, cached_input_tokens: 0, output_tokens: out, reasoning_output_tokens: 0 }], supplementary: {} },
});
const summary = (id: string, kind: string, role: string, model: string): StageSummary => ({
  id,
  kind,
  role,
  mode: 'fresh',
  resumedSession: null,
  sessionId: 's',
  requestedModel: model,
  resolvedModel: model,
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
  recordDir: `stages/${id}`,
});
const attempt = (o: Partial<AttemptRecord> = {}): AttemptRecord => ({
  schema: ATTEMPT_SCHEMA,
  campaign: 'cohort-03',
  block: 1,
  slot: 3,
  conditionId: 'pi.AF-CC.on',
  attempt: 1,
  replaces: null,
  phase: 'finished',
  startedAt: '2026-11-14T00:00:00.000Z',
  endedAt: '2026-11-14T00:10:00.000Z',
  activeMs: 600_000,
  waitBeforeMs: 0,
  waitReason: null,
  termination: 'completed',
  terminationDetail: null,
  outcome: 'completed',
  accepted: true,
  evaluation: { status: 'passed', verdictFile: 'verdict.json', durationMs: 42_000, snapshotHash: 'h', reason: null },
  sensorRepairs: 0,
  stages: [summary('01-plan', 'plan', 'AF', 'claude-opus-5-5'), summary('02-implement', 'implement', 'CC', 'gpt-6-luna')],
  finalSnapshotHash: 'h',
  manualHandling: null,
  ...o,
});
const input = (a: AttemptRecord, stages: Record<string, unknown>, semantics = SETTLED): AccountingInput => ({ attempt: a, stageRecords: new Map(Object.entries(stages)), roles: ROLES, snapshot: SNAP, semantics, provenance: PROV });
const usd = (r: string, t: number) => picoPerToken(r) * BigInt(t);

describe('accountAttempt', () => {
  const PI = { 'stages/01-plan': claudeStage('AF', 'claude-opus-5-5', 1000, 200), 'stages/02-implement': codexStage('CC', 'gpt-6-luna', 50_000, 3000) };

  it('records per-stage raw and normalised usage, models, settings, times and the evaluator duration', () => {
    const r = accountAttempt(input({ ...attempt(), environment: { os: { platform: 'darwin' } } } as AttemptRecord, PI));
    expect(r.schema).toBe('harness-benchmark/accounting@1');
    expect(r).toMatchObject({ scored: true, accepted: true, measurement: 'complete', evaluation: { durationMs: 42_000 }, environment: { os: { platform: 'darwin' } }, provenance: PROV });
    expect(r.stages.map((s) => [s.order, s.id, s.kind, s.role, s.resolvedModel, s.appliedEffort])).toEqual([
      [1, '01-plan', 'plan', 'AF', 'claude-opus-5-5', 'medium'],
      [2, '02-implement', 'implement', 'CC', 'gpt-6-luna', 'medium'],
    ]);
    expect(r.stages[0]!.rawUsage).toEqual(PI['stages/01-plan'].usage);
    expect(r.stages[0]!.settings).toEqual({ effort: 'medium' });
    expect(r.stages[0]!.cost.picoUsd).toBe((usd('4', 1000) + usd('20', 200)).toString());
    expect(r.stages[1]!.cost.picoUsd).toBe((usd('0.1', 50_000) + usd('0.5', 3000)).toString());
  });

  it('workflow and role totals equal the stage totals exactly', () => {
    const r = accountAttempt(input(attempt(), PI));
    expect(r.totals.cost.picoUsd).toBe((usd('4', 1000) + usd('20', 200) + usd('0.1', 50_000) + usd('0.5', 3000)).toString());
    expect(r.byRole.AF!.cost.picoUsd).toBe(r.stages[0]!.cost.picoUsd);
    expect(r.byRole.CC!.cost.picoUsd).toBe(r.stages[1]!.cost.picoUsd);
    expect(exactTokens(r.totals.tokens)).toMatchObject({ input_tokens: 51_000, output_tokens: 3200 });
  });

  it('one unknown stage makes the workflow total non-exact (no finite invented total)', () => {
    const r = accountAttempt(input(attempt(), PI, COMMITTED));
    expect(r.stages[0]!.cost.status).toBe('exact');
    expect(r.stages[1]!.cost.status).toBe('lower-bound');
    expect(r.totals.cost.usd).toBeNull();
    expect(r.totals.cost.status).toBe('lower-bound');
  });

  it('an interrupted stage with no stage.json is listed with unknown usage and an unavailable cost', () => {
    const a = attempt({ phase: 'finished', outcome: 'operational', termination: 'runner-infrastructure-failure', terminationDetail: 'runner-interrupted', accepted: null, stages: [summary('01-plan', 'plan', 'AF', 'claude-opus-5-5')] });
    const r = accountAttempt(input(a, { 'stages/01-plan': PI['stages/01-plan'], 'stages/02-implement': null }));
    expect(r.scored).toBe(false);
    expect(r.measurement).toBe('partial');
    expect(r.stages.map((s) => [s.id, s.stageRecordPresent, s.cost.status])).toEqual([
      ['01-plan', true, 'exact'],
      ['02-implement', false, 'unavailable'],
    ]);
    for (const c of CATEGORIES) expect(r.stages[1]!.tokens[c].hi).toBeNull();
    expect(r.totals.cost.status).toBe('unavailable');
  });

  it('separates auxiliary-model cost within a stage and prices it at its own row', () => {
    const st = claudeStage('AF', 'claude-opus-5-5', 1000, 200);
    (st.usage.raw[0] as { sinceLastResult: Record<string, unknown> }).sinceLastResult['claude-haiku-5-5'] = mu(500, 10);
    const r = accountAttempt(input(attempt({ stages: [summary('01-plan', 'plan', 'AF', 'claude-opus-5-5')] }), { 'stages/01-plan': st }));
    expect(r.stages[0]!.byModel.map((m) => [m.model, m.auxiliary, m.priceRow, m.cost.status])).toEqual([
      ['claude-haiku-5-5', true, 'anthropic:claude-haiku-5-5', 'exact'],
      ['claude-opus-5-5', false, 'anthropic:claude-opus-5-5', 'exact'],
    ]);
    expect(r.stages[0]!.cost.picoUsd).toBe((usd('4', 1000) + usd('20', 200) + usd('0.1', 500) + usd('0.5', 10)).toString());
  });

  it('a model with no price row leaves the stage unavailable rather than zero', () => {
    const st = claudeStage('AF', 'claude-opus-5-5', 1, 1);
    (st.usage.raw[0] as { sinceLastResult: Record<string, unknown> }).sinceLastResult['claude-tiny-1'] = mu(5, 1);
    const r = accountAttempt(input(attempt({ stages: [summary('01-plan', 'plan', 'AF', 'claude-opus-5-5')] }), { 'stages/01-plan': st }));
    expect(r.stages[0]!.cost.status).toBe('unavailable');
    expect(r.stages[0]!.cost.reasons.join()).toMatch(/no price row anthropic:claude-tiny-1/);
  });

  it('an attempt with a malformed attempt termination is not scored', () => {
    expect(accountAttempt(input(attempt({ termination: 'nonsense' as never }), PI)).scored).toBe(false);
    expect(accountAttempt(input(attempt({ phase: 'awaiting-evaluation' }), PI)).scored).toBe(false);
  });

  it('property: workflow total = Σ stage costs = Σ role costs, under any stage permutation', () => {
    const stageArb = fc.oneof(
      fc.tuple(fc.nat({ max: 300_000 }), fc.nat({ max: 50_000 })).map(([i, o]) => claudeStage('AC', 'claude-haiku-5-5', i, o)),
      fc.tuple(fc.nat({ max: 300_000 }), fc.nat({ max: 50_000 })).map(([i, o]) => claudeStage('AF', 'claude-opus-5-5', i, o)),
      fc.tuple(fc.nat({ max: 400_000 }), fc.nat({ max: 50_000 })).map(([i, o]) => codexStage('CF', 'gpt-6-astra', i, o)),
      fc.constant(null),
    );
    fc.assert(
      fc.property(fc.array(stageArb, { minLength: 1, maxLength: 5 }), fc.boolean(), (stages, settled) => {
        const recs = Object.fromEntries(stages.map((s, k) => [`stages/${String(k).padStart(2, '0')}`, s]));
        const r = accountAttempt(input(attempt({ stages: [] }), recs, settled ? SETTLED : COMMITTED));
        const stageSum = sumCosts(r.stages.map((s) => costFromJson(s.cost)));
        const roleSum = sumCosts(Object.values(r.byRole).map((x) => costFromJson(x.cost)));
        const total = costFromJson(r.totals.cost);
        expect([total.lo, total.hi]).toEqual([stageSum.lo, stageSum.hi]);
        expect([total.lo, total.hi]).toEqual([roleSum.lo, roleSum.hi]);
        const reversed = accountAttempt(input(attempt({ stages: [] }), Object.fromEntries(Object.entries(recs).reverse()), settled ? SETTLED : COMMITTED));
        expect(reversed.totals.cost).toEqual({ ...r.totals.cost, reasons: reversed.totals.cost.reasons });
        if (stages.includes(null)) expect(r.totals.cost.status).toBe('unavailable');
      }),
    );
  });
});

describe('accounting tree (saved records only)', () => {
  it('writes accounting.json beside every attempt, including pilots and interrupted stages', () => {
    const root = mkdtempSync(join(TMP_ROOT, 'accounting-'));
    made.push(root);
    const att = join(root, 'block-01', 'slot-03-pi.AF-CC.on', 'attempt-1');
    mkdirSync(join(att, 'stages', '01-plan'), { recursive: true });
    mkdirSync(join(att, 'stages', '02-implement'), { recursive: true });
    writeFileSync(join(att, 'attempt.json'), JSON.stringify(attempt()));
    writeFileSync(join(att, 'stages', '01-plan', 'stage.json'), JSON.stringify(claudeStage('AF', 'claude-opus-5-5', 10, 1)));
    const pilot = join(root, 'pilot', 'slot-01-solo.CF.off', 'attempt-1');
    mkdirSync(join(pilot, 'stages', '01-implement'), { recursive: true });
    writeFileSync(join(pilot, 'attempt.json'), JSON.stringify(attempt({ block: 0, conditionId: 'solo.CF.off', stages: [] })));
    writeFileSync(join(pilot, 'stages', '01-implement', 'stage.json'), '{not json');

    expect(findAttemptDirs(root)).toEqual([att, pilot]);
    expect([...readStageRecords(att).entries()].map(([k, v]) => [k, v === null])).toEqual([
      ['stages/01-plan', false],
      ['stages/02-implement', true],
    ]);
    const ctx = loadAccountingContext(ROOT);
    const written = accountTree(root, ctx);
    expect(written.map((w) => w.path)).toEqual(['block-01/slot-03-pi.AF-CC.on/attempt-1/accounting.json', 'pilot/slot-01-solo.CF.off/attempt-1/accounting.json']);
    const saved = JSON.parse(readFileSync(join(att, 'accounting.json'), 'utf8'));
    expect(saved.stages[1]).toMatchObject({ id: '02-implement', stageRecordPresent: false, cost: { status: 'unavailable' } });
    expect(saved.provenance.priceSnapshot.file).toBe('prices/cost-dev-2026-11-13.csv');
    expect(saved.provenance.priceSnapshot.sha256).toMatch(/^[0-9a-f]{64}$/);
    const pilotSaved = JSON.parse(readFileSync(join(pilot, 'accounting.json'), 'utf8'));
    expect(pilotSaved.stages[0].normalised.tool).toBe('unknown');
    expect(pilotSaved.totals.cost.status).toBe('unavailable');
    // Idempotent.
    accountTree(root, ctx);
    expect(readFileSync(join(att, 'accounting.json'), 'utf8')).toBe(`${JSON.stringify(saved, null, 2)}\n`);
  });

  it('an absent records root yields nothing', () => {
    expect(findAttemptDirs(join(TMP_ROOT, 'does-not-exist'))).toEqual([]);
    expect(existsSync(join(TMP_ROOT, 'does-not-exist'))).toBe(false);
  });
});

describe('captureEnvironment', () => {
  const deps = (git: (a: string[]) => string | null): EnvironmentDeps => ({
    os: () => ({ type: 'Darwin', platform: 'darwin', release: '25.6.0', arch: 'arm64' }),
    cpus: () => [{ model: ' Apple M4 ' }, { model: 'Apple M4' }],
    totalmem: () => 34_359_738_368,
    nodeVersion: 'v22.23.4',
    git,
  });

  it('records public facts and the benchmark revision', () => {
    const sha = 'a'.repeat(40);
    expect(captureEnvironment(deps((a) => (a[0] === 'rev-parse' ? sha : '')))).toEqual({
      os: { type: 'Darwin', platform: 'darwin', release: '25.6.0', arch: 'arm64' },
      cpu: { model: 'Apple M4', count: 2 },
      memoryBytes: 34_359_738_368,
      node: 'v22.23.4',
      hostId: null,
      benchmarkRevision: { commit: sha, dirty: false },
    });
    expect(captureEnvironment(deps((a) => (a[0] === 'rev-parse' ? sha : ' M src/x.ts'))).benchmarkRevision.dirty).toBe(true);
  });

  it('records the SHA-256 of the machine id, never the id itself', () => {
    // Synthetic machine id. sha256('0123456789abcdef0123456789abcdef') computed with node:crypto.
    const id = '0123456789abcdef0123456789abcdef';
    const facts = captureEnvironment({ ...deps(() => null), machineId: () => `${id}\n` });
    expect(facts.hostId).toBe(createHash('sha256').update(id).digest('hex'));
    expect(JSON.stringify(facts)).not.toContain(id);
    expect(captureEnvironment({ ...deps(() => null), machineId: () => null }).hostId).toBeNull();
    expect(captureEnvironment({ ...deps(() => null), machineId: () => '  \n' }).hostId).toBeNull();
  });

  it('degrades to nulls without Git', () => {
    expect(captureEnvironment(deps(() => null)).benchmarkRevision).toEqual({ commit: null, dirty: null });
    expect(captureEnvironment(deps(() => 'not-a-sha')).benchmarkRevision.commit).toBeNull();
  });

  // Synthetic runner manifest: the AWS runner unpacks a git-archive bundle with no checkout.
  const manifest = {
    schema: 'harness-benchmark/runner-bundle@1',
    revision: 'f'.repeat(40),
    tree: 'e'.repeat(40),
    createdAt: '2026-11-19T00:00:00Z',
    archive: { key: `bundles/${'f'.repeat(40)}.tar.gz`, sha256: 'c'.repeat(64), bytes: 10 },
    files: 5,
    fileListSha256: 'd'.repeat(64),
  };

  it('takes the revision from the runner bundle manifest when there is no Git checkout', () => {
    expect(captureEnvironment({ ...deps(() => null), release: () => manifest }).benchmarkRevision).toEqual({ commit: 'f'.repeat(40), dirty: null, source: 'bundle' });
  });

  it('prefers Git over a bundle manifest, and ignores a malformed manifest', () => {
    const sha = 'a'.repeat(40);
    expect(captureEnvironment({ ...deps((a) => (a[0] === 'rev-parse' ? sha : '')), release: () => manifest }).benchmarkRevision).toEqual({ commit: sha, dirty: false });
    expect(captureEnvironment({ ...deps(() => null), release: () => ({ revision: 'f'.repeat(40) }) }).benchmarkRevision).toEqual({ commit: null, dirty: null });
  });
});
