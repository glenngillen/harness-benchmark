import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BENCHMARK_ROOT } from '../../src/fixtures.ts';
import { copyTree, createWorkspace, gitEnv, workspaceHash, type GitRunner } from '../../src/orchestrator/workspace.ts';

const TMP_ROOT = process.env.HARNESS_TEST_TMP ?? join(BENCHMARK_ROOT, '.runs', 'unit-tmp');
mkdirSync(TMP_ROOT, { recursive: true });
const made: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(TMP_ROOT, 'orch-ws-'));
  made.push(d);
  return d;
};
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function write(root: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
}

describe('createWorkspace', () => {
  it('copies scaffold files and dependencies, skips build output and runtime state, and commits without user config', () => {
    const scaffold = tmp();
    write(scaffold, { 'TASK.md': 'brief', 'src/server.ts': 'x', 'dist/server.js': 'built', 'data/jobs.db': 'db', 'node_modules/typescript/package.json': '{}' });
    const dest = join(tmp(), 'workspace');
    const calls: { args: string[]; env: Record<string, string> }[] = [];
    const git: GitRunner = (args, _cwd, env) => {
      calls.push({ args, env });
      return { status: 0, stderr: '' };
    };
    const ws = createWorkspace(scaffold, dest, { path: '/usr/bin', gitHome: join(dest, '..', 'git-home'), git });
    expect(readFileSync(join(dest, 'src/server.ts'), 'utf8')).toBe('x');
    expect(existsSync(join(dest, 'node_modules/typescript/package.json'))).toBe(true);
    expect(existsSync(join(dest, 'dist'))).toBe(false);
    expect(existsSync(join(dest, 'data'))).toBe(false);
    expect(ws.files).toBe(2);
    expect(calls.map((c) => c.args[0] === '-c' ? c.args[2] : c.args[0])).toEqual(['init', 'add', 'commit']);
    expect(calls[0]!.env).toMatchObject({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PATH: '/usr/bin' });
    expect(ws.scaffoldHash).toBe(workspaceHash(scaffold));
  });

  it('refuses a non-empty destination, missing dependencies, and git failures', () => {
    const scaffold = tmp();
    write(scaffold, { 'TASK.md': 'brief' });
    const ok: GitRunner = () => ({ status: 0, stderr: '' });
    expect(() => createWorkspace(scaffold, join(tmp(), 'w'), { path: '', gitHome: tmp(), git: ok })).toThrow(/dependencies/);
    write(scaffold, { 'node_modules/x/index.js': '' });
    const busy = tmp();
    write(busy, { 'f': '1' });
    expect(() => createWorkspace(scaffold, busy, { path: '', gitHome: tmp(), git: ok })).toThrow(/not empty/);
    expect(() => createWorkspace(scaffold, join(tmp(), 'w'), { path: '', gitHome: tmp(), git: () => ({ status: 1, stderr: 'no git' }) })).toThrow(/no git/);
  });
});

describe('copyTree and workspaceHash', () => {
  it('copies into a new directory only, and the hash ignores .git and dependencies', () => {
    const a = tmp();
    write(a, { 'src/a.ts': '1', '.git/HEAD': 'ref', 'node_modules/m/i.js': 'x' });
    const b = join(tmp(), 'copy');
    copyTree(a, b);
    expect(workspaceHash(b)).toBe(workspaceHash(a));
    expect(() => copyTree(a, b)).toThrow(/already exists/);
    write(b, { '.git/HEAD': 'other', 'node_modules/m/i.js': 'y' });
    expect(workspaceHash(b)).toBe(workspaceHash(a));
    write(b, { 'src/a.ts': '2' });
    expect(workspaceHash(b)).not.toBe(workspaceHash(a));
  });

  it('gitEnv never inherits identity or configuration', () => {
    expect(Object.keys(gitEnv('/p', '/h')).sort()).toEqual(['GIT_AUTHOR_DATE', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_DATE', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'HOME', 'PATH']);
  });
});
