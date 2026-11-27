/**
 * The operating environment of an attempt (methodology section 10, per workflow). Only public
 * facts: OS, architecture, CPU model and count, memory, Node.js version, the benchmark's Git
 * revision, and a SHA-256 of /etc/machine-id (`hostId`). The hash ties an attempt to the host whose
 * recorded evidence the freeze gate accepts, so two instances built from one image are not
 * interchangeable; the raw machine id is never recorded. `hostId` is null on a host without
 * /etc/machine-id (macOS, for example). No hostname, username, home path or environment variables
 * are recorded.
 *
 * On the AWS runner the working directory is an unpacked `git archive` bundle, not a checkout. Then
 * the revision comes from the bundle manifest the instance verified (`.runner-release.json`) and is
 * marked `source: "bundle"`; `dirty` is null because there is no Git index to compare against.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RELEASE_FILE, parseBundleManifest } from '../runner/bundle.ts';
import { arch, cpus, platform, release, totalmem, type as osType } from 'node:os';

export interface EnvironmentFacts {
  os: { type: string; platform: string; release: string; arch: string };
  cpu: { model: string | null; count: number };
  memoryBytes: number;
  node: string;
  /** SHA-256 hex of the first line of /etc/machine-id, or null when there is none. */
  hostId: string | null;
  benchmarkRevision: { commit: string | null; dirty: boolean | null; source?: 'bundle' };
}

export interface EnvironmentDeps {
  os(): EnvironmentFacts['os'];
  cpus(): Array<{ model: string }>;
  totalmem(): number;
  nodeVersion: string;
  git(args: string[]): string | null;
  /** Contents of the runner's `.runner-release.json`, or null when absent (a normal checkout). */
  release?(): unknown;
  /** Raw contents of /etc/machine-id, or null when absent. Hashed before it is recorded. */
  machineId?(): string | null;
}

export const defaultEnvironmentDeps = (cwd: string): EnvironmentDeps => ({
  os: () => ({ type: osType(), platform: platform(), release: release(), arch: arch() }),
  cpus,
  totalmem,
  nodeVersion: process.version,
  git: (args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    } catch {
      return null;
    }
  },
  release: () => {
    try {
      return JSON.parse(readFileSync(join(cwd, RELEASE_FILE), 'utf8')) as unknown;
    } catch {
      return null;
    }
  },
  machineId: () => {
    try {
      return readFileSync('/etc/machine-id', 'utf8');
    } catch {
      return null;
    }
  },
});

/** SHA-256 of the first non-blank line of a machine-id file, or null. Pure. */
export function machineIdHash(raw: string | null): string | null {
  const id = raw === null ? '' : (raw.split('\n')[0] ?? '').trim();
  return id === '' ? null : createHash('sha256').update(id).digest('hex');
}

/** Pure given its deps. */
export function captureEnvironment(d: EnvironmentDeps): EnvironmentFacts {
  const c = d.cpus();
  const commit = d.git(['rev-parse', 'HEAD']);
  const status = commit === null ? null : d.git(['status', '--porcelain', '--', '.']);
  const valid = commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
  let benchmarkRevision: EnvironmentFacts['benchmarkRevision'] = { commit: valid, dirty: status === null ? null : status !== '' };
  if (valid === null && d.release) {
    const r = parseBundleManifest(d.release());
    if (r.ok) benchmarkRevision = { commit: r.manifest.revision, dirty: null, source: 'bundle' };
  }
  return {
    os: d.os(),
    cpu: { model: c[0]?.model.trim() ?? null, count: c.length },
    memoryBytes: d.totalmem(),
    node: d.nodeVersion,
    hostId: machineIdHash(d.machineId ? d.machineId() : null),
    benchmarkRevision,
  };
}
