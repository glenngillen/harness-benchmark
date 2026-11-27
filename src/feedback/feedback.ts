/**
 * Builds the bounded, actionable feedback message for a failing check run, and the sensor-repair
 * prompt that carries it (methodology section 5, config/feedback.json).
 *
 * Contents: each failing check (suite, name, expected versus observed), compiler output for a
 * failed build, the last stderr lines of the failing app suite, and the repair and stage budgets.
 * Secrets are redacted, absolute paths replaced, and the whole message cut at `maxBytes` with an
 * explicit marker. Budgets come first so truncation never removes them.
 */
import { tail } from '../evaluator/processes.ts';
import type { CheckRun, SuiteOutcome } from './types.ts';

export const TRUNCATION_MARKER = '\n[truncated]';
const STDERR_LINES = 40;

export interface FeedbackOptions {
  /** Sensor repairs left after the repair this feedback triggers. */
  repairsLeft: number;
  stageMinutesLeft: number;
  maxBytes: number;
  /** Absolute host paths to replace, for example the check workspace with ".". */
  replacements?: Record<string, string>;
}

/** Cuts `text` to at most `maxBytes` UTF-8 bytes, ending in the marker, without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number, marker = TRUNCATION_MARKER): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker));
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > budget) break;
    bytes += n;
    end += ch.length;
  }
  return text.slice(0, end) + marker;
}

/** Redacts likely secrets (same rule as captured app output) and replaces host paths, longest first. */
function clean(lines: readonly string[], replacements: Record<string, string>): string[] {
  const pairs = Object.entries(replacements)
    .filter(([from]) => from.length > 1)
    .sort((a, b) => b[0].length - a[0].length);
  const replaced = lines.flatMap((l) => pairs.reduce((acc, [from, to]) => acc.split(from).join(to), l).split(/\r?\n/));
  return tail(replaced.join('\n'), Number.MAX_SAFE_INTEGER);
}

function suiteLines(s: SuiteOutcome, buildFailed: boolean): string[] {
  if (s.status === 'not-run') return [`[${s.suite}] not run: ${buildFailed ? 'the build failed' : 'the check ceiling was reached first'}`];
  if (s.status === 'timed-out') {
    const done = s.checks.filter((c) => !c.passed).flatMap((c) => [`[${s.suite}] ${c.name}: FAILED`, `  ${c.detail}`]);
    return [...done, `[${s.suite}] did not finish within the 120 s check ceiling`];
  }
  const out: string[] = [];
  for (const c of s.checks.filter((c) => !c.passed)) {
    out.push(`[${s.suite}] ${c.name}: FAILED`, ...c.detail.split(/\r?\n/).map((l) => `  ${l}`));
    if (s.suite === 'build' && s.output.length > 0) out.push(`  Output (last ${Math.min(s.output.length, STDERR_LINES)} lines):`, ...s.output.slice(-STDERR_LINES).map((l) => `    ${l}`));
  }
  return out;
}

export function formatFeedback(run: CheckRun, o: FeedbackOptions): string {
  const replacements = o.replacements ?? {};
  const checks = run.suites.flatMap((s) => s.checks);
  const failed = checks.filter((c) => !c.passed).length;
  const buildFailed = run.suites.some((s) => s.suite === 'build' && s.status !== 'passed');
  const lines: string[] = [
    `Deterministic checks: ${failed} of ${checks.length} checks failed.`,
    `Sensor repairs remaining after this one: ${o.repairsLeft}. Stage minutes remaining: ${(Math.floor(Math.max(0, o.stageMinutesLeft) * 10) / 10).toFixed(1)}.`,
    '',
    ...run.suites.flatMap((s) => suiteLines(s, buildFailed)),
  ];
  const noisy = [...run.suites].reverse().find((s) => (s.suite === 'smoke' || s.suite === 'contract') && s.status !== 'passed' && s.status !== 'not-run');
  if (noisy) {
    for (const proc of ['server', 'worker'] as const) {
      const got = noisy.stderr[proc].slice(-STDERR_LINES);
      lines.push('', got.length > 0 ? `${proc[0]!.toUpperCase()}${proc.slice(1)} stderr (${noisy.suite} suite, last ${got.length} lines):` : `${proc[0]!.toUpperCase()}${proc.slice(1)} stderr (${noisy.suite} suite): empty`, ...got.map((l) => `  ${l}`));
    }
  }
  return truncateUtf8(clean(lines, replacements).join('\n'), o.maxBytes);
}

/** Fills prompts/sensor-repair.md. Placeholders are replaced once, so feedback text is never re-expanded. */
export function renderRepairPrompt(template: string, feedback: string, repairsLeft: number): string {
  if (!template.includes('{{FEEDBACK}}') || !template.includes('{{REPAIRS_LEFT}}')) throw new Error('sensor-repair template is missing a placeholder');
  return template.replace(/\{\{(FEEDBACK|REPAIRS_LEFT)\}\}/g, (_, name: string) => (name === 'FEEDBACK' ? feedback : String(repairsLeft)));
}
