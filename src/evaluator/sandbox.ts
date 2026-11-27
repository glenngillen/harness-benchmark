/**
 * OS-level isolation for the app processes the evaluator builds and runs. The snapshot is model
 * code, so it must not be able to read the evaluator, the references, other workflows, or the
 * host home directory, nor write outside its own evaluation workspace.
 *
 * - macOS: sandbox-exec with a generated SBPL profile (later rules take precedence).
 * - Linux: bubblewrap, with the host mounted read-only and hidden roots replaced by empty tmpfs.
 *   Loopback must stay reachable from the evaluator, so the network namespace is shared.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { InfrastructureError } from './expect.ts';

export type IsolationMode = 'required' | 'auto' | 'off';
export type Mechanism = 'sandbox-exec' | 'bwrap' | 'none';

export interface SandboxPaths {
  /** Roots the app must not read (or write). */
  hidden: string[];
  /** The evaluation workspace: readable and writable even when inside a hidden root. */
  writable: string[];
  /** Read-only exceptions inside hidden roots, for example the Node.js toolchain. */
  readable: string[];
}

export interface Sandbox {
  mechanism: Mechanism;
  wrap(argv: string[]): string[];
  /** Recorded in the verdict as isolation evidence. */
  describe(): { mechanism: Mechanism; hidden: string[]; writable: string[]; network: string };
}

export function sbplString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const subpaths = (ps: string[]) => ps.map((p) => `(subpath ${sbplString(p)})`).join(' ');

export function sandboxExecProfile({ hidden, writable, readable }: SandboxPaths): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound)',
    '(allow network-outbound (remote ip "localhost:*"))',
    '(deny file-write*)',
    `(allow file-write* (subpath "/dev") ${subpaths(writable)})`,
    `(deny file-read* ${subpaths(hidden)})`,
    `(allow file-read* ${subpaths([...writable, ...readable])})`,
  ].join('\n');
}

export function bwrapArgs({ hidden, writable, readable }: SandboxPaths): string[] {
  return [
    '--die-with-parent',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    ...hidden.flatMap((h) => ['--tmpfs', h]),
    ...readable.flatMap((r) => ['--ro-bind', r, r]),
    ...writable.flatMap((w) => ['--bind', w, w]),
  ];
}

export function selectSandbox(
  mode: IsolationMode,
  platform: NodeJS.Platform,
  which: (cmd: string) => string | undefined,
  paths: SandboxPaths,
): Sandbox {
  const make = (mechanism: Mechanism, wrap: (argv: string[]) => string[], network: string): Sandbox => ({
    mechanism,
    wrap,
    describe: () => ({ mechanism, hidden: paths.hidden, writable: paths.writable, network }),
  });
  if (mode !== 'off') {
    const sandboxExec = platform === 'darwin' ? which('sandbox-exec') : undefined;
    if (sandboxExec) {
      const profile = sandboxExecProfile(paths);
      return make('sandbox-exec', (argv) => [sandboxExec, '-p', profile, ...argv], 'outbound limited to loopback');
    }
    const bwrap = platform === 'linux' ? which('bwrap') : undefined;
    if (bwrap) {
      const args = bwrapArgs(paths);
      return make('bwrap', (argv) => [bwrap, ...args, '--', ...argv], 'shared host network namespace (loopback required by the evaluator)');
    }
    if (mode === 'required') throw new InfrastructureError(`no supported sandbox available on ${platform} (need sandbox-exec or bwrap)`);
  }
  return make('none', (argv) => argv, 'not isolated');
}

const PROBES: Record<string, string[]> = {
  'sandbox-exec': ['-p', '(version 1)(allow default)', '/usr/bin/true'],
  bwrap: ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true'],
};

/**
 * Finds a sandbox tool on PATH and returns it only if it can actually apply a sandbox here (for
 * example, sandbox-exec cannot nest inside another macOS sandbox, and bwrap needs user namespaces).
 */
export function usableSandboxTool(
  cmd: string,
  env: { PATH?: string } = process.env,
  exists: (p: string) => boolean = existsSync,
  run: (cmd: string, args: string[]) => number | null = (c, a) => spawnSync(c, a, { stdio: 'ignore', timeout: 10_000 }).status,
): string | undefined {
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), '/usr/bin', '/usr/sbin'];
  const found = dirs.map((d) => join(d, cmd)).find(exists);
  if (!found || !PROBES[cmd]) return undefined;
  return run(found, PROBES[cmd]!) === 0 ? found : undefined;
}
