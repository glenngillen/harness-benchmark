import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BENCHMARK_ROOT } from '../../src/fixtures.ts';
import { workflowPlan, type LimitsConfig } from '../../src/orchestrator/plan.ts';
import { makeHandoff, renderTemplate, stagePrompt } from '../../src/orchestrator/prompts.ts';
import { loadPrompts } from '../../src/orchestrator/run.ts';
import { parseConditionId } from '../../src/orchestrator/schedule.ts';

const limits = JSON.parse(readFileSync(join(BENCHMARK_ROOT, 'config', 'limits.json'), 'utf8')) as LimitsConfig;
const prompts = loadPrompts();

describe('renderTemplate', () => {
  it('fills placeholders without re-expanding inserted text', () => {
    expect(renderTemplate('a {{PLAN}} b {{PLAN}}', { PLAN: '{{TASK}}' })).toBe('a {{TASK}} b {{TASK}}');
  });

  it('throws on unknown, unfilled, or unused placeholders', () => {
    expect(() => renderTemplate('{{SECRET}}', {})).toThrow(/unknown/);
    expect(() => renderTemplate('{{TASK}}', {})).toThrow(/no value/);
    expect(() => renderTemplate('x', { TASK: 't' })).toThrow(/does not use/);
  });
});

describe('makeHandoff', () => {
  it('classifies missing and whitespace-only artifacts as unusable', () => {
    expect(makeHandoff('plan', null, 100)).toMatchObject({ status: 'missing', text: null });
    expect(makeHandoff('findings', ' \n\t', 100)).toMatchObject({ status: 'empty', text: null });
    expect(makeHandoff('findings', '# Review findings\n\nNo findings.\n', 100)).toMatchObject({ status: 'ok', truncated: false });
  });

  it('never exceeds the byte limit and marks truncation', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', minLength: 1, maxLength: 400 }), fc.integer({ min: 20, max: 300 }), (s, max) => {
        const h = makeHandoff('plan', s, max);
        if (h.status !== 'ok') return;
        expect(Buffer.byteLength(h.text!)).toBeLessThanOrEqual(max);
        expect(h.truncated).toBe(h.text!.endsWith('[truncated]') && Buffer.byteLength(s.trim()) > max);
      }),
    );
  });
});

describe('stagePrompt with the frozen templates', () => {
  const inputs = (checks: 'on' | 'off', handoff = null as ReturnType<typeof makeHandoff> | null) => ({ task: prompts.task, checks, fragments: prompts.fragments, handoff });

  it('renders every role template with no placeholder left', () => {
    const plan = makeHandoff('plan', '# Plan\n\n## Approach\nDo it.', 12_000);
    const findings = makeHandoff('findings', '# Review findings\n\nNo findings.', 8_000);
    for (const id of ['solo.CF.on', 'pi.CF-CC.off', 'irf.AC-AF-AC.on']) {
      for (const s of workflowPlan(parseConditionId(id), limits)) {
        const h = s.consumes === 'plan' ? plan : s.consumes === 'findings' ? findings : null;
        const text = stagePrompt(s, prompts.templates[s.template]!, inputs('on', h));
        expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/);
        expect(text).toContain(`${Math.round(s.budgetMs / 60_000)} minutes`);
      }
    }
  });

  it('gives same-provider and mixed-provider pairs byte-identical prompts for the same role', () => {
    const plan = makeHandoff('plan', '# Plan\nSame plan', 12_000);
    const same = workflowPlan(parseConditionId('pi.CF-CC.on'), limits);
    const mixed = workflowPlan(parseConditionId('pi.AF-CC.on'), limits);
    expect(stagePrompt(same[0]!, prompts.templates['plan.md']!, inputs('on'))).toBe(stagePrompt(mixed[0]!, prompts.templates['plan.md']!, inputs('on')));
    expect(stagePrompt(same[1]!, prompts.templates['plan-implement.md']!, inputs('on', plan))).toBe(stagePrompt(mixed[1]!, prompts.templates['plan-implement.md']!, inputs('on', plan)));
    const r1 = workflowPlan(parseConditionId('irf.CC-CF-CC.off'), limits)[1]!;
    const r2 = workflowPlan(parseConditionId('irf.CC-AF-CC.off'), limits)[1]!;
    expect(stagePrompt(r1, prompts.templates['review.md']!, inputs('off'))).toBe(stagePrompt(r2, prompts.templates['review.md']!, inputs('off')));
  });

  it('includes the check note for the condition only', () => {
    const s = workflowPlan(parseConditionId('solo.CF.on'), limits)[0]!;
    expect(stagePrompt(s, prompts.templates[s.template]!, inputs('on'))).toContain(prompts.fragments.on.trimEnd());
    expect(stagePrompt(s, prompts.templates[s.template]!, inputs('off'))).toContain(prompts.fragments.off.trimEnd());
  });

  it('refuses to build a consuming prompt without a usable handoff of the right kind', () => {
    const impl = workflowPlan(parseConditionId('pi.CF-CC.on'), limits)[1]!;
    expect(() => stagePrompt(impl, prompts.templates['plan-implement.md']!, inputs('on'))).toThrow(/handoff/);
    expect(() => stagePrompt(impl, prompts.templates['plan-implement.md']!, inputs('on', makeHandoff('findings', 'x', 100)))).toThrow(/handoff/);
    expect(() => stagePrompt(impl, prompts.templates['plan-implement.md']!, inputs('on', makeHandoff('plan', '', 100)))).toThrow(/handoff/);
  });
});
