/**
 * Filesystem side of the analysis: read the frozen configuration and a campaign's saved records,
 * regenerating each attempt's accounting in memory from `attempt.json` + `stage.json` with the one
 * price snapshot named in config/analysis.json. No credentials, no network, no model process, and
 * nothing under records/ is written.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { auditOverlay, blockAttempts, blockAuditFile, loadQuotaPatterns, readBlockAudit } from '../audit/files.ts';
import { auditCoverage, type BlockAuditStatus } from '../audit/quota.ts';
import type { AttemptAccounting } from '../accounting/record.ts';
import { accountAttemptDir, findAttemptDirs, loadAccountingContext } from '../accounting/tree.ts';
import type { Schedule } from '../orchestrator/schedule.ts';
import type { AnalysisMatrix, RoleInfo } from './aggregate.ts';
import type { BootstrapOptions } from './stats.ts';

export interface AnalysisConfig {
  matrix: AnalysisMatrix;
  schedule: Schedule;
  roles: Record<string, RoleInfo>;
  bootstrap: BootstrapOptions;
  priceSnapshotFile: string;
  /** Date in the snapshot's file name (`cost-dev-YYYY-MM-DD.csv`). */
  snapshotDate: string;
  ceilingMinutes: number;
}

const json = <T>(root: string, rel: string): T => JSON.parse(readFileSync(join(root, rel), 'utf8')) as T;

export function snapshotDateOf(file: string): string {
  const m = /(\d{4}-\d{2}-\d{2})\.csv$/.exec(file);
  if (!m) throw new Error(`price snapshot ${file} has no date in its name`);
  return m[1]!;
}

export function loadAnalysisConfig(root: string): AnalysisConfig {
  const analysis = json<{ priceSnapshot: string; costInterval: { resamples: number; confidence: number; seed: number } }>(root, 'config/analysis.json');
  const models = json<{ roles: Record<string, RoleInfo> }>(root, 'config/models.json');
  const limits = json<{ workflowCeilingMinutes: number }>(root, 'config/limits.json');
  return {
    matrix: json<AnalysisMatrix>(root, 'config/matrix.json'),
    schedule: json<Schedule>(root, 'config/schedule.json'),
    roles: Object.fromEntries(Object.entries(models.roles).map(([k, r]) => [k, { label: r.label, tier: r.tier, provider: r.provider, requestedModel: r.requestedModel, effort: r.effort }])),
    bootstrap: { seed: analysis.costInterval.seed, resamples: analysis.costInterval.resamples, confidence: analysis.costInterval.confidence },
    priceSnapshotFile: analysis.priceSnapshot,
    snapshotDate: snapshotDateOf(analysis.priceSnapshot),
    ceilingMinutes: limits.workflowCeilingMinutes,
  };
}

/** Every attempt under records/<label>, accounted in memory with its block's quota audit decisions applied. */
export function readCampaign(root: string, label: string): AttemptAccounting[] {
  const ctx = loadAccountingContext(root);
  const recordsRoot = join(root, 'records', label);
  const overlay = auditOverlay(root, recordsRoot);
  return findAttemptDirs(recordsRoot).map((dir) => accountAttemptDir(dir, ctx, overlay));
}

/** Quota audit coverage of every scored block (`block-NN`) under records/<label>. */
export function readAuditStatuses(root: string, label: string): BlockAuditStatus[] {
  const recordsRoot = join(root, 'records', label);
  if (!existsSync(recordsRoot)) return [];
  const blocks = readdirSync(recordsRoot)
    .map((n) => /^block-(\d+)$/.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  const current = loadQuotaPatterns(root).ref.sha256;
  return blocks.map((b) => auditCoverage(b, readBlockAudit(blockAuditFile(recordsRoot, b)), blockAttempts(recordsRoot, b).map((x) => x.rec), current));
}
