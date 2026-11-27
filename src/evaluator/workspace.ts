/**
 * Prepares a fresh evaluation workspace from a frozen snapshot.
 *
 * The evaluator never trusts the snapshot's fixed files: package.json, the lockfile, tsconfig.json,
 * .gitignore, TASK.md and checks/ are replaced by the protected scaffold copies, and node_modules is
 * copied from the protected scaffold install. Only the model's src/, ui/ and other own files are
 * evaluated. Differences in fixed files are recorded as evidence, never honoured.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { InfrastructureError } from './expect.ts';

/** Files the brief forbids changing, plus everything under these directories. */
export const FIXED_FILES = ['package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', 'TASK.md'] as const;
export const FIXED_DIRS = ['checks'] as const;
/** Never copied from a snapshot: VCS data, installed dependencies, build output, runtime state. */
const SKIP_TOP = new Set(['.git', 'node_modules', 'dist', 'data']);
const SKIP_ANY = new Set(['.git', 'node_modules']);

export const SNAPSHOT_LIMITS = { maxFiles: 5_000, maxBytes: 50 * 1024 * 1024 };

export interface SnapshotEntry {
  path: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
}

export interface CopyPlan {
  files: string[];
  ignored: { path: string; reason: string }[];
  bytes: number;
}

export type FixedChange = { path: string; change: 'modified' | 'missing' | 'added' };

const isFixed = (path: string) => (FIXED_FILES as readonly string[]).includes(path) || FIXED_DIRS.some((d) => path === d || path.startsWith(`${d}/`));

/** Pure: which snapshot entries are copied, and which are ignored and why. */
export function planCopy(entries: readonly SnapshotEntry[]): CopyPlan {
  const files: string[] = [];
  const ignored: CopyPlan['ignored'] = [];
  let bytes = 0;
  for (const e of entries) {
    const parts = e.path.split('/');
    if (SKIP_TOP.has(parts[0]!) || parts.some((p) => SKIP_ANY.has(p))) continue;
    if (e.kind === 'symlink') ignored.push({ path: e.path, reason: 'symbolic link not followed' });
    else if (e.kind === 'other') ignored.push({ path: e.path, reason: 'not a regular file' });
    else if (e.kind === 'file') {
      files.push(e.path);
      bytes += e.size;
    }
  }
  files.sort();
  ignored.sort((a, b) => a.path.localeCompare(b.path));
  return { files, ignored, bytes };
}

/** Pure: how the snapshot's fixed files differ from the protected copies (content hashes by path). */
export function diffFixed(protectedHashes: ReadonlyMap<string, string>, snapshotHashes: ReadonlyMap<string, string>): FixedChange[] {
  const out: FixedChange[] = [];
  for (const [path, hash] of protectedHashes) {
    const seen = snapshotHashes.get(path);
    if (seen === undefined) out.push({ path, change: 'missing' });
    else if (seen !== hash) out.push({ path, change: 'modified' });
  }
  for (const path of snapshotHashes.keys()) if (isFixed(path) && !protectedHashes.has(path)) out.push({ path, change: 'added' });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Pure: a digest over sorted (path, content-hash) pairs. */
export function treeHash(hashes: ReadonlyMap<string, string>): string {
  const h = createHash('sha256');
  for (const path of [...hashes.keys()].sort()) h.update(`${path}\0${hashes.get(path)}\n`);
  return h.digest('hex');
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** Lists entries without following symbolic links. */
export function scan(root: string): SnapshotEntry[] {
  const out: SnapshotEntry[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      if (!rel && SKIP_TOP.has(name)) continue;
      if (SKIP_ANY.has(name)) continue;
      const st = lstatSync(join(root, path));
      if (st.isSymbolicLink()) out.push({ path, kind: 'symlink', size: 0 });
      else if (st.isDirectory()) {
        out.push({ path, kind: 'dir', size: 0 });
        walk(path);
      } else if (st.isFile()) out.push({ path, kind: 'file', size: st.size });
      else out.push({ path, kind: 'other', size: 0 });
    }
  };
  walk('');
  return out;
}

export function hashFiles(root: string, files: readonly string[]): Map<string, string> {
  return new Map(files.map((f) => [f, sha256(readFileSync(join(root, f)))]));
}

export interface PreparedWorkspace {
  status: 'ready' | 'missing-output' | 'snapshot-too-large';
  appDir: string;
  snapshotHash: string | null;
  snapshotFiles: number;
  snapshotBytes: number;
  ignored: CopyPlan['ignored'];
  fixedChanges: FixedChange[];
}

/**
 * Copies the snapshot into `<workDir>/app`, restores fixed files, and installs protected
 * dependencies. Throws InfrastructureError when protected inputs are unavailable.
 */
export function prepareWorkspace(snapshotDir: string, scaffoldDir: string, workDir: string): PreparedWorkspace {
  const appDir = join(workDir, 'app');
  const empty: PreparedWorkspace = { status: 'missing-output', appDir, snapshotHash: null, snapshotFiles: 0, snapshotBytes: 0, ignored: [], fixedChanges: [] };
  if (!existsSync(join(scaffoldDir, 'node_modules', 'typescript'))) {
    throw new InfrastructureError(`protected scaffold dependencies are not installed in ${scaffoldDir} (run npm run fixtures:install)`);
  }
  if (!existsSync(snapshotDir) || !statSync(snapshotDir).isDirectory()) return empty;
  const plan = planCopy(scan(snapshotDir));
  if (plan.files.length === 0) return { ...empty, ignored: plan.ignored };
  const sizes = { snapshotFiles: plan.files.length, snapshotBytes: plan.bytes };
  if (plan.files.length > SNAPSHOT_LIMITS.maxFiles || plan.bytes > SNAPSHOT_LIMITS.maxBytes) {
    return { ...empty, ...sizes, status: 'snapshot-too-large', ignored: plan.ignored };
  }

  const snapshotHashes = hashFiles(snapshotDir, plan.files);
  const protectedFiles = planCopy(scan(scaffoldDir)).files.filter(isFixed);
  const protectedHashes = hashFiles(scaffoldDir, protectedFiles);
  const fixedChanges = diffFixed(protectedHashes, new Map([...snapshotHashes].filter(([p]) => isFixed(p))));

  mkdirSync(appDir, { recursive: true });
  for (const f of plan.files) {
    if (isFixed(f)) continue;
    mkdirSync(dirname(join(appDir, f)), { recursive: true });
    writeFileSync(join(appDir, f), readFileSync(join(snapshotDir, f)));
  }
  for (const f of protectedFiles) {
    mkdirSync(dirname(join(appDir, f)), { recursive: true });
    writeFileSync(join(appDir, f), readFileSync(join(scaffoldDir, f)));
  }
  cpSync(join(scaffoldDir, 'node_modules'), join(appDir, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  return { status: 'ready', appDir, snapshotHash: treeHash(snapshotHashes), ...sizes, ignored: plan.ignored, fixedChanges };
}

/** Frees disk after evaluation; the snapshot itself is never touched. */
export function discardDependencies(appDir: string): void {
  rmSync(join(appDir, 'node_modules'), { recursive: true, force: true });
}
