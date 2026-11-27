/**
 * Quota-misclassification audit of one fetched block (methodology section 8).
 *
 *   npm run audit-block -- --block 1                 # scan; write records/<cohort>/block-01/audit.json
 *   npm run audit-block -- --pilots                  # same over the unscored pilots (records/<cohort>-pilots/pilot/audit.json)
 *   npm run audit-block -- --block 1 --decide <flag-id> --decision reclassified|dismissed \
 *       --reason "…" --by "<name>"                   # record one decision (never overwrites one)
 *   npm run audit-block -- --block 1 --check         # report only; write nothing
 *   npm run audit-block -- --pilots --check --all-outcomes   # diagnostic: pattern noise over every finished pilot
 *
 * Scans every scored-failure attempt's stage stderr.txt, events.jsonl, last-message.md, stage.json
 * and termination details with the frozen pattern list in config/quota-audit.json. Rescanning keeps
 * earlier decisions. A `reclassified` decision makes the attempt operational `quota-exhausted` for
 * the campaign and the analysis (attempt.json is not changed); rerun `npm run campaign -- --block N`
 * at a published revision carrying the audit to refill the slot, then fetch and audit again.
 *
 * Exit 0: audit complete (no pending flag, every scored failure scanned). Exit 3: incomplete.
 * Exit 2: usage error. Exit 1: refused (for example, records changed under a decision).
 */
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { blockAttempts, blockAuditFile, collectEvidence, loadQuotaPatterns, readBlockAudit, writeBlockAudit } from '../audit/files.ts';
import { auditCoverage, buildAudit, recordDecision, type BlockAudit } from '../audit/quota.ts';
import { BENCHMARK_ROOT } from '../fixtures.ts';
import { loadConfig } from '../orchestrator/run.ts';
import { pilotsLabel } from '../orchestrator/cohort.ts';

const { values } = parseArgs({
  options: {
    block: { type: 'string' },
    pilots: { type: 'boolean', default: false },
    label: { type: 'string' },
    decide: { type: 'string' },
    decision: { type: 'string' },
    reason: { type: 'string' },
    by: { type: 'string' },
    check: { type: 'boolean', default: false },
    'all-outcomes': { type: 'boolean', default: false },
  },
});
const usage = 'usage: npm run audit-block -- (--block N | --pilots) [--label L] [--check] [--decide FLAG --decision reclassified|dismissed --reason TEXT --by NAME]';
const conf = loadConfig();
const block = values.block === undefined ? null : Number(values.block);
if (values.pilots === (block !== null) || (block !== null && !(Number.isInteger(block) && block >= 1 && block <= conf.schedule.blocks.length))) {
  console.error(`${usage}\nchoose exactly one of --pilots or --block 1..${conf.schedule.blocks.length}`);
  process.exit(2);
}
const label = values.label ?? (values.pilots ? pilotsLabel(conf.matrix.cohort) : conf.matrix.cohort);
if (!/^[a-z0-9][a-z0-9-]*$/.test(label)) {
  console.error(usage);
  process.exit(2);
}
const deciding = values.decide !== undefined;
if (deciding && (!values.decision || !values.reason || !values.by)) {
  console.error(`${usage}\n--decide needs --decision, --reason and --by`);
  process.exit(2);
}
if (values['all-outcomes'] && !(values.pilots && values.check && !deciding)) {
  console.error('--all-outcomes is a pilot diagnostic: use it only with --pilots --check');
  process.exit(2);
}
if (deciding && values.check) {
  console.error('--check writes nothing; it cannot record a decision');
  process.exit(2);
}

const b = block ?? 0;
const recordsRoot = join(BENCHMARK_ROOT, 'records', label);
const file = blockAuditFile(recordsRoot, b);
const rel = relative(BENCHMARK_ROOT, file);
const attempts = blockAttempts(recordsRoot, b);
if (attempts.length === 0) {
  console.error(`no attempt records under ${relative(BENCHMARK_ROOT, join(recordsRoot))} for block ${b}; fetch the block first`);
  process.exit(1);
}

let audit: BlockAudit;
let consoleLimit = 20;
try {
  const previous = values['all-outcomes'] ? null : readBlockAudit(file);
  const { patterns, ref } = loadQuotaPatterns(BENCHMARK_ROOT);
  consoleLimit = patterns.consoleFlagsPerAttempt;
  audit = buildAudit(
    { label, block: b, patterns: ref, generatedAt: new Date().toISOString(), attempts: attempts.map(({ dir, rec }) => ({ rec, sources: collectEvidence(BENCHMARK_ROOT, dir, rec) })), scope: values['all-outcomes'] ? 'all-finished' : 'scored-failure' },
    patterns,
    previous,
  );
  // An unchanged scan keeps the previous timestamp, so a rerun does not rewrite the file.
  if (previous && JSON.stringify({ ...previous, generatedAt: '' }) === JSON.stringify({ ...audit, generatedAt: '' })) audit = previous;
  if (deciding) {
    audit = recordDecision(audit, { flagId: values.decide!, status: values.decision as 'reclassified' | 'dismissed', reason: values.reason!, decidedBy: values.by!, decidedAt: new Date().toISOString() });
  }
} catch (e) {
  console.error(`audit refused: ${(e as Error).message}`);
  process.exit(1);
}

if (!values.check) writeBlockAudit(file, audit);
const coverage = audit.scope === 'all-finished' ? { status: audit.status } : auditCoverage(b, audit, attempts.map((a) => a.rec));
const scoredFailures = audit.scanned.length;
console.log(`${values.check ? '(check only) ' : ''}${rel}: ${label} block ${b}; ${attempts.length} attempt(s), ${scoredFailures} ${audit.scope === 'all-finished' ? 'finished attempt(s) (diagnostic scope, all outcomes)' : 'scored failure(s)'} scanned, ${audit.flags.length} flag(s), ${audit.pendingFlags} pending, ${audit.reclassified.length} attempt(s) reclassified`);
// Console display only: audit.json keeps every flag. Pending flags are listed first so a long
// attempt never hides the ones still needing a decision behind decided ones.
for (const s of audit.scanned) {
  const own = audit.flags.filter((f) => f.slot === s.slot && f.attempt === s.attempt);
  const shown = [...own.filter((f) => f.decision.status === 'pending'), ...own.filter((f) => f.decision.status !== 'pending')].slice(0, consoleLimit);
  for (const f of shown) console.log(`  ${f.id}\t${f.decision.status}\tslot ${f.slot} attempt ${f.attempt}\t${f.rules.join(',')}\t${f.file} ${f.locator}\t${f.excerpt}`);
  if (own.length > shown.length) console.log(`  … ${own.length - shown.length} more flag(s) for slot ${s.slot} attempt ${s.attempt} (${own.filter((f) => f.decision.status === 'pending').length} pending in total); every flag is in ${rel}`);
  if (s.truncatedMatches) console.log(`  slot ${s.slot} attempt ${s.attempt}: this audit was made by a capped scanner that discarded ${s.truncatedMatches} match(es); rescan before deciding`);
}
if (audit.reclassified.length) console.log(`refill: rerun the campaign for block ${b} at a published revision carrying ${rel}; each reclassified slot gets an operational replacement under the ordinary budget`);
console.log(`audit ${coverage.status}`);
process.exit(coverage.status === 'complete' ? 0 : 3);
