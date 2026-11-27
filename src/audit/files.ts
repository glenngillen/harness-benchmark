/**
 * Filesystem side of the quota audit: collect an attempt's own evidence, and locate, read and write
 * block audits. A block's audit sits beside the attempts it audits, as
 * `records/<label>/<block-NN|pilot>/audit.json`, so each cohort keeps its own.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { blockDirName } from '../orchestrator/campaign.ts';
import { attemptFile, listAttemptDirs, readJson, writeJsonAtomic, type AttemptRecord } from '../orchestrator/state.ts';
import { applyAudit, AUDIT_SCHEMA, parseQuotaPatterns, type AuditedRecord, type BlockAudit, type EvidenceSource, type QuotaPatterns } from './quota.ts';

export const PATTERNS_FILE = 'config/quota-audit.json';

export const blockAuditFile = (recordsRoot: string, block: number) => join(recordsRoot, blockDirName(block), 'audit.json');

export function loadQuotaPatterns(root: string): { patterns: QuotaPatterns; ref: { file: string; sha256: string } } {
  const text = readFileSync(join(root, PATTERNS_FILE));
  return { patterns: parseQuotaPatterns(JSON.parse(text.toString('utf8'))), ref: { file: PATTERNS_FILE, sha256: createHash('sha256').update(text).digest('hex') } };
}

export function readBlockAudit(path: string): BlockAudit | null {
  const a = readJson<BlockAudit>(path);
  if (a === null) return null;
  if (a.schema !== AUDIT_SCHEMA || !Array.isArray(a.flags) || !Array.isArray(a.scanned)) throw new Error(`${path} is not a ${AUDIT_SCHEMA} file`);
  return a;
}

export const writeBlockAudit = (path: string, a: BlockAudit) => writeJsonAtomic(path, a);

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const readText = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

/**
 * Every source the methodology names, for one attempt: each stage's stderr.txt, events.jsonl,
 * last-message.md and stage.json (final message and termination detail), plus the attempt's own
 * termination detail. Paths are relative to `root`.
 */
export function collectEvidence(root: string, attemptDir: string, rec: AttemptRecord): EvidenceSource[] {
  const rel = (p: string) => relative(root, p);
  const out: EvidenceSource[] = [];
  if (rec.terminationDetail) out.push({ kind: 'termination', file: rel(attemptFile(attemptDir)), field: 'terminationDetail', text: rec.terminationDetail });
  for (const s of rec.stages ?? []) if (s.terminationDetail) out.push({ kind: 'termination', file: rel(attemptFile(attemptDir)), field: `stages[${s.id}].terminationDetail`, text: s.terminationDetail });
  const stagesDir = join(attemptDir, 'stages');
  if (!isDir(stagesDir)) return out;
  for (const n of readdirSync(stagesDir).sort()) {
    const d = join(stagesDir, n);
    if (!isDir(d)) continue;
    const stderr = readText(join(d, 'stderr.txt'));
    if (stderr) out.push({ kind: 'stderr', file: rel(join(d, 'stderr.txt')), text: stderr });
    const events = readText(join(d, 'events.jsonl'));
    if (events) out.push({ kind: 'events', file: rel(join(d, 'events.jsonl')), text: events });
    const last = readText(join(d, 'last-message.md'));
    if (last) out.push({ kind: 'final-message', file: rel(join(d, 'last-message.md')), text: last });
    const stageText = readText(join(d, 'stage.json'));
    if (stageText) {
      let stage: { finalMessage?: unknown; terminationDetail?: unknown } | null = null;
      try {
        stage = JSON.parse(stageText);
      } catch {
        // An unreadable stage.json is scanned as text: the evidence is still the attempt's own.
        out.push({ kind: 'termination', file: rel(join(d, 'stage.json')), field: 'stage.json', text: stageText });
      }
      if (stage && typeof stage.finalMessage === 'string' && stage.finalMessage && stage.finalMessage !== last) out.push({ kind: 'final-message', file: rel(join(d, 'stage.json')), field: 'finalMessage', text: stage.finalMessage });
      if (stage && typeof stage.terminationDetail === 'string' && stage.terminationDetail) out.push({ kind: 'termination', file: rel(join(d, 'stage.json')), field: 'terminationDetail', text: stage.terminationDetail });
    }
  }
  return out;
}

/** Every attempt of one block: raw record and directory. */
export function blockAttempts(recordsRoot: string, block: number): Array<{ dir: string; rec: AttemptRecord }> {
  const bDir = join(recordsRoot, blockDirName(block));
  if (!isDir(bDir)) return [];
  return readdirSync(bDir)
    .filter((n) => /^slot-\d+-/.test(n) && isDir(join(bDir, n)))
    .sort()
    .flatMap((n) => listAttemptDirs(join(bDir, n)))
    .map(({ dir }) => ({ dir, rec: readJson<AttemptRecord>(attemptFile(dir)) }))
    .filter((x): x is { dir: string; rec: AttemptRecord } => x.rec !== null);
}

/**
 * The overlay a campaign or analysis applies to a raw record: its block's audit decisions. Each
 * block's audit is read once per overlay, so build a new overlay for each run; a decision recorded
 * between runs takes effect on the next run.
 */
export function auditOverlay(root: string, recordsRoot: string): (rec: AttemptRecord) => AuditedRecord {
  const cache = new Map<number, BlockAudit | null>();
  return (rec) => {
    const file = blockAuditFile(recordsRoot, rec.block);
    if (!cache.has(rec.block)) cache.set(rec.block, readBlockAudit(file));
    return applyAudit(rec, cache.get(rec.block)!, relative(root, file));
  };
}
