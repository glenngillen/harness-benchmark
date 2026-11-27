import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { aggregate, modelShort, type AnalysisOptions } from '../../src/analysis/aggregate.ts';
import { allFigures, costFigure, esc, LABEL_W, niceTicks, RIGHT_W, tokenMeans, W } from '../../src/analysis/figures.ts';
import { conditionsCsv, csvField, operationalCsv, rolesCsv, summaryMarkdown, toCsv, workflowsCsv } from '../../src/analysis/tables.ts';
import { COMMITTED, fullCampaign, MATRIX, MODELS, SCHEDULE, SNAP } from './support/synthetic-records.ts';

const OPTS: AnalysisOptions = { label: 'cohort-03', dataset: 'synthetic', matrix: MATRIX, schedule: SCHEDULE, roles: MODELS.roles, bootstrap: { seed: 20261114, resamples: 400, confidence: 0.95 } };
const CTX = { snapshotDate: '2026-11-13', ceilingMinutes: 30 };

const varied = fullCampaign((s) => ({
  termination: s.conditionId === 'solo.AC.off' ? 'task-timeout' : (s.block * 3 + s.slot) % 4 === 0 ? 'stage-timeout' : 'completed',
  tokens: 3000 + 900 * ((s.block * 5 + s.slot) % 13),
  activeMs: 60_000 * (4 + ((s.block * 7 + s.slot * 3) % 26)),
  missingStages: s.conditionId === 'pi.AF-CC.on' && s.block === 2 ? [1] : [],
}));
const A = aggregate(varied, OPTS);
const FIGS = allFigures(A, CTX);

/** Minimal well-formedness: balanced tags, no raw `<`/`&` in text, a single root. */
function wellFormed(svg: string): void {
  const stack: string[] = [];
  const body = svg.replace(/<style>[\s\S]*?<\/style>/, '<style/>');
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (close) expect(stack.pop()).toBe(name);
    else stack.push(name!);
  }
  expect(stack).toEqual([]);
  for (const t of body.matchAll(/>([^<]*)</g)) expect(t[1]).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/);
}

/** Rough text width at 12px (11px for `font-size="11"`), generous per character. */
const width = (text: string, size: number) => [...text].length * size * 0.56;
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('figures', () => {
  it('produces four figures per workflow, each with a CSV text equivalent', () => {
    expect(FIGS.map((f) => f.name)).toEqual(['solo', 'pi', 'irf'].flatMap((w) => ['acceptance', 'cost', 'tokens', 'elapsed'].map((k) => `${w}-${k}`)));
    for (const f of FIGS) {
      expect(f.csv.split('\n')[0]).toMatch(/^cohort,dataset,group,condition/);
      expect(f.csv.trim().split('\n')).toHaveLength(1 + (f.name.startsWith('solo') ? 8 : 16));
    }
  });

  it('every SVG is well formed, labelled for assistive technology, and points at its table', () => {
    for (const f of FIGS) {
      wellFormed(f.svg);
      expect(f.svg).toMatch(new RegExp(`role="img" aria-labelledby="${f.name}-title ${f.name}-desc"`));
      expect(f.svg).toContain(`<desc id="${f.name}-desc">`);
      expect(f.svg).toContain(`${f.name}.csv`);
      expect(f.svg).toContain('@media (prefers-color-scheme: dark)');
    }
  });

  it('labels the dataset, cohort and price date on every figure', () => {
    for (const f of FIGS) expect(f.svg).toContain(`${MATRIX.cohort} · SYNTHETIC FIXTURE, not an observation · cost.dev prices 2026-11-13`);
  });

  it('keeps row labels inside the label column and value labels inside the canvas', () => {
    for (const f of FIGS) {
      for (const m of f.svg.matchAll(/<text class="t[123]" x="([\d.]+)" y="([\d.]+)"( font-size="11")?( font-weight="600")?[^>]*>([^<]*)<\/text>/g)) {
        const x = Number(m[1]);
        const size = m[3] ? 11 : 12;
        const text = unesc(m[5]!);
        if (m[4] || Number(m[2]) < 92) continue; // headings sit on their own row; title block spans the canvas
        if (x === 16) expect(x + width(text, size), `${f.name}: "${text}"`).toBeLessThanOrEqual(LABEL_W - 4);
        if (x === W - RIGHT_W + 12) expect(x + width(text, size), `${f.name}: "${text}"`).toBeLessThanOrEqual(W - 4);
      }
    }
  });

  it('collaboration figures show the solo controls as a separate labelled group', () => {
    const f = FIGS.find((x) => x.name === 'irf-acceptance')!;
    expect(f.svg).toContain('Solo controls (same observations as the solo figure)');
    expect(f.csv).toContain(',solo-control,solo.CF.off,');
    expect(FIGS.find((x) => x.name === 'solo-acceptance')!.svg).not.toContain('Solo controls');
  });

  it('distinguishes check conditions by shape and legend, not colour alone', () => {
    const f = FIGS.find((x) => x.name === 'pi-acceptance')!;
    expect(f.svg).toContain('>checks off</text>');
    expect(f.svg).toContain('>checks on</text>');
    expect(f.svg).toMatch(/<circle class="off"/);
    expect(f.svg).toMatch(/<path class="on" d="M/);
  });

  it('writes undefined and unavailable costs as words, never as a plotted finite value', () => {
    const f = FIGS.find((x) => x.name === 'solo-cost')!;
    expect(f.svg).toContain('off: undefined, 0 of 10 accepted');
    expect(f.svg).not.toMatch(/Claude cheaper \(effort medium\), checks off: 0 of 10 accepted; \$/);
    expect(f.csv).toMatch(/solo\.AC\.off,Claude cheaper,off,10,0,undefined,,,/);
    const pi = FIGS.find((x) => x.name === 'pi-cost')!;
    expect(pi.svg).toContain('on: cost unavailable (missing price or stage record)');
    expect(pi.csv).toMatch(/pi\.AF-CC\.on,Claude frontier → Codex cheaper,on,10,\d+,unavailable,,,,suppressed/);
  });

  it('draws lower-bound Codex costs as open-ended, with no single figure', () => {
    const a = aggregate(fullCampaign(() => ({}), 10, SNAP, COMMITTED), OPTS);
    const f = costFigure(a, 'solo', CTX);
    expect(f.svg).toMatch(/≥ \$[\d.]+<\/text>/);
    expect(f.svg).toContain('stroke-dasharray="2 3"');
    expect(f.csv).toMatch(/solo\.CC\.on,Codex cheaper,on,10,10,lower-bound,,[\d.]+,,suppressed/);
  });

  it('flags inexact token counts by n rather than inventing them', () => {
    const c = A.workflows.pi!.conditions.find((x) => x.conditionId === 'pi.AF-CC.on')!;
    expect(tokenMeans(c).n).toBe(9);
    expect(FIGS.find((x) => x.name === 'pi-tokens')!.svg).toMatch(/· n=9\/10<\/text>/);
  });

  it('marks the elapsed ceiling and lists every observation in block order', () => {
    const f = FIGS.find((x) => x.name === 'solo-elapsed')!;
    expect(f.svg).toContain('30-min ceiling');
    const row = f.csv.split('\n').find((l) => l.includes(',solo.CF.on,'))!;
    expect(row.split(',').at(-1)!.split(';')).toHaveLength(10);
  });

  it('is deterministic', () => {
    expect(allFigures(aggregate(varied, OPTS), CTX)).toEqual(FIGS);
  });

  it('marks an incomplete observed campaign on the figure as methodology only', () => {
    const a = aggregate(fullCampaign(() => ({}), 2), { ...OPTS, dataset: 'observed' });
    expect(costFigure(a, 'solo', CTX).svg).toContain('INCOMPLETE: 48 of 240 scored, methodology only');
  });
});

describe('helpers', () => {
  it('niceTicks covers the maximum with round steps', () => {
    expect(niceTicks(0.37)).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    expect(niceTicks(30, 6)).toEqual([0, 5, 10, 15, 20, 25, 30]);
    expect(niceTicks(0)).toEqual([0, 1]);
    fc.assert(
      fc.property(fc.double({ min: 1e-6, max: 1e9, noNaN: true }), (m) => {
        const t = niceTicks(m);
        expect(t[0]).toBe(0);
        expect(t.at(-1)!).toBeGreaterThanOrEqual(m * (1 - 1e-9));
        expect(t.length).toBeLessThanOrEqual(12);
      }),
    );
  });
  it('escapes XML and CSV safely for arbitrary strings', () => {
    expect(esc('a<b & "c">')).toBe('a&lt;b &amp; &quot;c&quot;&gt;');
    expect(csvField('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(csvField(null)).toBe('');
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(esc(s)).not.toMatch(/[<>"]|&(?!amp;|lt;|gt;|quot;)/);
        const f = csvField(s);
        if (/[",\r\n]/.test(s)) expect(f.startsWith('"') && f.endsWith('"')).toBe(true);
        else expect(f).toBe(s);
      }),
    );
  });
  it('shortens model identifiers for labels', () => {
    expect(modelShort('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelShort('claude-haiku-5-5')).toBe('Haiku 5.5');
    expect(modelShort('gpt-6-astra')).toBe('GPT-6 Astra');
    expect(modelShort('something-else')).toBe('something-else');
  });
});

describe('tables', () => {
  it('writes one conditions, workflows and roles table per workflow with explicit statuses', () => {
    const solo = conditionsCsv(A, 'solo').trim().split('\n');
    expect(solo).toHaveLength(9);
    expect(solo.find((l) => l.includes('solo.AC.off'))).toMatch(/,undefined,/);
    expect(workflowsCsv(A, 'irf').trim().split('\n')).toHaveLength(1 + 80);
    expect(rolesCsv(A, 'irf')).toContain('irf.AC-AF-AC.on,review:AF,10,');
    expect(workflowsCsv(A, 'pi')).toContain(',unknown,');
  });
  it('lists operational exclusions separately', () => {
    expect(operationalCsv(A).trim().split('\n')).toHaveLength(1);
  });
  it('labels the summary with its status and never pools workflows', () => {
    const s = summaryMarkdown(A, '2026-11-13');
    expect(s).toContain('SYNTHETIC FIXTURE — not an observation');
    expect(s).toContain('## Solo');
    expect(s).toContain('undefined (0 accepted)');
    expect(s).toContain('not subscription charges');
    expect(s).toContain('`cohort-03-pi-workflows.csv`');
    expect(s).not.toMatch(/pooled|overall winner/i);
  });
  it('toCsv quotes every row consistently', () => {
    expect(toCsv(['a', 'b'], [[1, 'x,y']])).toBe('a,b\n1,"x,y"\n');
  });
});
