/**
 * Spawns the app under evaluation with the documented commands, inside the sandbox, each in its own
 * process group so signals reach npm, the shell, and node alike. The environment is built from
 * scratch: nothing from the evaluator's environment (credentials, NODE_OPTIONS, HOME) leaks in.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { InfrastructureError } from './expect.ts';
import type { Sandbox } from './sandbox.ts';
import type { AppControl, AppProcess, StopSignal } from './types.ts';

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
export type KillFn = (pid: number, signal: NodeJS.Signals) => void;

/** Pure: the complete environment for app processes. */
export function appEnv(o: { path: string; workDir: string; port?: number; databasePath?: string }): Record<string, string> {
  const env: Record<string, string> = {
    PATH: o.path,
    HOME: join(o.workDir, 'home'),
    TMPDIR: join(o.workDir, 'tmp'),
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_cache: join(o.workDir, 'home', '.npm'),
  };
  if (o.port !== undefined) env.PORT = String(o.port);
  if (o.databasePath !== undefined) env.DATABASE_PATH = o.databasePath;
  return env;
}

/** Pure: the last `n` lines of a log, with likely secrets redacted. */
export function tail(text: string, n = 40): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-n).map((l) => l.replace(/((?:token|secret|password|api[_-]?key|authorization)\S*\s*[=:]\s*)\S+/gi, '$1[redacted]').slice(0, 500));
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', (e) => reject(new InfrastructureError(`cannot allocate a loopback port: ${e.message}`)));
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new InfrastructureError('cannot allocate a loopback port'))));
    });
  });
}

interface Running {
  child: ChildProcess;
  exited: Promise<void>;
  hasExited: boolean;
}

export interface AppProcessOptions {
  appDir: string;
  workDir: string;
  sandbox: Sandbox;
  path: string;
  spawn?: SpawnFn;
  kill?: KillFn;
  getPort?: () => Promise<number>;
}

export class AppProcesses implements AppControl {
  private running: Partial<Record<AppProcess, Running>> = {};
  private all: Running[] = [];
  private port = 0;
  private readonly spawn: SpawnFn;
  private readonly kill: KillFn;
  private readonly getPort: () => Promise<number>;
  readonly databasePath: string;
  readonly outputDir: string;
  // Not a parameter property: the evaluator CLI runs under Node's strip-only TypeScript mode.
  private readonly o: AppProcessOptions;

  constructor(o: AppProcessOptions) {
    this.o = o;
    this.spawn = o.spawn ?? nodeSpawn;
    this.kill = o.kill ?? ((pid, sig) => process.kill(pid, sig));
    this.getPort = o.getPort ?? freePort;
    this.databasePath = join(o.workDir, 'app', 'state', 'jobs.db');
    this.outputDir = join(o.workDir, 'app-output');
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.port = await this.getPort();
    for (const d of [this.outputDir, join(this.o.workDir, 'home'), join(this.o.workDir, 'tmp')]) mkdirSync(d, { recursive: true });
    const env = appEnv({ path: this.o.path, workDir: this.o.workDir, port: this.port, databasePath: this.databasePath });
    for (const proc of ['server', 'worker'] as const) this.running[proc] = this.launch(proc, ['npm', 'run', `start:${proc}`], env);
  }

  private launch(proc: AppProcess, argv: string[], env: Record<string, string>): Running {
    const out = openSync(join(this.outputDir, `${proc}.txt`), 'a');
    const [cmd, ...args] = this.o.sandbox.wrap(argv);
    let child: ChildProcess;
    try {
      child = this.spawn(cmd!, args, { cwd: this.o.appDir, env, detached: true, stdio: ['ignore', out, out] });
    } catch (e) {
      throw new InfrastructureError(`cannot spawn ${proc}: ${(e as Error).message}`);
    } finally {
      closeSync(out);
    }
    const r: Running = { child, hasExited: false, exited: Promise.resolve() };
    r.exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        r.hasExited = true;
        resolve();
      });
      child.once('error', () => {
        r.hasExited = true;
        resolve();
      });
    });
    this.all.push(r);
    return r;
  }

  async signal(proc: AppProcess, signal: StopSignal): Promise<void> {
    const r = this.running[proc];
    if (!r || r.hasExited || r.child.pid === undefined) return;
    try {
      this.kill(-r.child.pid, signal);
    } catch {
      // ESRCH: the group is already gone.
    }
  }

  async waitForExit(proc: AppProcess, timeoutMs: number): Promise<boolean> {
    const r = this.running[proc];
    if (!r || r.hasExited) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)));
    const result = await Promise.race([r.exited.then(() => true), timedOut]);
    clearTimeout(timer);
    return result;
  }

  /** SIGKILLs every process group ever started, including stragglers from earlier starts. */
  async killAll(): Promise<void> {
    for (const r of this.all) {
      if (r.child.pid === undefined) continue;
      try {
        this.kill(-r.child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    await Promise.race([Promise.all(this.all.map((r) => r.exited)), new Promise((r) => setTimeout(r, 2_000))]);
  }

  output(proc: AppProcess): string[] {
    try {
      return tail(readFileSync(join(this.outputDir, `${proc}.txt`), 'utf8'));
    } catch {
      return [];
    }
  }
}

export interface BuildResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string[];
}

export type CommandResult = BuildResult;

export interface SandboxedCommandOptions {
  appDir: string;
  workDir: string;
  sandbox: Sandbox;
  path: string;
  timeoutMs: number;
  spawn?: SpawnFn;
  kill?: KillFn;
}

/** Runs `npm run build` in the sandbox with a timeout; build failure is the app's. */
export function runBuild(o: SandboxedCommandOptions): Promise<BuildResult> {
  return runSandboxedCommand({ ...o, argv: ['npm', 'run', 'build'], label: 'build' });
}

/**
 * Runs one command in the sandbox, in its own process group, with a from-scratch environment and
 * a timeout that SIGKILLs the whole group. Output is the secret-redacted tail of stdout+stderr.
 */
export function runSandboxedCommand(o: SandboxedCommandOptions & { argv: string[]; label: string }): Promise<CommandResult> {
  const spawn = o.spawn ?? nodeSpawn;
  const kill = o.kill ?? ((pid, sig) => process.kill(pid, sig));
  for (const d of [join(o.workDir, 'home'), join(o.workDir, 'tmp')]) mkdirSync(d, { recursive: true });
  const [cmd, ...args] = o.sandbox.wrap(o.argv);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd!, args, { cwd: o.appDir, env: appEnv({ path: o.path, workDir: o.workDir }), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new InfrastructureError(`cannot spawn ${o.label}: ${(e as Error).message}`));
      return;
    }
    let text = '';
    child.stdout?.on('data', (c: Buffer) => (text += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (text += c.toString('utf8')));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) kill(-child.pid, 'SIGKILL');
      } catch {
        // gone
      }
    }, o.timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(new InfrastructureError(`cannot run ${o.label}: ${e.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, exitCode: code, timedOut, durationMs: Date.now() - started, output: tail(text) });
    });
  });
}
