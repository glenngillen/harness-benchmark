/**
 * OS-level confinement of every coding-CLI stage (methodology section 12). Prompt instructions are
 * not protection, so the orchestrator launches each CLI inside a sandbox that:
 *
 * - hides this worktree (evaluator, references, records, other workflows, the auth homes), the main
 *   checkout that holds it, and the host home directory;
 * - re-exposes, read-only, only what the CLI needs to run: the pinned CLI packages and the Node.js
 *   toolchain;
 * - allows writes only to the stage's tool home, plus the workspace for implementing stages. A
 *   planner or reviewer gets its workspace copy read-only;
 * - leaves outbound network open, because the CLI must reach its provider. Codex additionally
 *   disables network for model commands where its native sandbox applies; the effective policy is
 *   recorded per stage.
 */
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Permission, StageIsolation } from '../adapters/types.ts';
import { bwrapArgs, sbplString, type IsolationMode, type SandboxPaths } from '../evaluator/sandbox.ts';
import { InfrastructureError } from '../evaluator/expect.ts';

export interface StageSandboxInput {
  permission: Permission;
  workspaceDir: string;
  toolHome: string;
  /** Roots the stage must not read: worktree, main checkout, home (see evaluator hiddenRoots). */
  hidden: string[];
  /** Read-only exceptions inside hidden roots: CLI packages, Node toolchain. */
  readable: string[];
  /** Extra writable system locations the CLI needs (for example the per-user temp root). */
  extraWritable?: string[];
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Pure: the sandbox paths for one stage. */
export function stageSandboxPaths(i: StageSandboxInput): SandboxPaths {
  const writable = [i.toolHome, ...(i.permission === 'workspace-write' ? [i.workspaceDir] : []), ...(i.extraWritable ?? [])];
  const readable = [...i.readable, ...(i.permission === 'read-only' ? [i.workspaceDir] : [])];
  return { hidden: i.hidden, writable, readable };
}

const subpaths = (ps: string[]) => ps.map((p) => `(subpath ${sbplString(p)})`).join(' ');

/**
 * Pure: SBPL for a model stage. Unlike the evaluator profile it keeps outbound network (the CLI
 * talks to its provider). Later rules take precedence, so the allow lists re-open paths inside the
 * hidden roots.
 */
export function stageSandboxProfile({ hidden, writable, readable }: SandboxPaths): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (subpath "/dev") ${subpaths(writable)})`,
    `(deny file-read* ${subpaths(hidden)})`,
    `(allow file-read* ${subpaths([...writable, ...readable])})`,
  ].join('\n');
}

export function buildStageIsolation(
  mode: IsolationMode,
  platform: NodeJS.Platform,
  tools: { sandboxExec?: string; bwrap?: string },
  paths: SandboxPaths,
  publicPath: (p: string) => string,
): StageIsolation {
  const describe = (mechanism: StageIsolation['mechanism'], network: string) => () => ({
    mechanism,
    hidden: paths.hidden.map(publicPath),
    writable: paths.writable.map(publicPath),
    readable: paths.readable.map(publicPath),
    network,
  });
  if (mode !== 'off') {
    if (platform === 'darwin' && tools.sandboxExec) {
      const profile = stageSandboxProfile(paths);
      const exe = tools.sandboxExec;
      return { mechanism: 'sandbox-exec', wrap: (argv) => [exe, '-p', profile, ...argv], describe: describe('sandbox-exec', 'outbound open (provider API); Codex native sandbox replaced by the outer sandbox') };
    }
    if (platform === 'linux' && tools.bwrap) {
      const args = bwrapArgs(paths);
      const exe = tools.bwrap;
      return { mechanism: 'bwrap', wrap: (argv) => [exe, ...args, '--', ...argv], describe: describe('bwrap', 'shared host network namespace (provider API)') };
    }
    if (mode === 'required') throw new InfrastructureError(`no supported stage sandbox on ${platform} (need sandbox-exec or bwrap)`);
  }
  return { mechanism: 'none', wrap: (argv) => argv, describe: describe('none', 'not isolated') };
}

/** Read-only exceptions every stage needs: the benchmark's pinned CLI packages and the Node.js install. */
export function stageReadable(benchmarkRoot: string, nodeExecPath = process.execPath): string[] {
  return [real(join(benchmarkRoot, 'node_modules')), real(dirname(dirname(real(nodeExecPath))))];
}
