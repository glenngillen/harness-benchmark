import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BENCHMARK_ROOT } from '../../src/fixtures.ts';
import { diffFixed, planCopy, prepareWorkspace, treeHash, type SnapshotEntry } from '../../src/evaluator/workspace.ts';

// Test-owned temporary directories live under the package's ignored .runs/ tree, never in the snapshot or fixtures.
const TMP_ROOT = process.env.HARNESS_TEST_TMP ?? join(BENCHMARK_ROOT, '.runs', 'unit-tmp');
mkdirSync(TMP_ROOT, { recursive: true });
const made: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(TMP_ROOT, 'ws-'));
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

function scaffold() {
  const root = tmp();
  write(root, {
    'package.json': '{"name":"job-tracker"}',
    'package-lock.json': '{}',
    'tsconfig.json': '{}',
    '.gitignore': 'dist/\n',
    'TASK.md': '# brief',
    'checks/smoke.ts': 'smoke',
    'src/server.ts': 'scaffold server',
    'node_modules/typescript/package.json': '{"name":"typescript"}',
  });
  return root;
}

describe('planCopy', () => {
  it('skips VCS, dependency, build and data directories and ignores links and special files', () => {
    const entries: SnapshotEntry[] = [
      { path: 'src', kind: 'dir', size: 0 },
      { path: 'src/a.ts', kind: 'file', size: 3 },
      { path: 'dist/a.js', kind: 'file', size: 9 },
      { path: 'data/jobs.db', kind: 'file', size: 9 },
      { path: 'src/node_modules/x.js', kind: 'file', size: 9 },
      { path: 'src/evil.ts', kind: 'symlink', size: 0 },
      { path: 'src/fifo', kind: 'other', size: 0 },
      { path: 'ui/data/x.json', kind: 'file', size: 2 },
    ];
    expect(planCopy(entries)).toEqual({
      files: ['src/a.ts', 'ui/data/x.json'],
      ignored: [
        { path: 'src/evil.ts', reason: 'symbolic link not followed' },
        { path: 'src/fifo', reason: 'not a regular file' },
      ],
      bytes: 5,
    });
  });

  describe('properties', () => {
    it('copies only regular files, counts their bytes, and never copies a skipped directory', () => {
      const entry = fc.record({
        path: fc.array(fc.constantFrom('src', 'ui', 'dist', 'data', '.git', 'node_modules', 'a.ts', 'b'), { minLength: 1, maxLength: 4 }).map((p) => p.join('/')),
        kind: fc.constantFrom('file', 'dir', 'symlink', 'other') as fc.Arbitrary<SnapshotEntry['kind']>,
        size: fc.nat(1000),
      });
      fc.assert(
        fc.property(fc.array(entry), (entries) => {
          const plan = planCopy(entries);
          const byPath = new Map(entries.map((e) => [e.path, e]));
          for (const f of plan.files) {
            expect(entries.some((e) => e.path === f && e.kind === 'file')).toBe(true);
            const parts = f.split('/');
            expect(['dist', 'data', '.git', 'node_modules']).not.toContain(parts[0]);
            expect(parts).not.toContain('node_modules');
            expect(byPath.has(f)).toBe(true);
          }
          const counted = entries.filter((e) => plan.files.includes(e.path) && e.kind === 'file');
          expect(plan.bytes).toBe(counted.reduce((n, e) => n + e.size, 0));
        }),
      );
    });
  });
});

describe('diffFixed', () => {
  it('reports modified, missing and added fixed files', () => {
    const prot = new Map([
      ['package.json', 'p1'],
      ['tsconfig.json', 't1'],
      ['checks/a.ts', 'c1'],
    ]);
    const snap = new Map([
      ['package.json', 'p2'],
      ['checks/a.ts', 'c1'],
      ['checks/extra.ts', 'x'],
    ]);
    expect(diffFixed(prot, snap)).toEqual([
      { path: 'checks/extra.ts', change: 'added' },
      { path: 'package.json', change: 'modified' },
      { path: 'tsconfig.json', change: 'missing' },
    ]);
  });

  it('is empty exactly when the fixed files match', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom('package.json', 'TASK.md', 'checks/x.ts'), fc.string()), (d) => {
        const m = new Map(Object.entries(d));
        expect(diffFixed(m, new Map(m))).toEqual([]);
      }),
    );
  });
});

describe('treeHash', () => {
  it('is independent of insertion order and sensitive to content', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.tuple(fc.string({ minLength: 1 }), fc.stringMatching(/^[0-9a-f]{0,8}$/)), { selector: (t) => t[0] }), (pairs) => {
        expect(treeHash(new Map(pairs))).toBe(treeHash(new Map([...pairs].reverse())));
      }),
    );
    expect(treeHash(new Map([['a', '1']]))).not.toBe(treeHash(new Map([['a', '2']])));
  });
});

describe('prepareWorkspace', () => {
  it('copies model files, restores protected fixed files, and installs protected dependencies', () => {
    const scaf = scaffold();
    const snap = tmp();
    write(snap, {
      'package.json': '{"name":"job-tracker","scripts":{"build":"echo pretend"}}',
      'tsconfig.json': '{}',
      'TASK.md': '# brief',
      '.gitignore': 'dist/\n',
      'package-lock.json': '{}',
      'checks/smoke.ts': 'always pass',
      'src/server.ts': 'model server',
      'ui/index.html': '<html>',
      'dist/server.js': 'stale build',
      'data/jobs.db': 'stale state',
    });
    symlinkSync('/etc/hosts', join(snap, 'src/link.ts'));
    const work = tmp();
    const ws = prepareWorkspace(snap, scaf, work);
    expect(ws.status).toBe('ready');
    expect(readFileSync(join(ws.appDir, 'src/server.ts'), 'utf8')).toBe('model server');
    expect(readFileSync(join(ws.appDir, 'package.json'), 'utf8')).toBe('{"name":"job-tracker"}');
    expect(readFileSync(join(ws.appDir, 'checks/smoke.ts'), 'utf8')).toBe('smoke');
    expect(existsSync(join(ws.appDir, 'node_modules/typescript/package.json'))).toBe(true);
    expect(existsSync(join(ws.appDir, 'dist'))).toBe(false);
    expect(existsSync(join(ws.appDir, 'data'))).toBe(false);
    expect(existsSync(join(ws.appDir, 'src/link.ts'))).toBe(false);
    expect(ws.fixedChanges).toEqual([
      { path: 'checks/smoke.ts', change: 'modified' },
      { path: 'package.json', change: 'modified' },
    ]);
    expect(ws.ignored).toEqual([{ path: 'src/link.ts', reason: 'symbolic link not followed' }]);
    expect(ws.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(snap, 'package.json'), 'utf8')).toContain('pretend');
  });

  it('reports missing output for an absent or empty snapshot', () => {
    const scaf = scaffold();
    expect(prepareWorkspace(join(tmp(), 'nope'), scaf, tmp()).status).toBe('missing-output');
    expect(prepareWorkspace(tmp(), scaf, tmp()).status).toBe('missing-output');
  });

  it('raises an infrastructure error when protected dependencies are not installed', () => {
    const scaf = scaffold();
    rmSync(join(scaf, 'node_modules'), { recursive: true });
    const snap = tmp();
    write(snap, { 'src/a.ts': 'x' });
    expect(() => prepareWorkspace(snap, scaf, tmp())).toThrow(/fixtures:install/);
  });
});
