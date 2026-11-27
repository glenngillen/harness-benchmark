import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MAX_RECORD_BYTES, planFetch, recordPathFor, recordRejection, s3SyncFilterArgs, type StagedFile } from '../../src/runner/records.ts';

// Synthetic paths only; nothing here reads the bucket or the worktree.
describe('recordRejection', () => {
  it.each([
    'cohort-03-pilots/pilot/slot-01-solo.CF.off/attempt-1/attempt.json',
    'cohort-03-pilots/pilot/slot-01-solo.CF.off/attempt-1/transitions.jsonl',
    'cohort-03-pilots/pilot/slot-01-solo.CF.off/attempt-1/stages/s1-implement/stage.json',
    'cohort-03-pilots/pilot/slot-01-solo.CF.off/attempt-1/stages/s1-implement/stderr.txt',
    'cohort-03-pilots/pilot/slot-03-pi.CF-AC.on/attempt-1/plan.md',
    'cohort-03-pilots/host-evidence/host-2026-11-20T00-00-00Z.json',
    'cohort-03-pilots/readiness-2026-11-20.json',
    'cohort-03/block-01/campaign-log.jsonl',
  ])('accepts %s', (rel) => {
    expect(recordRejection(rel)).toBeNull();
  });

  it.each([
    ['../outside.json', 'path'],
    ['/etc/passwd.json', 'path'],
    ['a//b.json', 'path'],
    ['cohort-03-pilots/.runs/auth/codex/auth.json', 'denied-segment'],
    ['cohort-03-pilots/x/auth/oauth.json', 'denied-segment'],
    ['cohort-03-pilots/x/node_modules/pkg/package.json', 'denied-segment'],
    ['cohort-03-pilots/x/workspace/package.json', 'denied-segment'],
    ['cohort-03-pilots/x/.hidden.json', 'hidden'],
    ['cohort-03-pilots/x/auth.json', 'denied-name'],
    ['cohort-03-pilots/x/oauth-token', 'denied-name'],
    ['cohort-03-pilots/x/credentials.json', 'denied-name'],
    ['cohort-03-pilots/x/.env', 'hidden'],
    ['cohort-03-pilots/x/state.db', 'extension'],
    ['cohort-03-pilots/x/.json', 'hidden'],
    ['cohort-03-pilots/x/plan.tar.gz', 'extension'],
  ])('rejects %s (%s)', (rel, reason) => {
    expect(recordRejection(rel)).toBe(reason);
  });

  it('rejects oversized files', () => {
    expect(recordRejection('cohort-03-pilots/a.json', MAX_RECORD_BYTES + 1)).toBe('size');
    expect(recordRejection('cohort-03-pilots/a.json', MAX_RECORD_BYTES)).toBeNull();
  });
});

describe('recordPathFor', () => {
  it('maps a bucket key into records/', () => {
    expect(recordPathFor('records/cohort-03-pilots/a.json')).toEqual({ path: 'records/cohort-03-pilots/a.json' });
  });
  it('rejects keys outside the records prefix', () => {
    expect(recordPathFor('bundles/abc.json')).toEqual({ rejected: 'outside-records' });
    expect(recordPathFor('recordsX/a.json')).toEqual({ rejected: 'outside-records' });
  });
});

describe('local-only quota audits', () => {
  it('never fetches a block audit back from the runner', () => {
    expect(recordRejection('cohort-03/block-01/audit.json')).toBe('local-only');
    expect(recordRejection('cohort-03-pilots/pilot/audit.json')).toBe('local-only');
    expect(recordRejection('cohort-03/block-01/slot-01-solo.CF.off/attempt-1/attempt.json')).toBeNull();
    const plan = planFetch([{ rel: 'cohort-03/block-01/audit.json', bytes: 10, sha256: 'a' }], new Map([['records/cohort-03/block-01/audit.json', 'b']]));
    expect(plan).toEqual({ copy: [], unchanged: [], rejected: [{ rel: 'cohort-03/block-01/audit.json', reason: 'local-only' }] });
    const a = s3SyncFilterArgs();
    expect(a.slice(-4)).toEqual(['--exclude', 'audit.json', '--exclude', '*/audit.json']);
  });
});

describe('s3SyncFilterArgs', () => {
  it('starts by excluding everything and ends with the credential exclusions', () => {
    const a = s3SyncFilterArgs();
    expect(a.slice(0, 2)).toEqual(['--exclude', '*']);
    expect(a).toContain('*.jsonl');
    expect(a.lastIndexOf('--include')).toBeLessThan(a.indexOf('*auth*'));
    expect(a.length % 2).toBe(0);
  });
});

describe('planFetch', () => {
  const f = (rel: string, sha256 = 'x', bytes = 10): StagedFile => ({ rel, sha256, bytes });

  it('separates new, changed, unchanged and rejected files', () => {
    const plan = planFetch(
      [f('cohort-03-pilots/new.json', 'n'), f('cohort-03-pilots/log.jsonl', 'grew'), f('cohort-03-pilots/same.md', 's'), f('cohort-03-pilots/.runs/auth/codex/auth.json')],
      new Map([['records/cohort-03-pilots/log.jsonl', 'old'], ['records/cohort-03-pilots/same.md', 's']]),
    );
    expect(plan.copy).toEqual([
      { from: 'cohort-03-pilots/log.jsonl', to: 'records/cohort-03-pilots/log.jsonl', change: 'changed' },
      { from: 'cohort-03-pilots/new.json', to: 'records/cohort-03-pilots/new.json', change: 'new' },
    ]);
    expect(plan.unchanged).toEqual(['records/cohort-03-pilots/same.md']);
    expect(plan.rejected).toEqual([{ rel: 'cohort-03-pilots/.runs/auth/codex/auth.json', reason: 'denied-segment' }]);
  });
});

describe('properties', () => {
  const seg = fc.stringMatching(/^[A-Za-z0-9_.-]{1,12}$/);
  const rel = fc.array(seg, { minLength: 1, maxLength: 5 }).map((s) => s.join('/'));
  const anyRel = fc.oneof(rel, fc.string({ maxLength: 40 }));

  it('every accepted path stays under records/ with an allowed extension and no denied segment', () => {
    fc.assert(fc.property(anyRel, (r) => {
      const m = recordPathFor(`records/${r}`);
      if ('path' in m) {
        expect(m.path.startsWith('records/')).toBe(true);
        const segs = m.path.split('/');
        expect(segs).not.toContain('..');
        expect(segs.some((s) => s.startsWith('.') || ['auth', 'node_modules', 'workspace'].includes(s))).toBe(false);
        expect(/\.(json|jsonl|md|txt)$/.test(m.path)).toBe(true);
      }
    }));
  });

  it('recordRejection never throws on arbitrary input', () => {
    fc.assert(fc.property(fc.string(), fc.option(fc.double()), (s, b) => {
      expect(() => recordRejection(s, b ?? undefined)).not.toThrow();
    }));
  });

  it('planFetch accounts for every staged file exactly once, independent of listing order', () => {
    const staged = fc.uniqueArray(fc.record({ rel: anyRel, sha256: fc.constantFrom('a', 'b'), bytes: fc.nat(100) }), { maxLength: 30, selector: (x) => x.rel });
    fc.assert(fc.property(staged, fc.array(fc.tuple(rel, fc.constantFrom('a', 'b')), { maxLength: 10 }), (files, ex) => {
      const existing = new Map(ex.map(([r, h]) => [`records/${r}`, h] as const));
      const p = planFetch(files, existing);
      expect(p.copy.length + p.unchanged.length + p.rejected.length).toBe(files.length);
      expect(planFetch([...files].reverse(), existing)).toEqual(p);
    }));
  });
});
