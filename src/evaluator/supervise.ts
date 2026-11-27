/**
 * Runs the evaluator as a separate OS process with a hard timeout, so neither a hung app nor an
 * evaluator defect can stall the campaign. The child writes its verdict to a file; if it exits
 * without a valid verdict, or must be killed, the outcome is an evaluator infrastructure failure
 * (operational), never a silent pass or rejection.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BENCHMARK_ROOT } from '../fixtures.ts';
import { DEFAULT_CEILING_MS, VERDICT_SCHEMA, type Verdict } from './evaluate.ts';
import type { SpawnFn, KillFn } from './processes.ts';
import type { IsolationMode } from './sandbox.ts';

/** Time allowed beyond the evaluation ceiling for setup, teardown and writing the verdict. */
export const SUPERVISOR_GRACE_MS = 45_000;

export interface SuperviseOptions {
  snapshotDir: string;
  workDir: string;
  verdictPath: string;
  isolation: IsolationMode;
  ceilingMs?: number;
}

export type Supervised =
  | { kind: 'verdict'; verdict: Verdict; exitCode: number | null }
  | { kind: 'infrastructure-failure'; reason: string; exitCode: number | null; timedOut: boolean };

/** Pure: the evaluator command line. The child gets PATH only, never the parent's NODE_OPTIONS or credentials. */
export function evaluatorCommand(o: SuperviseOptions, nodePath = process.execPath): { cmd: string; args: string[] } {
  return {
    cmd: nodePath,
    args: [
      '--disable-warning=ExperimentalWarning',
      '--experimental-strip-types',
      join(BENCHMARK_ROOT, 'src', 'cli', 'evaluate.ts'),
      '--snapshot', o.snapshotDir,
      '--work', o.workDir,
      '--out', o.verdictPath,
      '--isolation', o.isolation,
      '--ceiling-ms', String(o.ceilingMs ?? DEFAULT_CEILING_MS),
    ],
  };
}

/** Pure: accepts only a structurally valid verdict document. */
export function parseVerdict(text: string): Verdict | undefined {
  try {
    const v = JSON.parse(text) as Partial<Verdict>;
    const ok =
      v.schema === VERDICT_SCHEMA &&
      (v.status === 'passed' || v.status === 'failed' || v.status === 'infrastructure-failure') &&
      Array.isArray(v.cases) &&
      typeof v.behaviours === 'object' &&
      v.behaviours !== null;
    return ok ? (v as Verdict) : undefined;
  } catch {
    return undefined;
  }
}

export function superviseEvaluation(
  o: SuperviseOptions,
  io: { spawn?: SpawnFn; kill?: KillFn; read?: (p: string) => string; env?: NodeJS.ProcessEnv } = {},
): Promise<Supervised> {
  const spawn = io.spawn ?? nodeSpawn;
  const kill = io.kill ?? ((pid, sig) => process.kill(pid, sig));
  const read = io.read ?? ((p) => readFileSync(p, 'utf8'));
  const env = io.env ?? process.env;
  const { cmd, args } = evaluatorCommand(o);
  const limit = (o.ceilingMs ?? DEFAULT_CEILING_MS) + SUPERVISOR_GRACE_MS;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: BENCHMARK_ROOT,
      env: { PATH: env.PATH ?? '/usr/bin:/bin', ...(env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH } : {}), HOME: env.HOME ?? '' },
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }, limit);
    child.once('error', (e) => {
      clearTimeout(timer);
      resolve({ kind: 'infrastructure-failure', reason: `cannot start evaluator: ${e.message}`, exitCode: null, timedOut: false });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ kind: 'infrastructure-failure', reason: `evaluator exceeded ${limit} ms and was killed`, exitCode: code, timedOut: true });
        return;
      }
      let text = '';
      try {
        text = read(o.verdictPath);
      } catch {
        // handled below
      }
      const verdict = parseVerdict(text);
      resolve(
        verdict
          ? { kind: 'verdict', verdict, exitCode: code }
          : { kind: 'infrastructure-failure', reason: `evaluator exited with ${code} without a valid verdict`, exitCode: code, timedOut: false },
      );
    });
  });
}
