/**
 * Filesystem side of the accounting: load the frozen inputs, walk a campaign's saved records, and
 * write `accounting.json` beside every `attempt.json`. Reads committed records only; needs no
 * credentials and starts no model process. Regenerating is idempotent.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AttemptRecord } from '../orchestrator/state.ts';
import { writeJsonAtomic } from '../orchestrator/state.ts';
import { parseUsageSemantics, type UsageSemantics } from './normalise.ts';
import { parsePriceSnapshot, type PriceSnapshot } from './prices.ts';
import { accountAttempt, type AccountingInput, type AttemptAccounting, type RoleConfig } from './record.ts';

export interface AccountingContext {
  snapshot: PriceSnapshot;
  semantics: UsageSemantics;
  roles: Record<string, RoleConfig>;
  provenance: AccountingInput['provenance'];
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Load the price snapshot named in config/analysis.json, the usage semantics and the role price rows. */
export function loadAccountingContext(root: string): AccountingContext {
  const analysis = JSON.parse(readFileSync(join(root, 'config', 'analysis.json'), 'utf8')) as { priceSnapshot: string };
  const models = JSON.parse(readFileSync(join(root, 'config', 'models.json'), 'utf8')) as { roles: Record<string, RoleConfig> };
  const priceText = readFileSync(join(root, analysis.priceSnapshot));
  const semText = readFileSync(join(root, 'config', 'usage-semantics.json'));
  return {
    snapshot: parsePriceSnapshot(priceText.toString('utf8')),
    semantics: parseUsageSemantics(JSON.parse(semText.toString('utf8'))),
    roles: Object.fromEntries(Object.entries(models.roles).map(([k, r]) => [k, { provider: r.provider, priceRow: r.priceRow }])),
    provenance: {
      priceSnapshot: { file: analysis.priceSnapshot, sha256: sha256(priceText) },
      usageSemantics: { file: 'config/usage-semantics.json', sha256: sha256(semText) },
    },
  };
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** Every attempt directory (one holding attempt.json) below a campaign records root, in path order. */
export function findAttemptDirs(recordsRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (existsSync(join(dir, 'attempt.json'))) {
      out.push(dir);
      return;
    }
    if (depth >= 3) return;
    for (const n of readdirSync(dir).sort()) if (isDir(join(dir, n))) walk(join(dir, n), depth + 1);
  };
  if (isDir(recordsRoot)) walk(recordsRoot, 0);
  return out;
}

/** Stage record dirs (`stages/<id>`) → parsed stage.json, or null when absent or unreadable. */
export function readStageRecords(attemptDir: string): Map<string, unknown> {
  const m = new Map<string, unknown>();
  const stagesDir = join(attemptDir, 'stages');
  if (!isDir(stagesDir)) return m;
  for (const n of readdirSync(stagesDir).sort()) {
    if (!isDir(join(stagesDir, n))) continue;
    const f = join(stagesDir, n, 'stage.json');
    let v: unknown = null;
    if (existsSync(f)) {
      try {
        v = JSON.parse(readFileSync(f, 'utf8'));
      } catch {
        v = { unreadable: true };
      }
    }
    m.set(`stages/${n}`, v);
  }
  return m;
}

/** `overlay` is the quota audit's view of the record (src/audit/files.ts `auditOverlay`); attempt.json is never changed. */
export function accountAttemptDir(dir: string, ctx: AccountingContext, overlay: (rec: AttemptRecord) => AttemptRecord = (r) => r): AttemptAccounting {
  const attempt = overlay(JSON.parse(readFileSync(join(dir, 'attempt.json'), 'utf8')) as AttemptRecord);
  return accountAttempt({ attempt, stageRecords: readStageRecords(dir), ...ctx });
}

/** Write accounting.json for every attempt under `recordsRoot`; returns the written paths. */
export function accountTree(recordsRoot: string, ctx: AccountingContext, overlay?: (rec: AttemptRecord) => AttemptRecord): Array<{ path: string; record: AttemptAccounting }> {
  return findAttemptDirs(recordsRoot).map((dir) => {
    const record = accountAttemptDir(dir, ctx, overlay);
    const path = join(dir, 'accounting.json');
    writeJsonAtomic(path, record);
    return { path: relative(recordsRoot, path), record };
  });
}
