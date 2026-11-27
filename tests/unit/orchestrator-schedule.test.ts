import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BENCHMARK_ROOT } from '../../src/fixtures.ts';
import { expandConditions, generateSchedule, mulberry32, parseConditionId, pilotSlots, renderSchedule, shuffle, type MatrixConfig } from '../../src/orchestrator/schedule.ts';

const matrix = JSON.parse(readFileSync(join(BENCHMARK_ROOT, 'config', 'matrix.json'), 'utf8')) as MatrixConfig;

describe('mulberry32', () => {
  it('matches the reference implementation for a fixed seed', () => {
    // Reference values from the canonical JavaScript mulberry32 (a += 0x6D2B79F5; ...).
    const ref = (a: number) => () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        const a = mulberry32(seed);
        const b = ref(seed);
        for (let i = 0; i < 20; i++) expect(a()).toBe(b());
      }),
    );
  });

  it('stays in [0, 1)', () => {
    const r = mulberry32(20261114);
    for (let i = 0; i < 10_000; i++) {
      const x = r();
      expect(x >= 0 && x < 1).toBe(true);
    }
  });
});

describe('shuffle', () => {
  it('is a permutation and leaves the input untouched', () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), fc.integer(), (xs, seed) => {
        const copy = [...xs];
        const out = shuffle(xs, mulberry32(seed));
        expect(xs).toEqual(copy);
        expect([...out].sort((a, b) => a - b)).toEqual([...xs].sort((a, b) => a - b));
      }),
    );
  });
});

describe('schedule', () => {
  const schedule = generateSchedule(matrix);

  it('reproduces the committed config/schedule.json byte for byte', () => {
    expect(readFileSync(join(BENCHMARK_ROOT, 'config', 'schedule.json'), 'utf8')).toBe(renderSchedule(schedule));
  });

  it('has ten blocks, each holding every one of the 24 conditions exactly once', () => {
    expect(schedule.blocks).toHaveLength(10);
    for (const b of schedule.blocks) {
      expect(b.slots).toHaveLength(24);
      expect(new Set(b.slots.map((s) => s.conditionId))).toEqual(new Set(matrix.canonicalConditionOrder));
      expect(b.slots.map((s) => s.slot)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    }
    expect(schedule.blocks.flatMap((b) => b.slots)).toHaveLength(240);
  });

  it('continues one PRNG stream across blocks (blocks differ)', () => {
    const orders = new Set(schedule.blocks.map((b) => b.slots.map((s) => s.conditionId).join()));
    expect(orders.size).toBe(10);
  });

  it('refuses a canonical order that disagrees with the matrix', () => {
    expect(() => generateSchedule({ ...matrix, canonicalConditionOrder: [...matrix.canonicalConditionOrder].reverse() })).toThrow(/canonicalConditionOrder/);
  });

  it('expands the matrix into the canonical order', () => {
    expect(expandConditions(matrix)).toEqual(matrix.canonicalConditionOrder);
  });

  it('pilots run every configuration once, apart from the scored blocks', () => {
    const p = pilotSlots(matrix);
    expect(p.map((s) => s.conditionId)).toEqual(matrix.canonicalConditionOrder);
    expect(p.every((s) => s.block === 0)).toBe(true);
  });
});

describe('parseConditionId', () => {
  it('parses the three workflow shapes', () => {
    expect(parseConditionId('solo.CF.off')).toEqual({ id: 'solo.CF.off', workflow: 'solo', assignment: ['CF'], checks: 'off' });
    expect(parseConditionId('pi.AF-CC.on').assignment).toEqual(['AF', 'CC']);
    expect(parseConditionId('irf.CC-AF-CC.on').assignment).toEqual(['CC', 'AF', 'CC']);
  });

  it.each(['solo.CF-CC.off', 'pi.CF.on', 'irf.CC-AF-AC.on', 'solo.XX.off', 'solo.CF.maybe', 'combo.CF.on', ''])('rejects %j', (id) => {
    expect(() => parseConditionId(id)).toThrow();
  });
});
