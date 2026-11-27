import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  BUNDLE_SCHEMA,
  REQUIRED_BUNDLE_FILES,
  archiveEntries,
  buildBundleManifest,
  bundleKey,
  fileListText,
  parseBundleManifest,
  pathProblems,
  type BundleFacts,
} from '../../src/runner/bundle.ts';

// Synthetic facts only: no archive is built and no Git or AWS command runs.
const facts = (o: Partial<BundleFacts> = {}): BundleFacts => ({
  revision: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  createdAt: '2026-11-19T01:02:03Z',
  archiveSha256: 'c'.repeat(64),
  archiveBytes: 123_456,
  files: [...REQUIRED_BUNDLE_FILES, 'src/task.ts'],
  fileListSha256: 'd'.repeat(64),
  ...o,
});

describe('buildBundleManifest', () => {
  it('records revision, archive key, digest and file count', () => {
    expect(buildBundleManifest(facts())).toEqual({
      schema: BUNDLE_SCHEMA,
      revision: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      createdAt: '2026-11-19T01:02:03Z',
      archive: { key: `bundles/${'a'.repeat(40)}.tar.gz`, sha256: 'c'.repeat(64), bytes: 123_456 },
      files: REQUIRED_BUNDLE_FILES.length + 1,
      fileListSha256: 'd'.repeat(64),
    });
  });

  it('rejects an abbreviated revision', () => {
    expect(() => buildBundleManifest(facts({ revision: 'abc1234' }))).toThrow(/40-character commit/);
  });

  it('rejects a bundle without the runner script or lockfile', () => {
    expect(() => buildBundleManifest(facts({ files: ['package.json', 'src/task.ts'] }))).toThrow(/lacks package-lock\.json.*lacks runner\/aws\/remote\/campaign\.sh/);
  });

  it('rejects runtime state, dependencies and unsafe paths', () => {
    for (const bad of ['.runs/auth/codex/auth.json', 'node_modules/x/index.js', '../escape', '/abs', 'a//b']) {
      expect(() => buildBundleManifest(facts({ files: [...REQUIRED_BUNDLE_FILES, bad] }))).toThrow(/invalid bundle/);
    }
  });

  it('rejects zero-byte archives and malformed digests', () => {
    expect(() => buildBundleManifest(facts({ archiveBytes: 0 }))).toThrow(/positive integer/);
    expect(() => buildBundleManifest(facts({ archiveSha256: 'C'.repeat(64) }))).toThrow(/SHA-256/);
  });
});

describe('parseBundleManifest', () => {
  it('accepts a built manifest', () => {
    const m = buildBundleManifest(facts());
    expect(parseBundleManifest(JSON.parse(JSON.stringify(m)))).toEqual({ ok: true, manifest: m });
  });

  it('rejects an archive key that names another revision', () => {
    const m = { ...buildBundleManifest(facts()), archive: { key: bundleKey('e'.repeat(40)), sha256: 'c'.repeat(64), bytes: 1 } };
    const r = parseBundleManifest(m);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems).toContain('archive.key does not match the revision');
  });

  it('reports every missing field for an empty object', () => {
    const r = parseBundleManifest({});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.length).toBeGreaterThanOrEqual(7);
  });
});

describe('archiveEntries and fileListText', () => {
  it('strips the prefix and drops directories', () => {
    expect(archiveEntries('harness-benchmark/\nharness-benchmark/src/\nharness-benchmark/src/task.ts\nharness-benchmark/package.json\r\nother/file\n')).toEqual(['src/task.ts', 'package.json']);
  });

  it('sorts and de-duplicates the digest input', () => {
    expect(fileListText(['b', 'a', 'b'])).toBe('a\nb\n');
  });
});

describe('properties', () => {
  const hex = (n: number) => fc.stringMatching(new RegExp(`^[0-9a-f]{${n}}$`));
  const seg = fc.stringMatching(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,10}$/).filter((s) => s !== '.' && s !== '..' && s !== '.runs' && s !== 'node_modules');
  const relPath = fc.array(seg, { minLength: 1, maxLength: 4 }).map((s) => s.join('/'));

  it('build then parse round-trips for valid facts', () => {
    fc.assert(
      fc.property(hex(40), hex(40), hex(64), hex(64), fc.integer({ min: 1, max: 2 ** 40 }), fc.array(relPath, { maxLength: 20 }), (revision, tree, archiveSha256, fileListSha256, archiveBytes, extra) => {
        const m = buildBundleManifest(facts({ revision, tree, archiveSha256, fileListSha256, archiveBytes, files: [...REQUIRED_BUNDLE_FILES, ...extra] }));
        expect(parseBundleManifest(JSON.parse(JSON.stringify(m)))).toEqual({ ok: true, manifest: m });
        expect(m.files).toBe(new Set([...REQUIRED_BUNDLE_FILES, ...extra]).size);
      }),
    );
  });

  it('parseBundleManifest never throws on arbitrary input', () => {
    fc.assert(fc.property(fc.anything(), (x) => {
      expect(() => parseBundleManifest(x)).not.toThrow();
    }));
  });

  it('fileListText is order-independent', () => {
    fc.assert(fc.property(fc.array(relPath, { maxLength: 30 }), (xs) => {
      expect(fileListText([...xs].reverse())).toBe(fileListText(xs));
    }));
  });

  it('pathProblems flags any path containing a .. segment', () => {
    fc.assert(fc.property(fc.array(seg, { maxLength: 3 }), fc.array(seg, { maxLength: 3 }), (a, b) => {
      expect(pathProblems([...a, '..', ...b].join('/')).length).toBeGreaterThan(0);
    }));
  });
});
