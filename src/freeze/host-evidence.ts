/**
 * Host evidence recorded on the machine that runs the pilots (the AWS Linux runner, or a reader's
 * own Linux host). `npm run host-evidence` runs both subscription preflights and the OS-sandbox
 * probe there and writes one JSON file per check under `records/<cohort>-pilots/host-evidence/`. The freeze
 * gate then evaluates that recorded evidence instead of probing whatever machine runs
 * `npm run freeze`, because the agent loop's own macOS sandbox cannot apply a nested sandbox and has
 * no subscription logins: probing it says nothing about the runner.
 *
 * Fails closed. Missing, malformed, stale or inconsistent evidence is an unmet gate condition, and
 * then the gate's preflight and isolation inputs are forced to "not ok" rather than trusting the
 * newest file anyway.
 *
 * Pure: the CLI gathers files and pilot facts.
 */
import { sandboxMechanism, type PreflightStatus, type Unmet } from './gate.ts';

export const HOST_EVIDENCE_SCHEMA = 'harness-benchmark/host-evidence@1';
/** Evidence older than this at freeze time is stale, however it relates to the pilots. */
export const DEFAULT_MAX_AGE_DAYS = 14;
/** Allowed clock skew between the runner and the machine evaluating its evidence. */
const FUTURE_SKEW_MS = 5 * 60_000;

export type EvidencePhase = 'before-campaign' | 'after-campaign' | 'manual';
const PHASES: readonly EvidencePhase[] = ['before-campaign', 'after-campaign', 'manual'];

export interface ToolPreflight {
  ok: boolean;
  toolVersion: string | null;
  termination: string | null;
  detail: string | null;
}

export interface HostEvidence {
  schema: typeof HOST_EVIDENCE_SCHEMA;
  checkedAt: string;
  phase: EvidencePhase;
  /** Free-text runner label, for example `aws-ec2/ap-southeast-2/t3.medium`; null on an unlabelled host. */
  runner: string | null;
  /** SHA-256 of /etc/machine-id: identifies the host across files without naming it. */
  hostId: string | null;
  os: { type: string; platform: string; release: string; arch: string; distribution: string | null };
  node: string;
  benchmarkRevision: { commit: string | null; source: 'git' | 'bundle' | null };
  preflight: { codex: ToolPreflight; claude: ToolPreflight };
  isolation: {
    /** Path of a sandbox tool that applied a probe sandbox, or null. */
    sandboxTool: string | null;
    mechanism: 'bwrap' | 'sandbox-exec' | null;
    toolVersion: string | null;
    /** Raw kernel settings that govern unprivileged user namespaces (Linux), as read. */
    kernel: { maxUserNamespaces: string | null; apparmorRestrictUnprivilegedUserns: string | null; unprivilegedUsernsClone: string | null };
  };
}

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Obj) : {});
const strOrNull = (x: unknown): x is string | null => x === null || typeof x === 'string';

function parsePreflight(x: unknown, name: string, problems: string[]): ToolPreflight {
  const o = obj(x);
  if (typeof o.ok !== 'boolean') problems.push(`preflight.${name}.ok must be a boolean`);
  for (const k of ['toolVersion', 'termination', 'detail'] as const) if (!strOrNull(o[k])) problems.push(`preflight.${name}.${k} must be a string or null`);
  return { ok: o.ok === true, toolVersion: (o.toolVersion as string | null) ?? null, termination: (o.termination as string | null) ?? null, detail: (o.detail as string | null) ?? null };
}

/** Validates one untrusted evidence file. Never throws. */
export function parseHostEvidence(x: unknown): { ok: true; evidence: HostEvidence } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const o = obj(x);
  if (o.schema !== HOST_EVIDENCE_SCHEMA) problems.push(`schema must be ${HOST_EVIDENCE_SCHEMA}`);
  if (!(typeof o.checkedAt === 'string' && ISO.test(o.checkedAt) && !Number.isNaN(Date.parse(o.checkedAt)))) problems.push('checkedAt must be an ISO UTC timestamp');
  if (!PHASES.includes(o.phase as EvidencePhase)) problems.push(`phase must be one of ${PHASES.join(', ')}`);
  if (!strOrNull(o.runner)) problems.push('runner must be a string or null');
  if (!(o.hostId === null || (typeof o.hostId === 'string' && SHA256.test(o.hostId)))) problems.push('hostId must be a SHA-256 hex string or null');
  const os = obj(o.os);
  for (const k of ['type', 'platform', 'release', 'arch'] as const) if (typeof os[k] !== 'string' || os[k] === '') problems.push(`os.${k} must be a non-empty string`);
  if (!strOrNull(os.distribution)) problems.push('os.distribution must be a string or null');
  if (typeof o.node !== 'string' || o.node === '') problems.push('node must be a non-empty string');
  const rev = obj(o.benchmarkRevision);
  if (!(rev.commit === null || (typeof rev.commit === 'string' && SHA1.test(rev.commit)))) problems.push('benchmarkRevision.commit must be a 40-character commit id or null');
  if (!(rev.source === null || rev.source === 'git' || rev.source === 'bundle')) problems.push('benchmarkRevision.source must be git, bundle or null');
  const pf = obj(o.preflight);
  const codex = parsePreflight(pf.codex, 'codex', problems);
  const claude = parsePreflight(pf.claude, 'claude', problems);
  const iso = obj(o.isolation);
  const k = obj(iso.kernel);
  if (!strOrNull(iso.sandboxTool)) problems.push('isolation.sandboxTool must be a string or null');
  if (!(iso.mechanism === null || iso.mechanism === 'bwrap' || iso.mechanism === 'sandbox-exec')) problems.push('isolation.mechanism must be bwrap, sandbox-exec or null');
  if ((iso.sandboxTool === null) !== (iso.mechanism === null)) problems.push('isolation.sandboxTool and isolation.mechanism must both be set or both be null');
  else if (typeof iso.sandboxTool === 'string' && sandboxMechanism(iso.sandboxTool) !== iso.mechanism) problems.push('isolation.sandboxTool must be a bwrap or sandbox-exec path matching isolation.mechanism');
  if (!strOrNull(iso.toolVersion)) problems.push('isolation.toolVersion must be a string or null');
  for (const key of ['maxUserNamespaces', 'apparmorRestrictUnprivilegedUserns', 'unprivilegedUsernsClone'] as const) if (!strOrNull(k[key])) problems.push(`isolation.kernel.${key} must be a string or null`);
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    evidence: {
      schema: HOST_EVIDENCE_SCHEMA,
      checkedAt: o.checkedAt as string,
      phase: o.phase as EvidencePhase,
      runner: o.runner as string | null,
      hostId: o.hostId as string | null,
      os: { type: os.type as string, platform: os.platform as string, release: os.release as string, arch: os.arch as string, distribution: os.distribution as string | null },
      node: o.node as string,
      benchmarkRevision: { commit: rev.commit as string | null, source: rev.source as 'git' | 'bundle' | null },
      preflight: { codex, claude },
      isolation: {
        sandboxTool: iso.sandboxTool as string | null,
        mechanism: iso.mechanism as 'bwrap' | 'sandbox-exec' | null,
        toolVersion: iso.toolVersion as string | null,
        kernel: { maxUserNamespaces: k.maxUserNamespaces as string | null, apparmorRestrictUnprivilegedUserns: k.apparmorRestrictUnprivilegedUserns as string | null, unprivilegedUsernsClone: k.unprivilegedUsernsClone as string | null },
      },
    },
  };
}

/** `PRETTY_NAME` from /etc/os-release text, or null. Never throws. */
export function osReleasePrettyName(text: string): string | null {
  for (const line of text.split('\n')) {
    const m = /^PRETTY_NAME=(.*)$/.exec(line.trim());
    if (!m) continue;
    const v = m[1]!.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim();
    return v === '' ? null : v;
  }
  return null;
}

/** The environment facts of one pilot attempt that must match the host evidence. */
export interface PilotHostFacts {
  conditionId: string;
  attempt: number;
  startedAt: string;
  endedAt: string | null;
  /** From the attempt record's `environment`; null when the record has none. */
  environment: { platform: string; release: string; arch: string; node: string; commit: string | null; hostId: string | null } | null;
}

/** Pure: pulls the comparable facts out of an attempt record's untyped `environment`. */
export function pilotEnvironment(env: unknown): PilotHostFacts['environment'] {
  const e = obj(env);
  const os = obj(e.os);
  const rev = obj(e.benchmarkRevision);
  if (typeof os.platform !== 'string' || typeof os.release !== 'string' || typeof os.arch !== 'string' || typeof e.node !== 'string') return null;
  return {
    platform: os.platform,
    release: os.release,
    arch: os.arch,
    node: e.node,
    commit: typeof rev.commit === 'string' && SHA1.test(rev.commit) ? rev.commit : null,
    hostId: typeof e.hostId === 'string' && SHA256.test(e.hostId) ? e.hostId : null,
  };
}

export interface HostEvidenceInputs {
  /** Every file found in the evidence directory, parsed as JSON (or the parse error). */
  files: readonly { path: string; content: unknown }[];
  now: Date;
  maxAgeDays: number;
  /** Pinned CLI versions from config/models.json. */
  pins: { codex: string; claude: string };
  pilots: readonly PilotHostFacts[];
}

export interface HostEvidenceResult {
  /** The evidence used: the newest valid file. Null when none is valid. */
  chosen: { path: string; evidence: HostEvidence } | null;
  unmet: Unmet[];
  /** Gate inputs. Taken from the chosen evidence only when no host-evidence condition is unmet. */
  preflight: { codex: PreflightStatus; claude: PreflightStatus };
  sandboxTool: string | null;
}

const unusable = (why: string): PreflightStatus => ({ ok: false, termination: why });

/**
 * Chooses the newest valid evidence and checks it against the pins, the pilots and the clock:
 *
 * - missing: no file, or no valid file.
 * - invalid: any malformed file (a corrupt record is not silently skipped), including a sandbox
 *   tool whose basename disagrees with the recorded mechanism.
 * - stale: older than `maxAgeDays`, or taken before the latest pilot attempt ended (the runner
 *   records evidence after each campaign run, so evidence predating a pilot does not cover it).
 * - inconsistent: from the future, tool versions differ from the pins, no revision, a Linux host
 *   with no host identity or with sandbox-exec, or a pilot ran on a different host (machine-id
 *   hash), OS, kernel, architecture or Node.js, at a revision with no evidence from the same host,
 *   or without recorded environment. A pilot or evidence file without a host identity never
 *   matches, so two instances built from the same image and revision are not interchangeable, and
 *   recorded evidence cannot cover a host without /etc/machine-id (use `--evidence local` there).
 */
export function evaluateHostEvidence(i: HostEvidenceInputs): HostEvidenceResult {
  const unmet: Unmet[] = [];
  const valid: { path: string; evidence: HostEvidence }[] = [];
  const invalid: string[] = [];
  for (const f of [...i.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const r = parseHostEvidence(f.content);
    if (r.ok) valid.push({ path: f.path, evidence: r.evidence });
    else invalid.push(`${f.path} (${r.problems[0]})`);
  }
  if (invalid.length > 0) unmet.push({ id: 'host-evidence:invalid', detail: `malformed host evidence: ${invalid.join('; ')}` });
  const chosen = valid.reduce<(typeof valid)[number] | null>((best, v) => (best === null || Date.parse(v.evidence.checkedAt) >= Date.parse(best.evidence.checkedAt) ? v : best), null);
  if (!chosen) {
    unmet.push({ id: 'host-evidence', detail: `no recorded host evidence in records/<cohort>-pilots/host-evidence; run the pilot campaign on the runner (it records the preflights and the isolation probe), or pass --evidence local on the pilot host itself` });
    return { chosen: null, unmet, preflight: { codex: unusable('no-host-evidence'), claude: unusable('no-host-evidence') }, sandboxTool: null };
  }
  const e = chosen.evidence;
  const at = Date.parse(e.checkedAt);
  const stale: string[] = [];
  const inconsistent: string[] = [];
  if (!(Number.isFinite(i.maxAgeDays) && i.maxAgeDays > 0)) stale.push('no valid maximum age configured');
  else if (i.now.getTime() - at > i.maxAgeDays * 86_400_000) stale.push(`${chosen.path} was checked at ${e.checkedAt}, more than ${i.maxAgeDays} days before ${i.now.toISOString()}`);
  if (at - i.now.getTime() > FUTURE_SKEW_MS) inconsistent.push(`${chosen.path} is dated in the future (${e.checkedAt})`);
  const latestEnd = i.pilots.reduce<number | null>((m, p) => {
    const t = p.endedAt === null ? Number.NaN : Date.parse(p.endedAt);
    return Number.isFinite(t) && (m === null || t > m) ? t : m;
  }, null);
  if (latestEnd !== null && at < latestEnd) stale.push(`${chosen.path} (${e.checkedAt}) predates the latest pilot attempt end (${new Date(latestEnd).toISOString()})`);
  if (e.preflight.codex.toolVersion !== i.pins.codex) inconsistent.push(`Codex CLI ${e.preflight.codex.toolVersion ?? 'unknown'} recorded, pinned ${i.pins.codex}`);
  if (e.preflight.claude.toolVersion !== i.pins.claude) inconsistent.push(`Claude Code ${e.preflight.claude.toolVersion ?? 'unknown'} recorded, pinned ${i.pins.claude}`);
  if (e.benchmarkRevision.commit === null) inconsistent.push(`${chosen.path} records no benchmark revision`);
  // A Linux runner always has /etc/machine-id; without its hash nothing ties the files to one host.
  if (e.os.platform === 'linux' && e.hostId === null) inconsistent.push(`${chosen.path} records no host identity (machine-id hash) for a Linux host`);
  if (e.os.platform === 'linux' && e.isolation.mechanism === 'sandbox-exec') inconsistent.push(`${chosen.path} records sandbox-exec on a Linux host`);
  // Revisions covered by evidence from the same host (same machine-id hash, OS and kernel). A missing
  // host identity never matches another file, so two unidentified hosts are not treated as one.
  const sameHost = valid.filter((v) => v === chosen || (e.hostId !== null && v.evidence.hostId === e.hostId && v.evidence.os.release === e.os.release && v.evidence.os.platform === e.os.platform));
  const revisions = new Set(sameHost.map((v) => v.evidence.benchmarkRevision.commit).filter((c): c is string => c !== null));
  const mismatched: string[] = [];
  for (const p of i.pilots) {
    const tag = `${p.conditionId}#${p.attempt}`;
    const env = p.environment;
    if (!env) {
      mismatched.push(`${tag} recorded no environment`);
      continue;
    }
    const diffs: string[] = [];
    if (env.hostId === null) diffs.push('no host identity');
    else if (e.hostId === null || env.hostId !== e.hostId) diffs.push(`host ${env.hostId.slice(0, 12)}`);
    if (env.platform !== e.os.platform) diffs.push(`platform ${env.platform}`);
    if (env.release !== e.os.release) diffs.push(`kernel ${env.release}`);
    if (env.arch !== e.os.arch) diffs.push(`arch ${env.arch}`);
    if (env.node !== e.node) diffs.push(`node ${env.node}`);
    if (env.commit === null) diffs.push('no revision');
    else if (!revisions.has(env.commit)) diffs.push(`revision ${env.commit.slice(0, 12)} has no host evidence`);
    if (diffs.length > 0) mismatched.push(`${tag}: ${diffs.join(', ')}`);
  }
  if (mismatched.length > 0) {
    const shown = mismatched.length <= 3 ? mismatched.join('; ') : `${mismatched.slice(0, 3).join('; ')}; +${mismatched.length - 3} more`;
    inconsistent.push(`pilots do not match the evidence host (${e.hostId === null ? 'no host identity' : `host ${e.hostId.slice(0, 12)}`}, ${e.os.platform} ${e.os.release} ${e.os.arch}, node ${e.node}): ${shown}`);
  }
  if (stale.length > 0) unmet.push({ id: 'host-evidence:stale', detail: stale.join('; ') });
  if (inconsistent.length > 0) unmet.push({ id: 'host-evidence:inconsistent', detail: inconsistent.join('; ') });
  if (unmet.length > 0) return { chosen, unmet, preflight: { codex: unusable('host-evidence-unusable'), claude: unusable('host-evidence-unusable') }, sandboxTool: null };
  return {
    chosen,
    unmet,
    preflight: { codex: { ok: e.preflight.codex.ok, termination: e.preflight.codex.termination }, claude: { ok: e.preflight.claude.ok, termination: e.preflight.claude.termination } },
    sandboxTool: e.isolation.sandboxTool,
  };
}

export interface HostFacts {
  checkedAt: Date;
  phase: EvidencePhase;
  runner: string | null;
  /** SHA-256 of /etc/machine-id (the raw id is never recorded), or null. */
  machineIdSha256: string | null;
  environment: { os: { type: string; platform: string; release: string; arch: string }; node: string; benchmarkRevision: { commit: string | null; source?: 'bundle' } };
  osRelease: string | null;
  codex: ToolPreflight;
  claude: ToolPreflight;
  sandboxTool: string | null;
  sandboxToolVersion: string | null;
  kernel: HostEvidence['isolation']['kernel'];
}

const trimOrNull = (s: string | null) => (s === null || s.trim() === '' ? null : s.trim());

/** Assembles one evidence record from gathered host facts. Pure; the result passes `parseHostEvidence`. */
export function buildHostEvidence(f: HostFacts): HostEvidence {
  const mechanism = sandboxMechanism(f.sandboxTool);
  const commit = f.environment.benchmarkRevision.commit;
  return {
    schema: HOST_EVIDENCE_SCHEMA,
    checkedAt: f.checkedAt.toISOString(),
    phase: f.phase,
    runner: trimOrNull(f.runner),
    hostId: f.machineIdSha256 !== null && SHA256.test(f.machineIdSha256) ? f.machineIdSha256 : null,
    os: { ...f.environment.os, distribution: f.osRelease === null ? null : osReleasePrettyName(f.osRelease) },
    node: f.environment.node,
    benchmarkRevision: { commit, source: commit === null ? null : f.environment.benchmarkRevision.source === 'bundle' ? 'bundle' : 'git' },
    preflight: { codex: f.codex, claude: f.claude },
    // A tool that is neither bwrap nor sandbox-exec is not an accepted mechanism: record no tool.
    isolation: { sandboxTool: mechanism === null ? null : f.sandboxTool, mechanism, toolVersion: trimOrNull(f.sandboxToolVersion), kernel: f.kernel },
  };
}
