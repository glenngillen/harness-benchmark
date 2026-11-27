/**
 * Test double for a spawned CLI: no real process is started. Scripts decide what the "CLI" writes
 * and when it exits; signals sent to its process group are recorded.
 */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { WriteStream } from 'node:fs';
import type { ProcessDeps } from '../../../src/adapters/process.ts';

export interface FakeChild {
  cmd: string;
  args: string[];
  opts: SpawnOptions;
  stdinText: string;
  stdout: PassThrough;
  stderr: PassThrough;
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
  emitError(e: Error): void;
}

export type Script = (child: FakeChild) => void | Promise<void>;

export interface FakeWorld {
  deps: ProcessDeps;
  spawned: FakeChild[];
  killed: Array<{ pid: number; signal: NodeJS.Signals }>;
  files: Map<string, string>;
  /** Advance the fake clock, firing due timers. */
  advance(ms: number): void;
  clock: { t: number };
}

export function fakeWorld(scripts: Script[], opts: { onSignal?: (child: FakeChild, sig: NodeJS.Signals) => void; spawnThrows?: Error } = {}): FakeWorld {
  const clock = { t: 1_000_000 };
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const spawned: FakeChild[] = [];
  const killed: FakeWorld['killed'] = [];
  const files = new Map<string, string>();
  const byPid = new Map<number, FakeChild>();
  let nextPid = 4000;

  const deps: ProcessDeps = {
    now: () => clock.t,
    schedule: (fn, ms) => {
      const t = { at: clock.t + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    kill: (pid, signal) => {
      killed.push({ pid, signal });
      const c = byPid.get(-pid);
      if (c && opts.onSignal) opts.onSignal(c, signal);
    },
    openWrite: (path) => {
      files.set(path, '');
      const w = new Writable({
        write(chunk, _enc, cb) {
          files.set(path, (files.get(path) ?? '') + chunk.toString());
          cb();
        },
      });
      return w as unknown as WriteStream;
    },
    spawn: (cmd, args, spawnOpts) => {
      if (opts.spawnThrows) throw opts.spawnThrows;
      const script = scripts[spawned.length];
      if (!script) throw new Error(`unexpected spawn #${spawned.length + 1}: ${cmd} ${args.join(' ')}`);
      const ee = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const pid = nextPid++;
      let stdinText = '';
      const stdin = new Writable({
        write(chunk, _e, cb) {
          stdinText += chunk.toString();
          fc.stdinText = stdinText;
          cb();
        },
      });
      Object.assign(ee, { pid, stdout, stderr, stdin });
      let exited = false;
      const fc: FakeChild = {
        cmd,
        args,
        opts: spawnOpts,
        stdinText,
        stdout,
        stderr,
        exit(code, signal = null) {
          if (exited) return;
          exited = true;
          stdout.end();
          stderr.end();
          setImmediate(() => ee.emit('close', code, signal));
        },
        emitError(e) {
          setImmediate(() => ee.emit('error', e));
        },
      };
      spawned.push(fc);
      byPid.set(pid, fc);
      // Let the runner attach listeners and write stdin first.
      setImmediate(() => void script(fc));
      return ee;
    },
  };

  return {
    deps,
    spawned,
    killed,
    files,
    clock,
    advance(ms) {
      const target = clock.t + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        clock.t = due.at;
        due.live = false;
        due.fn();
      }
      clock.t = target;
    },
  };
}

export const tick = () => new Promise<void>((r) => setImmediate(r));
