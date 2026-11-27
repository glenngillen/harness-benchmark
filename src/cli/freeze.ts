/**
 * Pre-scoring freeze gate (methodology section 14). Never calls a model.
 *
 *   npm run freeze                          # print the readiness report; exit 0 ready, 3 not ready
 *   npm run freeze -- --report <file.json>  # also write the report (committed as pilot evidence)
 *   npm run freeze -- --write               # write records/freeze/<cohort>.json, only when ready
 *   npm run freeze -- --evidence local      # probe this machine instead of using recorded evidence
 *   npm run freeze -- --max-age-days 14     # staleness limit for recorded host evidence
 *
 * Host evidence (default `--evidence recorded`): the subscription preflights and the OS-sandbox
 * probe are judged from the files the pilot host wrote with `npm run host-evidence`
 * (<pilots>/host-evidence/, see src/freeze/host-evidence.ts and src/orchestrator/cohort.ts), not by probing the machine
 * running this command. Missing, malformed, stale or inconsistent evidence blocks the gate.
 * `--evidence local` keeps the original behaviour for a reader whose own Linux host runs the pilots
 * and this command.
 *
 * The report gathers: pilot coverage from records/<cohort>-pilots, both CLI preflights (pin and isolated
 * subscription login), whether an OS sandbox can be applied on the pilot host, schedule reproducibility, Codex
 * usage-counter semantics, the price snapshot, OS/CLI facts, and SHA-256 digests of every frozen
 * artifact. Digests in a not-ready report are provisional; only a written manifest is frozen.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_MAX_AGE_DAYS, evaluateHostEvidence, pilotEnvironment, type PilotHostFacts } from '../freeze/host-evidence.ts';
import { pilotPaths } from '../orchestrator/cohort.ts';
import { probeLocalHost, type LocalProbe } from '../freeze/probe.ts';
import { BENCHMARK_ROOT, listFiles } from '../fixtures.ts';
import { captureEnvironment, defaultEnvironmentDeps } from '../orchestrator/environment.ts';
import { generateSchedule, renderSchedule, type MatrixConfig } from '../orchestrator/schedule.ts';
import { attemptFile, listAttemptDirs, readJson, type AttemptRecord } from '../orchestrator/state.ts';
import { evaluateGate, treeDigest, REQUIRED_SAFEGUARDS, type PilotAttempt, type PlannedStage, type SafeguardEvidence } from '../freeze/gate.ts';
import { isolationReader, shellReader, toPilotAttempt } from '../freeze/pilot-attempt.ts';
import { workflowPlan, type LimitsConfig } from '../orchestrator/plan.ts';
import { parseConditionId } from '../orchestrator/schedule.ts';

const root = BENCHMARK_ROOT;
const { values } = parseArgs({ options: { report: { type: 'string' }, write: { type: 'boolean', default: false }, evidence: { type: 'string', default: 'recorded' }, 'max-age-days': { type: 'string' } } });
if (values.evidence !== 'recorded' && values.evidence !== 'local') {
  console.error('--evidence must be recorded or local');
  process.exit(2);
}
const maxAgeDays = values['max-age-days'] === undefined ? DEFAULT_MAX_AGE_DAYS : Number(values['max-age-days']);
const readJsonFile = <T>(p: string) => JSON.parse(readFileSync(join(root, p), 'utf8')) as T;
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

const matrix = readJsonFile<MatrixConfig & { repetitions: number }>('config/matrix.json');
const limits = readJsonFile<LimitsConfig>('config/limits.json');
const plans: Record<string, PlannedStage[]> = Object.fromEntries(matrix.canonicalConditionOrder.map((c) => [c, workflowPlan(parseConditionId(c), limits)]));
const paths = pilotPaths(matrix.cohort);
const HOST_EVIDENCE_DIR = paths.hostEvidence;
const models = readJsonFile<{ roles: Record<string, { toolVersion: string; requestedModel: string; effort: string }> }>('config/models.json');

// Pilot records: records/<cohort>-pilots/pilot/slot-NN-<condition>/attempt-N/attempt.json
// (src/orchestrator/cohort.ts).
const pilotDir = join(root, paths.attempts);
const attempts: PilotAttempt[] = [];
const pilotHosts: PilotHostFacts[] = [];
if (existsSync(pilotDir)) {
  for (const slot of readdirSync(pilotDir).filter((n) => n.startsWith('slot-')).sort()) {
    for (const a of listAttemptDirs(join(pilotDir, slot))) {
      const r = readJson<AttemptRecord>(attemptFile(a.dir));
      if (!r) continue;
      attempts.push(toPilotAttempt(r, isolationReader(a.dir), shellReader(a.dir)));
      pilotHosts.push({ conditionId: r.conditionId, attempt: r.attempt, startedAt: r.startedAt, endedAt: r.endedAt, environment: pilotEnvironment(r.environment) });
    }
  }
}

const pins = { codex: models.roles.CC!.toolVersion, claude: models.roles.AC!.toolVersion };
const now = new Date();
let local: LocalProbe | null = null;
let host: ReturnType<typeof evaluateHostEvidence> | null = null;
if (values.evidence === 'local') {
  local = await probeLocalHost(root, pins, now.toISOString().replace(/[:.]/g, '-'));
} else {
  const dir = join(root, HOST_EVIDENCE_DIR);
  const files = existsSync(dir)
    ? readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => {
        const path = `${HOST_EVIDENCE_DIR}/${n}`;
        try {
          return { path, content: JSON.parse(readFileSync(join(dir, n), 'utf8')) as unknown };
        } catch (e) {
          return { path, content: { parseError: (e as Error).message } };
        }
      })
    : [];
  host = evaluateHostEvidence({ files, now, maxAgeDays, pins, pilots: pilotHosts });
}
const preflightInput = local
  ? { codex: { ok: local.codex.ok, termination: local.codex.termination }, claude: { ok: local.claude.ok, termination: local.claude.termination } }
  : host!.preflight;
const sandboxTool = local ? local.sandboxTool : host!.sandboxTool;
const recordedEvidence = host?.chosen?.evidence ?? null;
const scheduleReproduces = readFileSync(join(root, 'config', 'schedule.json'), 'utf8') === renderSchedule(generateSchedule(matrix));
const usageSemantics = readJsonFile<{ codex: { status: string; turnCompletedScope: unknown; cachedInputSubsetOfInput: unknown; reasoningIncludedInOutput: unknown } }>('config/usage-semantics.json');
// Safeguards the records cannot prove mechanically: records/<cohort>-pilots/safeguards.json (methodology section 14).
type SafeguardEntry = { id?: unknown; kind?: unknown; statement?: unknown; refs?: unknown; attestedBy?: unknown; attestedAt?: unknown };
const safeguardFile = join(root, paths.safeguards);
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const safeguards: SafeguardEvidence[] = (existsSync(safeguardFile) ? (JSON.parse(readFileSync(safeguardFile, 'utf8')) as { safeguards?: SafeguardEntry[] }).safeguards ?? [] : []).map((e) => {
  const refs = Array.isArray(e.refs) ? e.refs.filter((x): x is string => typeof x === 'string') : [];
  return { id: str(e.id) ?? '', kind: str(e.kind) ?? '', statement: str(e.statement) ?? '', refs, attestedBy: str(e.attestedBy), attestedAt: str(e.attestedAt), missingRefs: refs.filter((p) => p.startsWith('/') || p.split('/').includes('..') || !existsSync(join(root, p))) };
});
const priceFiles = readdirSync(join(root, 'prices')).filter((n) => /^cost-dev-.*\.csv$/.test(n));

const gate = evaluateGate({
  conditions: matrix.canonicalConditionOrder,
  plans,
  attempts,
  preflight: preflightInput,
  sandboxTool,
  hostEvidence: host?.unmet ?? [],
  scheduleReproduces,
  usageSemantics,
  priceSnapshot: { present: priceFiles.length > 0 },
  safeguards,
  repetitions: matrix.repetitions,
});

const tree = (dir: string, skip: (p: string) => boolean = () => false) => {
  const files = listFiles(join(root, dir)).filter((p) => !skip(p)).map((p) => ({ path: p, sha256: sha(join(root, dir, p)) }));
  return { files: files.length, sha256: treeDigest(files) };
};
const artifacts = {
  scaffold: tree('fixtures/scaffold', (p) => p.startsWith('checks/')),
  checkSuites: tree('fixtures/scaffold/checks'),
  references: tree('fixtures/references'),
  evaluator: tree('src/evaluator'),
  runner: tree('src', (p) => p.startsWith('evaluator/')),
  prompts: tree('prompts'),
  config: tree('config'),
  methodology: { files: 1, sha256: sha(join(root, 'methodology.md')) },
  task: { files: 1, sha256: sha(join(root, 'task.md')) },
  packageLock: { files: 1, sha256: sha(join(root, 'package-lock.json')) },
  priceSnapshot: tree('prices'),
};

const env = captureEnvironment(defaultEnvironmentDeps(root));
const report = {
  schema: 'harness-benchmark/freeze-readiness@1',
  cohort: matrix.cohort,
  checkedAt: now.toISOString(),
  evidenceSource: values.evidence,
  ready: gate.ready,
  frozen: false,
  unmet: gate.unmet,
  warnings: gate.warnings,
  pilots: {
    configurations: matrix.canonicalConditionOrder.length,
    covered: gate.coverage.covered.length,
    missing: gate.coverage.missing,
    operationalAttempts: gate.coverage.operational,
    exercised: gate.exercise.exercised,
    unexercised: gate.exercise.unexercised,
  },
  pilotEstimate: gate.estimate,
  pilotEstimateGaps: gate.estimateGaps,
  safeguards: { required: REQUIRED_SAFEGUARDS, file: relative(root, safeguardFile), evidence: safeguards.map(({ missingRefs: _m, ...e }) => e) },
  hostEvidence: host ? { dir: HOST_EVIDENCE_DIR, maxAgeDays, file: host.chosen?.path ?? null, evidence: recordedEvidence, unmet: host.unmet.map((u) => u.id) } : null,
  preflight: local
    ? {
        source: 'local',
        codex: { ok: local.codex.ok, pin: pins.codex, toolVersion: local.codex.toolVersion, loginMode: local.codex.loginMode, termination: local.codex.termination, detail: local.codex.detail },
        claude: { ok: local.claude.ok, pin: pins.claude, toolVersion: local.claude.toolVersion, loginMode: local.claude.loginMode, termination: local.claude.termination, detail: local.claude.detail, managedPolicy: local.claude.managedPolicy },
      }
    : {
        source: 'recorded',
        codex: { ...preflightInput.codex, pin: pins.codex, toolVersion: recordedEvidence?.preflight.codex.toolVersion ?? null, detail: recordedEvidence?.preflight.codex.detail ?? null },
        claude: { ...preflightInput.claude, pin: pins.claude, toolVersion: recordedEvidence?.preflight.claude.toolVersion ?? null, detail: recordedEvidence?.preflight.claude.detail ?? null },
      },
  isolation: local
    ? { source: 'local', platform: process.platform, sandboxTool, requiredForScoring: true }
    : { source: 'recorded', platform: recordedEvidence?.os.platform ?? null, sandboxTool, mechanism: recordedEvidence?.isolation.mechanism ?? null, requiredForScoring: true },
  scheduleReproduces,
  seed: matrix.schedule.seed,
  roles: Object.fromEntries(Object.entries(models.roles).map(([k, r]) => [k, { toolVersion: r.toolVersion, requestedModel: r.requestedModel, effort: r.effort }])),
  usageSemantics: { codex: usageSemantics.codex.status },
  priceSnapshotFiles: priceFiles,
  environment: env,
  artifacts,
};

const text = `${JSON.stringify(report, null, 2)}\n`;
process.stdout.write(text);
if (values.report) {
  mkdirSync(dirname(values.report), { recursive: true });
  writeFileSync(values.report, text);
  console.error(`wrote ${relative(process.cwd(), values.report)}`);
}
if (values.write) {
  const dest = join(root, 'records', 'freeze', `${matrix.cohort}.json`);
  if (!gate.ready) {
    console.error(`freeze gate not met (${gate.unmet.map((u) => u.id).join(', ')}); manifest not written`);
    process.exit(3);
  }
  if (existsSync(dest)) {
    console.error(`${dest} already exists; a changed freeze creates a new cohort`);
    process.exit(3);
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, `${JSON.stringify({ ...report, schema: 'harness-benchmark/freeze@1', frozen: true }, null, 2)}\n`);
  console.error(`wrote ${dest}`);
}
process.exit(gate.ready ? 0 : 3);
