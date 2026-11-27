import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { planReferenceFiles, listFiles, BENCHMARK_ROOT, loadBrokenManifest, loadTamperManifest, overlayChain } from '../../src/fixtures.ts';
import { extractBrief } from '../../src/task.ts';

const fx = (...p: string[]) => join(BENCHMARK_ROOT, 'fixtures', ...p);

describe('planReferenceFiles', () => {
  it('takes overlay files in place of correct ones and keeps the rest', () => {
    expect(planReferenceFiles(['a.ts', 'b.ts'], ['b.ts'])).toEqual([
      { path: 'a.ts', from: 'correct' },
      { path: 'b.ts', from: 'overlay' },
    ]);
  });

  it('rejects overlay files absent from the correct reference', () => {
    expect(() => planReferenceFiles(['a.ts'], ['new.ts'])).toThrow(/new\.ts/);
  });

  it('covers every correct file exactly once', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}\.ts$/), { minLength: 1 }), fc.nat(), (files, n) => {
        const overlay = files.filter((_, i) => (i + n) % 3 === 0);
        const plan = planReferenceFiles(files, overlay);
        expect(plan.map((p) => p.path).sort()).toEqual([...files].sort());
        expect(plan.filter((p) => p.from === 'overlay').map((p) => p.path).sort()).toEqual([...overlay].sort());
      }),
    );
  });
});

describe('broken references', () => {
  const manifest = loadBrokenManifest();
  const correct = listFiles(fx('references', 'correct'));

  it('include exactly one reference per acceptance behaviour A1-A8', () => {
    expect(manifest.map((m) => m.behaviour).sort()).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']);
  });

  it.each(manifest.map((m) => [m.id, m] as const))('%s overlays only its declared files, each changed', (id, m) => {
    const overlay = listFiles(fx('references', 'broken', id));
    expect(overlay.sort()).toEqual([...m.files].sort());
    for (const f of overlay) {
      expect(correct).toContain(f);
      expect(readFileSync(fx('references', 'broken', id, f), 'utf8')).not.toBe(readFileSync(fx('references', 'correct', f), 'utf8'));
    }
  });
});

describe('tamper references', () => {
  const tamper = loadTamperManifest();
  const broken = loadBrokenManifest();
  const correct = listFiles(fx('references', 'correct'));

  it.each(tamper.map((m) => [m.id, m] as const))('%s overlays only declared, existing files on a known base', (id, m) => {
    expect(listFiles(fx('references', 'tamper', id)).sort()).toEqual([...m.files].sort());
    for (const f of m.files) expect(correct).toContain(f);
    expect(m.base === 'correct' || broken.some((b) => b.id === m.base)).toBe(true);
  });

  it('orders overlays base first, then the tamper overlay', () => {
    expect(overlayChain('correct', broken, tamper)).toEqual([]);
    expect(overlayChain('A6-no-retry', broken, tamper)).toEqual(['broken/A6-no-retry']);
    expect(overlayChain('T1-probes-evaluator', broken, tamper)).toEqual(['broken/A3-wrong-output', 'tamper/T1-probes-evaluator']);
    expect(overlayChain('T2-rewrites-fixed-files', broken, tamper)).toEqual(['tamper/T2-rewrites-fixed-files']);
    expect(() => overlayChain('nope', broken, tamper)).toThrow(/unknown reference/);
    expect(() => overlayChain('X', broken, [{ id: 'X', base: 'missing' }])).toThrow(/unknown base/);
  });
});

describe('model-visible scaffold', () => {
  const scaffold = listFiles(fx('scaffold'));

  it('shares the fixed files byte-for-byte with the correct reference', () => {
    const checks = scaffold.filter((f) => f.startsWith('checks/'));
    expect(checks).toEqual(['checks/cli.ts', 'checks/contract.ts', 'checks/core.ts', 'checks/smoke.ts']);
    expect(listFiles(fx('references', 'correct')).filter((f) => f.startsWith('checks/'))).toEqual(checks);
    for (const f of ['package.json', 'package-lock.json', 'tsconfig.json', 'TASK.md', '.gitignore', ...checks]) {
      expect(scaffold).toContain(f);
      expect(readFileSync(fx('scaffold', f), 'utf8')).toBe(readFileSync(fx('references', 'correct', f), 'utf8'));
    }
  });

  it('contains no reference solution modules or evaluator material', () => {
    for (const f of ['src/store.ts', 'src/retry.ts', 'src/fingerprint.ts', 'src/recovery.ts', 'src/validate.ts']) {
      expect(scaffold).not.toContain(f);
    }
    expect(scaffold.some((f) => /evaluator|references|broken/i.test(f))).toBe(false);
  });

  it('exposes the fixed build-time check commands', () => {
    const pkg = JSON.parse(readFileSync(fx('scaffold', 'package.json'), 'utf8'));
    expect(pkg.scripts['check:smoke']).toMatch(/checks\/cli\.ts smoke$/);
    expect(pkg.scripts['check:contract']).toMatch(/checks\/cli\.ts contract$/);
  });

  it('has no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(fx('scaffold', 'package.json'), 'utf8'));
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('ships TASK.md byte-identical to the brief in task.md', () => {
    const brief = extractBrief(readFileSync(join(BENCHMARK_ROOT, 'task.md'), 'utf8'));
    expect(readFileSync(fx('scaffold', 'TASK.md'), 'utf8')).toBe(brief);
  });
});

describe('extractBrief', () => {
  it('returns the text between the brief markers', () => {
    expect(extractBrief('x\n<!-- BRIEF:START -->\n# T\nbody\n<!-- BRIEF:END -->\ny')).toBe('# T\nbody\n');
  });

  it('throws when markers are missing', () => {
    expect(() => extractBrief('nothing')).toThrow();
  });
});

it('fixture tree avoids root-ignored names', () => {
  const all = listFiles(join(BENCHMARK_ROOT, 'fixtures'));
  expect(all.some((f) => /(^|\/)(public|logs|coverage|\.cache)(\/|$)|\.log$|\.seed$|(^|\/)\.env/.test(f))).toBe(false);
  expect(existsSync(fx('scaffold', 'ui', 'index.html'))).toBe(true);
  expect(readdirSync(fx('references', 'broken')).length).toBeGreaterThan(0);
});
