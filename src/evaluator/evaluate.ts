/**
 * Independent evaluation of one frozen snapshot (methodology section 9).
 *
 * 1. Hash the evaluator's own sources (tamper evidence).
 * 2. Copy the snapshot into a fresh workspace, restoring protected fixed files and dependencies.
 * 3. Build and run the app inside the OS sandbox, then run every acceptance case within the ceiling.
 * 4. Produce a verdict: passed, failed (app-caused, including missing output), or
 *    infrastructure-failure (operational: the evaluator could not operate).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { BENCHMARK_ROOT } from '../fixtures.ts';
import { CASES, evaluationData, type EvalCase } from './cases.ts';
import { InfrastructureError } from './expect.ts';
import { createPlaywrightBrowser } from './browser.ts';
import { createHttpClient } from './http.ts';
import { AppProcesses, runBuild, type BuildResult } from './processes.ts';
import { createCaseContext, runCases, type CaseRun } from './run.ts';
import { selectSandbox, usableSandboxTool, type IsolationMode, type Sandbox, type SandboxPaths } from './sandbox.ts';
import { summarise, type Preflight, type Summary } from './verdict.ts';
import { discardDependencies, hashFiles, planCopy, prepareWorkspace, scan, treeHash, type PreparedWorkspace } from './workspace.ts';
import type { AppControl, AppProcess, Clock, HttpClient, UiBrowser } from './types.ts';

export const VERDICT_SCHEMA = 'harness-benchmark/evaluation-verdict@1';
export const DEFAULT_CEILING_MS = 120_000;
const MAX_BUILD_MS = 60_000;

export interface Verdict extends Omit<Summary, 'cases'> {
  schema: typeof VERDICT_SCHEMA;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  ceilingMs: number;
  nonce: string;
  evaluator: { sourceHash: string; node: string; platform: string };
  snapshot: {
    path: string;
    hash: string | null;
    files: number;
    bytes: number;
    ignored: PreparedWorkspace['ignored'];
    fixedFileChanges: PreparedWorkspace['fixedChanges'];
  };
  isolation: ReturnType<Sandbox['describe']> | null;
  build: BuildResult | null;
  cases: Summary['cases'];
  appOutput: Record<AppProcess, string[]>;
}

export interface EvaluateOptions {
  snapshotDir: string;
  /** A fresh, empty directory for this evaluation; must not be inside the snapshot. */
  workDir: string;
  isolation: IsolationMode;
  ceilingMs?: number;
  scaffoldDir?: string;
  nonce?: string;
}

interface RuntimeApp extends AppControl {
  killAll(): Promise<void>;
  output(proc: AppProcess): string[];
}

/** Everything with side effects, replaceable in unit tests. */
export interface EvaluateDeps {
  clock: Clock;
  wallClock: () => Date;
  sourceHash: () => string;
  sandbox: (mode: IsolationMode, paths: SandboxPaths) => Sandbox;
  prepare: (snapshotDir: string, scaffoldDir: string, workDir: string) => PreparedWorkspace;
  build: (o: { appDir: string; workDir: string; sandbox: Sandbox; timeoutMs: number }) => Promise<BuildResult>;
  app: (o: { appDir: string; workDir: string; sandbox: Sandbox }) => RuntimeApp;
  http: (baseUrl: () => string) => HttpClient;
  browser: () => UiBrowser;
  discard: (appDir: string) => void;
  cases: readonly EvalCase[];
}

const realClock: Clock = { now: () => performance.now(), sleep: async (ms) => void (await sleep(ms)) };

/** Hash of the evaluator's sources and the protected scaffold, so tampering during evaluation is detectable. */
export function evaluatorSourceHash(root = BENCHMARK_ROOT): string {
  const files = [
    ...planCopy(scan(join(root, 'src', 'evaluator'))).files.map((f) => `src/evaluator/${f}`),
    'src/cli/evaluate.ts',
    ...planCopy(scan(join(root, 'fixtures', 'scaffold'))).files.map((f) => `fixtures/scaffold/${f}`),
  ];
  return treeHash(hashFiles(root, files));
}

const hasGit = (dir: string): boolean => existsSync(join(dir, '.git'));

/**
 * Directories the app must not see: the repository holding the benchmark (the nearest directory at
 * or above it with a `.git`, or the benchmark itself when none has one), the main checkout when
 * that repository is a `.worktrees/` worktree, and the home directory. The benchmark may sit at
 * `examples/harness-benchmark` in the site repository or be a standalone clone, so the repository
 * root is found, never assumed. Hiding the filesystem root would hide node and npm, so it is refused.
 */
export function hiddenRoots(benchmarkRoot = BENCHMARK_ROOT, home = homedir(), isRepoRoot: (dir: string) => boolean = hasGit): string[] {
  const bench = resolve(benchmarkRoot);
  let repo = bench;
  for (let dir = bench; ; dir = dirname(dir)) {
    if (isRepoRoot(dir)) {
      repo = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  const roots = [repo];
  const marker = `${sep}.worktrees${sep}`;
  if (repo.includes(marker)) roots.push(repo.slice(0, repo.indexOf(marker)));
  roots.push(home);
  const resolved = [...new Set(roots.map((r) => safeRealpath(resolve(r))))];
  if (resolved.some((r) => dirname(r) === r)) {
    throw new InfrastructureError('refusing to hide the filesystem root from the app; check the benchmark location and HOME');
  }
  return resolved;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Records may be committed, so absolute host paths are reduced to benchmark-relative or placeholder form. */
export function publicPath(p: string, benchmarkRoot = BENCHMARK_ROOT, home = homedir()): string {
  const worktree = resolve(benchmarkRoot, '..', '..');
  if (p === worktree || p.startsWith(worktree + sep)) return relative(benchmarkRoot, p).split(sep).join('/') || '.';
  if (p === home || p.startsWith(home + sep)) return `~${p.slice(home.length).split(sep).join('/')}`;
  return '<outside worktree>';
}

/** Replaces absolute host paths in captured output with placeholders (longest first). */
export function scrubPaths(lines: readonly string[], replacements: Record<string, string>): string[] {
  const pairs = Object.entries(replacements)
    .filter(([from]) => from.length > 1)
    .sort((a, b) => b[0].length - a[0].length);
  return lines.map((l) => pairs.reduce((acc, [from, to]) => acc.split(from).join(to), l));
}

export function defaultDeps(): EvaluateDeps {
  const path = process.env.PATH ?? '/usr/bin:/bin';
  return {
    clock: realClock,
    wallClock: () => new Date(),
    sourceHash: () => evaluatorSourceHash(),
    sandbox: (mode, paths) => selectSandbox(mode, process.platform, (cmd) => usableSandboxTool(cmd), paths),
    prepare: prepareWorkspace,
    build: (o) => runBuild({ ...o, path }),
    app: (o) => new AppProcesses({ ...o, path }),
    http: (baseUrl) => createHttpClient(baseUrl),
    browser: createPlaywrightBrowser,
    discard: discardDependencies,
    cases: CASES,
  };
}

export async function evaluateSnapshot(opts: EvaluateOptions, deps: EvaluateDeps = defaultDeps()): Promise<Verdict> {
  const ceilingMs = opts.ceilingMs ?? DEFAULT_CEILING_MS;
  const nonce = opts.nonce ?? randomBytes(4).toString('hex');
  const startedAt = deps.wallClock();
  const t0 = deps.clock.now();
  const deadlineAt = t0 + ceilingMs;
  const scaffoldDir = opts.scaffoldDir ?? join(BENCHMARK_ROOT, 'fixtures', 'scaffold');
  const hashBefore = deps.sourceHash();

  let infrastructure: string | null = null;
  let preflight: Preflight = 'ready';
  let ws: PreparedWorkspace | null = null;
  let sandbox: Sandbox | null = null;
  let build: BuildResult | null = null;
  let run: CaseRun = { results: [], infrastructure: null, ceilingReached: false };
  let app: RuntimeApp | null = null;
  let browser: UiBrowser | null = null;
  const scrub: Record<string, string> = { [homedir()]: '~', [resolve(BENCHMARK_ROOT, '..', '..')]: '<worktree>' };

  try {
    const snapshotDir = resolve(opts.snapshotDir);
    const workDir = resolve(opts.workDir);
    if (workDir === snapshotDir || workDir.startsWith(snapshotDir + sep)) throw new InfrastructureError('work directory must not be inside the snapshot');
    mkdirSync(workDir, { recursive: true });
    const realWork = realpathSync(workDir);
    scrub[realWork] = '<workspace>';
    scrub[workDir] = '<workspace>';
    sandbox = deps.sandbox(opts.isolation, {
      hidden: hiddenRoots(),
      writable: [realWork],
      readable: [dirname(dirname(safeRealpath(process.execPath)))],
    });
    ws = deps.prepare(snapshotDir, scaffoldDir, realWork);
    if (ws.status !== 'ready') preflight = ws.status;
    else {
      build = await deps.build({ appDir: ws.appDir, workDir: realWork, sandbox, timeoutMs: Math.max(1, Math.min(MAX_BUILD_MS, deadlineAt - deps.clock.now())) });
      if (!build.ok) preflight = 'build-failed';
    }
    if (preflight === 'ready' && ws) {
      const a = deps.app({ appDir: ws.appDir, workDir: realWork, sandbox });
      app = a;
      browser = deps.browser();
      const ctx = createCaseContext({ http: deps.http(() => a.baseUrl()), app: a, clock: deps.clock, browser, data: evaluationData(nonce), deadlineAt });
      run = await runCases(deps.cases, ctx);
      infrastructure = run.infrastructure;
    }
  } catch (e) {
    infrastructure = e instanceof InfrastructureError ? e.message : `evaluator defect: ${(e as Error).message ?? String(e)}`;
  } finally {
    await browser?.close().catch(() => undefined);
    await app?.killAll().catch(() => undefined);
    if (ws?.status === 'ready') {
      try {
        deps.discard(ws.appDir);
      } catch {
        // disk cleanup is best effort
      }
    }
  }

  const hashAfter = deps.sourceHash();
  if (infrastructure === null && hashAfter !== hashBefore) infrastructure = 'evaluator sources changed during evaluation';

  const summary = summarise({ catalogue: deps.cases, preflight, results: run.results, infrastructure, ceilingReached: run.ceilingReached });
  const finishedAt = deps.wallClock();
  return {
    schema: VERDICT_SCHEMA,
    ...summary,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.round(deps.clock.now() - t0),
    ceilingMs,
    nonce,
    evaluator: { sourceHash: hashBefore, node: process.version, platform: process.platform },
    snapshot: {
      path: publicPath(resolve(opts.snapshotDir)),
      hash: ws?.snapshotHash ?? null,
      files: ws?.snapshotFiles ?? 0,
      bytes: ws?.snapshotBytes ?? 0,
      ignored: ws?.ignored ?? [],
      fixedFileChanges: ws?.fixedChanges ?? [],
    },
    isolation: sandbox
      ? (() => {
          const d = sandbox.describe();
          return { ...d, hidden: d.hidden.map((p) => publicPath(p)), writable: d.writable.map((p) => publicPath(p)) };
        })()
      : null,
    build: build && { ...build, output: scrubPaths(build.output, scrub) },
    appOutput: { server: scrubPaths(app?.output('server') ?? [], scrub), worker: scrubPaths(app?.output('worker') ?? [], scrub) },
  };
}
