import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { pilotPaths, pilotsLabel } from '../../src/orchestrator/cohort.ts';

describe('pilotsLabel', () => {
  it("keeps each cohort's pilots in their own directory", () => {
    expect(pilotsLabel('cohort-03')).toBe('cohort-03-pilots');
    expect(pilotPaths('cohort-03')).toEqual({ base: 'records/cohort-03-pilots', attempts: 'records/cohort-03-pilots/pilot', hostEvidence: 'records/cohort-03-pilots/host-evidence', safeguards: 'records/cohort-03-pilots/safeguards.json' });
  });

  it('rejects anything that is not cohort-NN', () => {
    for (const bad of ['', 'pilots', 'cohort-1', '../cohort-03', 'cohort-03/x']) expect(() => pilotsLabel(bad)).toThrow();
  });

  describe('properties', () => {
    it('distinct cohorts get distinct pilot directories, none equal to a cohort label', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 99 }), fc.integer({ min: 1, max: 99 }), (a, b) => {
          const ca = `cohort-${String(a).padStart(2, '0')}`;
          const cb = `cohort-${String(b).padStart(2, '0')}`;
          const la = pilotsLabel(ca);
          return la !== ca && la !== cb && (a === b) === (la === pilotsLabel(cb));
        }),
      );
    });
  });
});
