import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aggregate } from '../../src/analysis/aggregate.ts';
import { loadAnalysisConfig, readCampaign, snapshotDateOf } from '../../src/analysis/load.ts';
import { ROOT, SCHEDULE, synthRaw } from './support/synthetic-records.ts';

const TMP_ROOT = process.env.HARNESS_TEST_TMP ?? join(ROOT, '.runs', 'unit-tmp');
mkdirSync(TMP_ROOT, { recursive: true });
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('loadAnalysisConfig', () => {
  it('reads the frozen bootstrap settings, snapshot date and ceiling', () => {
    const c = loadAnalysisConfig(ROOT);
    expect(c.bootstrap).toEqual({ seed: 20261114, resamples: 10000, confidence: 0.95 });
    expect(c.snapshotDate).toBe('2026-11-13');
    expect(c.ceilingMinutes).toBe(30);
    expect(Object.keys(c.roles)).toEqual(['CF', 'CC', 'AF', 'AC']);
    expect(c.schedule.blocks).toHaveLength(10);
  });
  it('requires a dated snapshot file name', () => {
    expect(snapshotDateOf('prices/cost-dev-2026-11-13.csv')).toBe('2026-11-13');
    expect(() => snapshotDateOf('prices/latest.csv')).toThrow();
  });
});

describe('readCampaign', () => {
  it('regenerates accounting in memory from saved attempt and stage records, without writing', () => {
    const root = mkdtempSync(join(TMP_ROOT, 'analysis-load-'));
    made.push(root);
    cpSync(join(ROOT, 'config'), join(root, 'config'), { recursive: true });
    cpSync(join(ROOT, 'prices'), join(root, 'prices'), { recursive: true });
    const slots = SCHEDULE.blocks[0]!.slots.slice(0, 3);
    for (const s of slots) {
      const { attempt, records } = synthRaw({ ...s, termination: s.slot === 2 ? 'task-timeout' : 'completed', missingStages: s.slot === 3 ? [0] : [] });
      const dir = join(root, 'records', 'cohort-03', `block-01`, `slot-${String(s.slot).padStart(2, '0')}`, 'attempt-1');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'attempt.json'), JSON.stringify(attempt));
      for (const [rel, rec] of records) {
        mkdirSync(join(dir, rel), { recursive: true });
        if (rec !== null) writeFileSync(join(dir, rel, 'stage.json'), JSON.stringify(rec));
      }
    }
    const recs = readCampaign(root, 'cohort-03');
    expect(recs.map((r) => [r.slot, r.scored, r.accepted, r.measurement])).toEqual([
      [1, true, true, 'complete'],
      [2, true, false, 'complete'],
      [3, true, true, slots[2]!.conditionId.startsWith('solo') ? 'missing' : 'partial'],
    ]);
    expect(recs[0]!.provenance.priceSnapshot.file).toBe('prices/cost-dev-2026-11-13.csv');
    const c = loadAnalysisConfig(root);
    const a = aggregate(recs, { label: 'cohort-03', dataset: 'observed', matrix: c.matrix, schedule: c.schedule, roles: c.roles, bootstrap: { ...c.bootstrap, resamples: 200 } });
    expect(a.completeness).toMatchObject({ scoredSlots: 3, scheduledSlots: 240, complete: false });
    expect(readCampaign(root, 'absent')).toEqual([]);
  });
});
