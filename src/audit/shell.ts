/**
 * Shell health of one stage, read from its recorded `events.jsonl`. Shared by the freeze gate's
 * exercise condition, the live runner status and the post-hoc review, so all three read the event
 * streams the same way.
 *
 * - Claude Code: each assistant `tool_use` named `Bash` is one command; its `tool_result` (matched by
 *   `tool_use_id`) succeeded when `is_error` is not true. A tool_use with no result counts as failed.
 * - Codex: each completed `command_execution` item is one command; it succeeded when `exit_code`
 *   is 0. Items that never completed count as failed.
 *
 * A Bash tool that refuses to start (for example Claude Code's "Sandbox is required but failed to
 * initialize ... socat not installed") is reported as attempted > 0, succeeded = 0. Pure and total: malformed lines are counted and skipped.
 */

export type ShellProvider = 'anthropic' | 'openai';

export interface ShellHealth {
  /** Commands the model asked to run. */
  attempted: number;
  /** Commands that ran and succeeded (Claude: non-error tool result; Codex: exit code 0). */
  succeeded: number;
  /** attempted - succeeded. */
  failed: number;
  /** Lines that were not JSON objects. */
  malformedLines: number;
  /** First failure text seen (trimmed to 200 characters), to say why a shell did not work. */
  firstFailure: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200);

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : '')).join(' ');
  return '';
}

function parseLines(text: string): { objs: Obj[]; malformed: number } {
  const objs: Obj[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isObj(v)) objs.push(v);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { objs, malformed };
}

function claudeHealth(objs: Obj[]): Omit<ShellHealth, 'malformedLines'> {
  const bash = new Set<string>();
  const outcome = new Map<string, { ok: boolean; text: string }>();
  for (const o of objs) {
    const msg = isObj(o.message) ? o.message : null;
    const content = msg && Array.isArray(msg.content) ? msg.content : [];
    for (const c of content) {
      if (!isObj(c)) continue;
      if (o.type === 'assistant' && c.type === 'tool_use' && c.name === 'Bash' && typeof c.id === 'string') bash.add(c.id);
      if (o.type === 'user' && c.type === 'tool_result' && typeof c.tool_use_id === 'string' && !outcome.has(c.tool_use_id)) {
        outcome.set(c.tool_use_id, { ok: c.is_error !== true, text: resultText(c.content) });
      }
    }
  }
  let succeeded = 0;
  let firstFailure: string | null = null;
  for (const id of bash) {
    const r = outcome.get(id);
    if (r?.ok) succeeded++;
    else if (firstFailure === null) firstFailure = r ? clip(r.text) || 'error result with no text' : 'no tool result recorded';
  }
  return { attempted: bash.size, succeeded, failed: bash.size - succeeded, firstFailure };
}

function codexHealth(objs: Obj[]): Omit<ShellHealth, 'malformedLines'> {
  const items = new Map<string, { done: boolean; exit: unknown; output: string }>();
  for (const o of objs) {
    const it = isObj(o.item) ? o.item : null;
    if (!it || it.type !== 'command_execution' || typeof it.id !== 'string') continue;
    const done = o.type === 'item.completed';
    const prev = items.get(it.id);
    if (prev?.done) continue;
    items.set(it.id, { done, exit: it.exit_code, output: typeof it.aggregated_output === 'string' ? it.aggregated_output : '' });
  }
  let succeeded = 0;
  let firstFailure: string | null = null;
  for (const r of items.values()) {
    if (r.done && r.exit === 0) succeeded++;
    else if (firstFailure === null) firstFailure = r.done ? `exit ${String(r.exit)}: ${clip(r.output)}`.trim() : 'command never completed';
  }
  return { attempted: items.size, succeeded, failed: items.size - succeeded, firstFailure };
}

/** Pure: the shell health of one stage's event stream. Never throws. */
export function shellHealth(provider: ShellProvider, eventsText: string): ShellHealth {
  const { objs, malformed } = parseLines(eventsText);
  const h = provider === 'anthropic' ? claudeHealth(objs) : codexHealth(objs);
  return { ...h, malformedLines: malformed };
}

/**
 * Pure: why a fresh implement stage does not demonstrate a working shell, or null when it does. It
 * must have run at least one command successfully (exit 0 / non-error result). Fix and sensor-repair
 * stages are not judged: they may legitimately run only a failing build, and a command that fails
 * does not mean the shell is broken.
 */
export function shellProblem(h: ShellHealth | null): string | null {
  if (h === null) return 'no event stream recorded';
  if (h.succeeded > 0) return null;
  if (h.attempted > 0) return `all ${h.attempted} shell command(s) failed${h.firstFailure ? ` (${h.firstFailure})` : ''}`;
  return 'ran no shell command';
}

/** Pure: whether a stage id names a fresh implement stage (not a sensor repair, fix, plan or review). */
export const isFreshImplementStage = (stageId: string): boolean => /(^|-)s\d+-implement$/.test(stageId);

export interface ShellTallyEntry {
  /** Fresh implement stages seen. */
  writeStages: number;
  /** Implement stages with at least one successful command. */
  working: number;
  /** Implement stages that tried commands and had every one fail. */
  allFailed: number;
  /** Implement stages that ran no command. */
  noCommands: number;
  /** Up to three examples of failing stages, with the first failure text. */
  examples: string[];
}

/** Pure: per-provider tally of fresh implement stages' shell health, for live status output. */
export function tallyShell(stages: readonly { provider: ShellProvider; label: string; health: ShellHealth }[]): Record<ShellProvider, ShellTallyEntry> {
  const empty = (): ShellTallyEntry => ({ writeStages: 0, working: 0, allFailed: 0, noCommands: 0, examples: [] });
  const out: Record<ShellProvider, ShellTallyEntry> = { anthropic: empty(), openai: empty() };
  for (const s of stages) {
    const t = out[s.provider];
    t.writeStages++;
    if (s.health.succeeded > 0) t.working++;
    else if (s.health.attempted > 0) {
      t.allFailed++;
      if (t.examples.length < 3) t.examples.push(`${s.label}: ${s.health.firstFailure ?? 'failed'}`);
    } else t.noCommands++;
  }
  return out;
}
