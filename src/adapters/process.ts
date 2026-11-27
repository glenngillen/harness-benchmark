/**
 * Supervised launch of one coding-CLI invocation. Shared by the Codex and Claude adapters.
 *
 * The child runs in its own process group, so termination reaches the CLI and every command it
 * spawned. stdout and stderr stream to files as they arrive (a killed stage keeps whatever it had
 * already emitted). The prompt is written to stdin, keeping it out of argv and process listings.
 * A deadline sends SIGTERM to the group, then SIGKILL after a grace period.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
export type KillFn = (pid: number, signal: NodeJS.Signals) => void;
export type ScheduleFn = (fn: () => void, ms: number) => () => void;

export interface ProcessDeps {
  spawn: SpawnFn;
  kill: KillFn;
  now: () => number;
  schedule: ScheduleFn;
  openWrite: (path: string) => WriteStream;
}

export const defaultProcessDeps: ProcessDeps = {
  spawn: nodeSpawn,
  kill: (pid, sig) => process.kill(pid, sig),
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
  openWrite: (p) => createWriteStream(p, { flags: 'w', mode: 0o600 }),
};

export interface ProcessRequest {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  stdoutPath: string;
  stderrPath: string;
  /** Absolute time on `deps.now()`'s clock. */
  deadlineAt: number;
  graceMs?: number;
}

export interface ProcessOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError: string | null;
  startedAt: number;
  endedAt: number;
  /** Signals sent to the process group, in order. */
  signalsSent: NodeJS.Signals[];
}

export const DEFAULT_GRACE_MS = 5_000;

export function runSupervised(req: ProcessRequest, deps: ProcessDeps = defaultProcessDeps): Promise<ProcessOutcome> {
  const startedAt = deps.now();
  const signalsSent: NodeJS.Signals[] = [];
  const out = deps.openWrite(req.stdoutPath);
  const err = deps.openWrite(req.stderrPath);
  const closeStreams = () => Promise.all([out, err].map((s) => new Promise<void>((r) => (s.closed ? r() : s.end(() => r())))));

  return new Promise<ProcessOutcome>((resolve) => {
    let child: ChildProcess;
    let timedOut = false;
    let settled = false;
    const cancels: Array<() => void> = [];
    const finish = (o: Omit<ProcessOutcome, 'startedAt' | 'endedAt' | 'signalsSent' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      for (const c of cancels) c();
      void closeStreams().then(() => resolve({ ...o, timedOut, startedAt, endedAt: deps.now(), signalsSent }));
    };

    try {
      child = deps.spawn(req.cmd, req.args, { cwd: req.cwd, env: req.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ exitCode: null, signal: null, spawnError: (e as Error).message });
      return;
    }

    const signalGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      signalsSent.push(sig);
      try {
        deps.kill(-child.pid, sig);
      } catch {
        // The group may already be gone.
      }
    };

    child.stdout?.pipe(out, { end: false });
    child.stderr?.pipe(err, { end: false });
    child.once('error', (e) => finish({ exitCode: null, signal: null, spawnError: e.message }));
    child.once('close', (code, signal) => finish({ exitCode: code, signal, spawnError: null }));

    const remaining = Math.max(0, req.deadlineAt - startedAt);
    cancels.push(
      deps.schedule(() => {
        timedOut = true;
        signalGroup('SIGTERM');
        cancels.push(deps.schedule(() => signalGroup('SIGKILL'), req.graceMs ?? DEFAULT_GRACE_MS));
      }, remaining),
    );

    if (child.stdin) {
      child.stdin.on('error', () => {
        // EPIPE when the CLI exits before reading its prompt; the exit status reports the failure.
      });
      child.stdin.end(req.stdin);
    }
  });
}
