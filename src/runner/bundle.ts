/**
 * Source bundles for the AWS Linux runner (runner/aws/). `runner/aws/bin/publish` makes a
 * `git archive` of `examples/harness-benchmark` at one commit and uploads it, with this manifest,
 * to the private bucket. The instance verifies the archive digest against the manifest before
 * unpacking, and keeps the manifest as `.runner-release.json` so attempt records can name the
 * revision even though the instance has no Git checkout.
 *
 * Pure: the shell scripts gather the facts (revision, tree, archive digest, file list).
 */

export const BUNDLE_SCHEMA = 'harness-benchmark/runner-bundle@1';
/** Directory every path in the archive sits under (`git archive --prefix`). */
export const BUNDLE_PREFIX = 'harness-benchmark/';
/** Name of the manifest copy inside the unpacked working directory. */
export const RELEASE_FILE = '.runner-release.json';
/** Files the instance needs from every bundle; publishing anything else is a mistake. */
export const REQUIRED_BUNDLE_FILES = ['package.json', 'package-lock.json', '.node-version', 'runner/aws/remote/campaign.sh', 'config/models.json'] as const;

export interface BundleManifest {
  schema: typeof BUNDLE_SCHEMA;
  revision: string;
  tree: string;
  createdAt: string;
  archive: { key: string; sha256: string; bytes: number };
  files: number;
  /** SHA-256 of the sorted file list, one path per line: detects a manifest paired with the wrong archive. */
  fileListSha256: string;
}

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const bundleKey = (revision: string) => `bundles/${revision}.tar.gz`;
export const manifestKey = (revision: string) => `bundles/${revision}.json`;
export const LATEST_KEY = 'bundles/latest.json';

/** Problems with one archive-relative path; empty when it is a plain relative path. */
export function pathProblems(p: string): string[] {
  const out: string[] = [];
  if (p === '') out.push('empty path');
  if (p.startsWith('/')) out.push(`absolute path ${JSON.stringify(p)}`);
  if (p.includes('\\')) out.push(`backslash in ${JSON.stringify(p)}`);
  if (/[\u0000-\u001f\u007f]/.test(p)) out.push(`control character in ${JSON.stringify(p)}`);
  const segs = p.split('/');
  if (segs.some((s) => s === '..' || s === '.')) out.push(`dot segment in ${JSON.stringify(p)}`);
  if (p !== '' && segs.some((s) => s === '')) out.push(`empty segment in ${JSON.stringify(p)}`);
  return out;
}

/** Sorted, de-duplicated paths and the digest input committed in the manifest. */
export function fileListText(files: readonly string[]): string {
  return [...new Set(files)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((f) => `${f}\n`).join('');
}

export interface BundleFacts {
  revision: string;
  tree: string;
  createdAt: string;
  archiveSha256: string;
  archiveBytes: number;
  /** Paths relative to the benchmark root (the archive prefix stripped). */
  files: readonly string[];
  /** SHA-256 of `fileListText(files)`, computed by the caller (keeps this module free of crypto). */
  fileListSha256: string;
}

/** Builds the manifest, or throws listing every problem with the facts. */
export function buildBundleManifest(f: BundleFacts): BundleManifest {
  const problems: string[] = [];
  if (!SHA1.test(f.revision)) problems.push('revision must be a full 40-character commit id');
  if (!SHA1.test(f.tree)) problems.push('tree must be a full 40-character tree id');
  if (!ISO.test(f.createdAt) || Number.isNaN(Date.parse(f.createdAt))) problems.push('createdAt must be an ISO UTC timestamp');
  if (!SHA256.test(f.archiveSha256)) problems.push('archive digest must be a SHA-256 hex string');
  if (!SHA256.test(f.fileListSha256)) problems.push('file-list digest must be a SHA-256 hex string');
  if (!(Number.isSafeInteger(f.archiveBytes) && f.archiveBytes > 0)) problems.push('archive size must be a positive integer');
  for (const p of f.files) problems.push(...pathProblems(p));
  const set = new Set(f.files);
  for (const r of REQUIRED_BUNDLE_FILES) if (!set.has(r)) problems.push(`bundle lacks ${r}`);
  for (const p of f.files) if (p === '.runs' || p.startsWith('.runs/') || p.split('/').includes('node_modules')) problems.push(`bundle must not contain ${p}`);
  if (problems.length > 0) throw new Error(`invalid bundle: ${problems.join('; ')}`);
  return {
    schema: BUNDLE_SCHEMA,
    revision: f.revision,
    tree: f.tree,
    createdAt: f.createdAt,
    archive: { key: bundleKey(f.revision), sha256: f.archiveSha256, bytes: f.archiveBytes },
    files: set.size,
    fileListSha256: f.fileListSha256,
  };
}

/** Validates an untrusted manifest (from the bucket or `.runner-release.json`). Never throws. */
export function parseBundleManifest(x: unknown): { ok: true; manifest: BundleManifest } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const o = (typeof x === 'object' && x !== null && !Array.isArray(x) ? x : {}) as Record<string, unknown>;
  const a = (typeof o.archive === 'object' && o.archive !== null ? o.archive : {}) as Record<string, unknown>;
  if (o.schema !== BUNDLE_SCHEMA) problems.push(`schema must be ${BUNDLE_SCHEMA}`);
  const revision = typeof o.revision === 'string' && SHA1.test(o.revision) ? o.revision : null;
  if (!revision) problems.push('revision missing or malformed');
  if (!(typeof o.tree === 'string' && SHA1.test(o.tree))) problems.push('tree missing or malformed');
  if (!(typeof o.createdAt === 'string' && ISO.test(o.createdAt))) problems.push('createdAt missing or malformed');
  if (!(typeof a.sha256 === 'string' && SHA256.test(a.sha256))) problems.push('archive.sha256 missing or malformed');
  if (!(typeof a.bytes === 'number' && Number.isSafeInteger(a.bytes) && a.bytes > 0)) problems.push('archive.bytes missing or invalid');
  if (revision && a.key !== bundleKey(revision)) problems.push('archive.key does not match the revision');
  if (!(typeof o.files === 'number' && Number.isSafeInteger(o.files) && o.files > 0)) problems.push('files missing or invalid');
  if (!(typeof o.fileListSha256 === 'string' && SHA256.test(o.fileListSha256))) problems.push('fileListSha256 missing or malformed');
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    manifest: {
      schema: BUNDLE_SCHEMA,
      revision: revision!,
      tree: o.tree as string,
      createdAt: o.createdAt as string,
      archive: { key: a.key as string, sha256: a.sha256 as string, bytes: a.bytes as number },
      files: o.files as number,
      fileListSha256: o.fileListSha256 as string,
    },
  };
}

/** Strips the archive prefix from `tar -tzf` / `git ls-tree` output lines; drops directory entries. */
export function archiveEntries(listing: string, prefix = BUNDLE_PREFIX): string[] {
  return listing
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l !== '' && !l.endsWith('/'))
    .map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : null))
    .filter((l): l is string => l !== null && l !== '');
}
