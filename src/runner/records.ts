/**
 * Which files travel from the runner to the private bucket and from the bucket into this worktree.
 *
 * The instance syncs `records/` to `s3://<bucket>/records/`. `runner/aws/bin/fetch` downloads that
 * prefix into a staging directory under `.runs/fetch/`, then copies only the files this module
 * accepts into `examples/harness-benchmark/records/`. The allow-list is applied twice (S3 filters
 * on both syncs, then `recordPathFor` on every staged file) because a bucket object is untrusted
 * input: it must never write outside `records/`, and credentials, tool homes or workspace copies
 * must never reach a commit even if they were uploaded by mistake.
 *
 * Pure: no filesystem, process or network access.
 */
import { pathProblems } from './bundle.ts';

export const RECORDS_PREFIX = 'records/';
export const RECORD_EXTENSIONS = ['.json', '.jsonl', '.md', '.txt'] as const;
/** Path segments that never belong in records: tool homes, runtime state, dependencies, workspaces. */
export const DENIED_SEGMENTS = ['.runs', 'auth', 'node_modules', 'workspace', 'final', 'capture', '.git'] as const;
/** Base names that look like credentials or environment files, whatever their extension. */
const DENIED_NAME = /(^|[-_.])(auth|token|tokens|oauth|credential|credentials|secret|secrets|apikey|api-key)([-_.]|$)|^\.env/i;
/** Largest single record accepted (stage records and logs are far smaller). */
export const MAX_RECORD_BYTES = 16 * 1024 * 1024;

/**
 * Files written only in this worktree and published to the runner in the bundle, never fetched back:
 * a block's quota audit holds a person's decisions, and a runner copy is at best stale.
 */
export const LOCAL_ONLY_NAMES = ['audit.json'] as const;

export type RejectReason = 'path' | 'outside-records' | 'hidden' | 'denied-segment' | 'denied-name' | 'extension' | 'size' | 'local-only';

/** Classifies a path relative to `records/` (no prefix). Null means it may be synced. */
export function recordRejection(rel: string, bytes?: number): RejectReason | null {
  if (pathProblems(rel).length > 0) return 'path';
  const segs = rel.split('/');
  if (segs.some((s) => s.startsWith('.'))) return segs.some((s) => (DENIED_SEGMENTS as readonly string[]).includes(s)) ? 'denied-segment' : 'hidden';
  if (segs.some((s) => (DENIED_SEGMENTS as readonly string[]).includes(s))) return 'denied-segment';
  const base = segs.at(-1)!;
  if (DENIED_NAME.test(base)) return 'denied-name';
  if ((LOCAL_ONLY_NAMES as readonly string[]).includes(base)) return 'local-only';
  if (!RECORD_EXTENSIONS.some((e) => base.endsWith(e) && base.length > e.length)) return 'extension';
  if (bytes !== undefined && !(Number.isFinite(bytes) && bytes >= 0 && bytes <= MAX_RECORD_BYTES)) return 'size';
  return null;
}

/**
 * Maps a bucket key (`records/<rel>`) to its path relative to the benchmark root, or null when the
 * key is outside the records prefix or the file is not an allowed record.
 */
export function recordPathFor(key: string, bytes?: number): { path: string } | { rejected: RejectReason } {
  if (!key.startsWith(RECORDS_PREFIX)) return { rejected: 'outside-records' };
  const rel = key.slice(RECORDS_PREFIX.length);
  const r = recordRejection(rel, bytes);
  return r ? { rejected: r } : { path: `${RECORDS_PREFIX}${rel}` };
}

/**
 * `aws s3 sync` filter arguments matching the allow-list as closely as glob filters can. Later
 * filters take precedence in the AWS CLI, so the exclusions come last. `recordRejection` remains
 * the authority; these filters only keep unwanted objects off the wire.
 */
export function s3SyncFilterArgs(): string[] {
  return [
    '--exclude', '*',
    ...RECORD_EXTENSIONS.flatMap((e) => ['--include', `*${e}`]),
    ...DENIED_SEGMENTS.flatMap((s) => ['--exclude', `${s}/*`, '--exclude', `*/${s}/*`]),
    '--exclude', '.*', '--exclude', '*/.*',
    '--exclude', '*auth*', '--exclude', '*token*', '--exclude', '*credential*', '--exclude', '*secret*',
    ...LOCAL_ONLY_NAMES.flatMap((n) => ['--exclude', n, '--exclude', `*/${n}`]),
  ];
}

export interface StagedFile {
  /** Path relative to the staging directory, which mirrors `s3://<bucket>/records/`. */
  rel: string;
  bytes: number;
  sha256: string;
}

export interface FetchPlan {
  /** Files to copy: new or changed relative to the worktree. */
  copy: { from: string; to: string; change: 'new' | 'changed' }[];
  unchanged: string[];
  rejected: { rel: string; reason: RejectReason }[];
}

/**
 * Decides what a fetch writes. `existing` maps worktree paths (relative to the benchmark root) to
 * their SHA-256. Changed files are overwritten because campaign logs grow between fetches; the
 * fetch report lists them so the commit can be reviewed. Output order is sorted, so the plan is
 * independent of directory listing order.
 */
export function planFetch(staged: readonly StagedFile[], existing: ReadonlyMap<string, string>): FetchPlan {
  const plan: FetchPlan = { copy: [], unchanged: [], rejected: [] };
  const seen = new Set<string>();
  for (const f of [...staged].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    if (seen.has(f.rel)) continue;
    seen.add(f.rel);
    const m = recordPathFor(`${RECORDS_PREFIX}${f.rel}`, f.bytes);
    if ('rejected' in m) {
      plan.rejected.push({ rel: f.rel, reason: m.rejected });
      continue;
    }
    const prior = existing.get(m.path);
    if (prior === f.sha256) plan.unchanged.push(m.path);
    else plan.copy.push({ from: f.rel, to: m.path, change: prior === undefined ? 'new' : 'changed' });
  }
  return plan;
}
