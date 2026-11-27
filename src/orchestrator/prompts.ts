/**
 * Artifact-only handoffs (methodology section 6). Every stage prompt is a frozen template from
 * `prompts/` with `{{PLACEHOLDER}}` values filled from the task, the stage budget, the check
 * condition, and at most one captured artifact. Nothing else crosses between sessions, so a
 * same-provider and a mixed-provider stage with the same inputs receive byte-identical prompts.
 */
import { createHash } from 'node:crypto';
import { truncateUtf8 } from '../feedback/feedback.ts';
import type { HandoffKind, StagePlan } from './plan.ts';
import type { CheckCondition } from './schedule.ts';

export const PLACEHOLDERS = ['TASK', 'STAGE_MINUTES', 'CHECKS_NOTE', 'PLAN', 'FINDINGS', 'FEEDBACK', 'REPAIRS_LEFT'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/** Pure: fills every `{{NAME}}` exactly once per occurrence; unknown or unfilled placeholders throw. */
export function renderTemplate(template: string, values: Partial<Record<Placeholder, string>>): string {
  const used = new Set<string>();
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, name: string) => {
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) throw new Error(`unknown placeholder {{${name}}}`);
    const v = values[name as Placeholder];
    if (v === undefined) throw new Error(`no value for {{${name}}}`);
    used.add(name);
    return v;
  });
  const extra = Object.keys(values).filter((k) => !used.has(k));
  if (extra.length) throw new Error(`values supplied for placeholders the template does not use: ${extra.join(', ')}`);
  return out;
}

export type HandoffStatus = 'ok' | 'missing' | 'empty';

export interface Handoff {
  kind: HandoffKind;
  status: HandoffStatus;
  /** Exactly what the next stage receives (truncated with a marker), or null when unusable. */
  text: string | null;
  originalBytes: number;
  truncated: boolean;
  sha256: string | null;
}

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** Pure: a captured artifact becomes a handoff. Missing or whitespace-only output is unusable. */
export function makeHandoff(kind: HandoffKind, captured: string | null, maxBytes: number): Handoff {
  if (captured === null) return { kind, status: 'missing', text: null, originalBytes: 0, truncated: false, sha256: null };
  const originalBytes = Buffer.byteLength(captured);
  if (captured.trim() === '') return { kind, status: 'empty', text: null, originalBytes, truncated: false, sha256: null };
  const text = truncateUtf8(captured.trim(), maxBytes);
  return { kind, status: 'ok', text, originalBytes, truncated: text !== captured.trim(), sha256: sha256(text) };
}

export interface PromptInputs {
  task: string;
  checks: CheckCondition;
  /** Text of prompts/fragments/checks-on.md and checks-off.md. */
  fragments: Record<CheckCondition, string>;
  handoff: Handoff | null;
}

/** Pure: the prompt for one principal stage. Values depend on the role template, never the provider. */
export function stagePrompt(stage: StagePlan, template: string, i: PromptInputs): string {
  const values: Partial<Record<Placeholder, string>> = { STAGE_MINUTES: String(Math.round(stage.budgetMs / 60_000)) };
  if (template.includes('{{TASK}}')) values.TASK = i.task.trimEnd();
  if (template.includes('{{CHECKS_NOTE}}')) values.CHECKS_NOTE = i.fragments[i.checks].trimEnd();
  if (stage.consumes) {
    if (!i.handoff || i.handoff.kind !== stage.consumes || i.handoff.status !== 'ok' || i.handoff.text === null) {
      throw new Error(`${stage.id} requires a usable ${stage.consumes} handoff`);
    }
    values[stage.consumes === 'plan' ? 'PLAN' : 'FINDINGS'] = i.handoff.text;
  }
  return renderTemplate(template, values);
}
