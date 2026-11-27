/**
 * Fresh per-workflow workspaces (methodology section 12): a new Git repository holding the frozen
 * scaffold's files (no .git, build output, or runtime state from the fixture), its preinstalled
 * dependencies, and one initial commit made without any user or system Git configuration.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hashFiles, planCopy, scan, treeHash } from '../evaluator/workspace.ts';

export type GitRunner = (args: string[], cwd: string, env: Record<string, string>) => { status: number | null; stderr: string };

export const defaultGit: GitRunner = (args, cwd, env) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stderr: r.stderr ?? String(r.error ?? '') };
};

/** Pure: an environment for runner-made commits that ignores every user and system Git setting. */
export function gitEnv(path: string, home: string): Record<string, string> {
  return {
    PATH: path,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'harness-benchmark',
    GIT_AUTHOR_EMAIL: 'runner@harness-benchmark.invalid',
    GIT_COMMITTER_NAME: 'harness-benchmark',
    GIT_COMMITTER_EMAIL: 'runner@harness-benchmark.invalid',
    GIT_AUTHOR_DATE: '2026-11-14T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-11-14T00:00:00Z',
  };
}

export interface CreatedWorkspace {
  dir: string;
  scaffoldHash: string;
  files: number;
}

export function createWorkspace(scaffoldDir: string, dest: string, o: { path: string; gitHome: string; git?: GitRunner }): CreatedWorkspace {
  if (existsSync(dest) && readdirSync(dest).length > 0) throw new Error(`workspace ${dest} already exists and is not empty`);
  if (!existsSync(join(scaffoldDir, 'node_modules'))) throw new Error(`scaffold dependencies are not installed in ${scaffoldDir} (run npm run fixtures:install)`);
  const files = planCopy(scan(scaffoldDir)).files;
  mkdirSync(dest, { recursive: true });
  for (const f of files) {
    mkdirSync(dirname(join(dest, f)), { recursive: true });
    writeFileSync(join(dest, f), readFileSync(join(scaffoldDir, f)));
  }
  cpSync(join(scaffoldDir, 'node_modules'), join(dest, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  const git = o.git ?? defaultGit;
  mkdirSync(o.gitHome, { recursive: true });
  const env = gitEnv(o.path, o.gitHome);
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Starting scaffold']]) {
    const r = git(args, dest, env);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  }
  return { dir: dest, scaffoldHash: treeHash(hashFiles(scaffoldDir, files)), files: files.length };
}

/** Copies a workspace (with .git and dependencies) into a new directory. */
export function copyTree(from: string, to: string): void {
  if (existsSync(to)) throw new Error(`copy target ${to} already exists`);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

/** Hash of a workspace's own files, with the evaluator's snapshot rules. */
export function workspaceHash(dir: string): string {
  return treeHash(hashFiles(dir, planCopy(scan(dir)).files));
}
