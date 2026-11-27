/**
 * Runs the deterministic build-time checks for one workspace state (methodology section 5).
 *
 * The runner never executes the workspace's own fixed files. It copies the workspace into a fresh
 * check directory with the evaluator's snapshot rules, restores package.json, the lockfile,
 * tsconfig.json, TASK.md and checks/ from the protected scaffold, and installs the protected
 * dependencies. It then runs `npm run build`, `npm run check:smoke` and `npm run check:contract`
 * inside the OS sandbox under one 120-second ceiling. Edits to the workspace copy of checks/ cannot
 * change the feedback; they are recorded as fixed-file changes.
 */
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { BENCHMARK_ROOT } from '../fixtures.ts';
import { InfrastructureError } from '../evaluator/expect.ts';
import { hiddenRoots } from '../evaluator/evaluate.ts';
import { runSandboxedCommand, type CommandResult } from '../evaluator/processes.ts';
import { selectSandbox, usableSandboxTool, type IsolationMode, type Sandbox, type SandboxPaths } from '../evaluator/sandbox.ts';
import { discardDependencies, prepareWorkspace, type PreparedWorkspace } from '../evaluator/workspace.ts';
import { CHECK_RUN_SCHEMA, type CheckOutcome, type CheckRun, type SuiteId, type SuiteOutcome } from './types.ts';

export const DEFAULT_CHECK_CEILING_MS = 120_000;
const MAX_BUILD_MS = 60_000;
const REPORT_SCHEMA = 'job-tracker/check-report@1';

export interface CheckRunOptions {
  /** The implementer's workspace after a stage returned. Never modified. */
  workspaceDir: string;
  /** A fresh, empty directory for this check run, outside the workspace. */
  workDir: string;
  timeoutMs: number;
  isolation: IsolationMode;
  scaffoldDir?: string;
}

export interface CheckRunDeps {
  now(): number;
  wallClock(): Date;
  sandbox(mode: IsolationMode, paths: SandboxPaths): Sandbox;
  prepare(workspaceDir: string, scaffoldDir: string, workDir: string): PreparedWorkspace;
  run(o: { argv: string[]; label: string; appDir: string; workDir: string; sandbox: Sandbox; timeoutMs: number }): Promise<CommandResult>;
  readText(path: string): string | undefined;
  discard(appDir: string): void;
}

export function defaultCheckDeps(): CheckRunDeps {
  const path = process.env.PATH ?? '/usr/bin:/bin';
  return {
    now: () => performance.now(),
    wallClock: () => new Date(),
    sandbox: (mode, paths) => selectSandbox(mode, process.platform, (cmd) => usableSandboxTool(cmd), paths),
    prepare: prepareWorkspace,
    run: (o) => runSandboxedCommand({ ...o, path }),
    readText: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    },
    discard: discardDependencies,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Pure: a suite's JSON report, or undefined unless it is structurally valid for that suite. */
export function parseSuiteReport(text: string, suite: SuiteId): { passed: boolean; checks: CheckOutcome[]; stderr: SuiteOutcome['stderr'] } | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(v) || v.schema !== REPORT_SCHEMA || v.suite !== suite || !Array.isArray(v.checks) || v.checks.length === 0) return undefined;
  const checks: CheckOutcome[] = [];
  for (const c of v.checks) {
    if (!isObject(c) || typeof c.name !== 'string' || typeof c.passed !== 'boolean') return undefined;
    checks.push({ name: c.name, title: typeof c.title === 'string' ? c.title : '', passed: c.passed, detail: typeof c.detail === 'string' ? c.detail : '' });
  }
  const stderr = isObject(v.stderr) ? v.stderr : {};
  return { passed: checks.every((c) => c.passed), checks, stderr: { server: strings(stderr.server), worker: strings(stderr.worker) } };
}

const emptySuite = (suite: SuiteId, status: SuiteOutcome['status']): SuiteOutcome => ({ suite, status, checks: [], output: [], stderr: { server: [], worker: [] }, durationMs: 0 });

/** Pure: overall status from suite outcomes. */
export function overallStatus(suites: readonly SuiteOutcome[]): 'passed' | 'failed' {
  return suites.length > 0 && suites.every((s) => s.status === 'passed') ? 'passed' : 'failed';
}

export async function runDeterministicChecks(opts: CheckRunOptions, deps: CheckRunDeps = defaultCheckDeps()): Promise<CheckRun> {
  const t0 = deps.now();
  const startedAt = deps.wallClock().toISOString();
  const ceilingMs = Math.max(0, opts.timeoutMs);
  const deadline = t0 + ceilingMs;
  const scaffoldDir = opts.scaffoldDir ?? join(BENCHMARK_ROOT, 'fixtures', 'scaffold');
  const suites: SuiteOutcome[] = [];
  let ws: PreparedWorkspace | null = null;
  let reason: string | null = null;
  let infrastructure = false;

  try {
    const workspaceDir = resolve(opts.workspaceDir);
    const workDir = resolve(opts.workDir);
    if (workDir === workspaceDir || workDir.startsWith(workspaceDir + sep)) throw new InfrastructureError('check directory must not be inside the workspace');
    mkdirSync(workDir, { recursive: true });
    const realWork = realpathSync(workDir);
    const sandbox = deps.sandbox(opts.isolation, { hidden: hiddenRoots(), writable: [realWork], readable: [dirname(dirname(realpathSync(process.execPath)))] });
    ws = deps.prepare(workspaceDir, scaffoldDir, realWork);
    if (ws.status !== 'ready') {
      const detail = ws.status === 'missing-output' ? 'the workspace has no files to build' : 'the workspace is over the 5,000-file or 50 MiB snapshot limit';
      suites.push({ ...emptySuite('build', 'failed'), checks: [{ name: 'build.compile', title: 'npm run build compiles src/ to dist/', passed: false, detail }] }, emptySuite('smoke', 'not-run'), emptySuite('contract', 'not-run'));
    } else {
      const appDir = ws.appDir;
      const remaining = () => deadline - deps.now();
      const build = await deps.run({ argv: ['npm', 'run', 'build'], label: 'build', appDir, workDir: realWork, sandbox, timeoutMs: Math.max(1, Math.min(MAX_BUILD_MS, remaining())) });
      const buildDetail = build.timedOut ? 'npm run build did not finish within the check ceiling' : `npm run build exited with code ${build.exitCode}`;
      suites.push({
        suite: 'build',
        status: build.ok ? 'passed' : build.timedOut ? 'timed-out' : 'failed',
        checks: [{ name: 'build.compile', title: 'npm run build compiles src/ to dist/', passed: build.ok, detail: build.ok ? '' : buildDetail }],
        output: build.ok ? [] : build.output,
        stderr: { server: [], worker: [] },
        durationMs: build.durationMs,
      });
      for (const suite of ['smoke', 'contract'] as const) {
        if (!build.ok) {
          suites.push(emptySuite(suite, 'not-run'));
          continue;
        }
        if (remaining() <= 0) {
          suites.push(emptySuite(suite, 'timed-out'));
          continue;
        }
        const reportPath = join(realWork, 'reports', `${suite}.json`);
        mkdirSync(dirname(reportPath), { recursive: true });
        const res = await deps.run({ argv: ['npm', 'run', '--silent', `check:${suite}`, '--', '--report', reportPath], label: `check:${suite}`, appDir, workDir: realWork, sandbox, timeoutMs: Math.max(1, remaining()) });
        const text = res.timedOut ? undefined : deps.readText(reportPath);
        const report = text === undefined ? undefined : parseSuiteReport(text, suite);
        if (res.timedOut) suites.push({ ...emptySuite(suite, 'timed-out'), output: res.output, durationMs: res.durationMs });
        else if (!report || (res.exitCode !== 0 && res.exitCode !== 1) || report.passed !== (res.exitCode === 0)) {
          // The protected suite itself failed to run (for example, it could not bind a loopback port).
          throw new InfrastructureError(`check:${suite} produced no valid report (exit ${res.exitCode}): ${res.output.slice(-3).join(' | ')}`);
        } else suites.push({ suite, status: report.passed ? 'passed' : 'failed', checks: report.checks, output: [], stderr: report.stderr, durationMs: res.durationMs });
      }
    }
  } catch (e) {
    infrastructure = true;
    reason = e instanceof InfrastructureError ? e.message : `check runner defect: ${(e as Error).message ?? String(e)}`;
  } finally {
    if (ws?.status === 'ready') {
      try {
        deps.discard(ws.appDir);
      } catch {
        // best effort
      }
    }
  }

  return {
    schema: CHECK_RUN_SCHEMA,
    status: infrastructure ? 'infrastructure-failure' : overallStatus(suites),
    reason,
    startedAt,
    durationMs: Math.round(deps.now() - t0),
    ceilingMs,
    snapshotHash: ws?.snapshotHash ?? null,
    fixedFileChanges: ws?.fixedChanges ?? [],
    suites,
  };
}
