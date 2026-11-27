/**
 * The predeclared campaign schedule (methodology section 6). Pure: the same matrix and seed always
 * produce byte-identical `config/schedule.json`, which is committed before pilots and verified by a
 * unit test. Ten blocks; each restarts from the canonical condition order and continues one
 * mulberry32 stream through a Fisher-Yates shuffle, so each block holds every condition once.
 */
import type { RoleKey } from '../adapters/types.ts';

export const SCHEDULE_SCHEMA = 'harness-benchmark/schedule@1';
export type WorkflowKind = 'solo' | 'pi' | 'irf';
export type CheckCondition = 'off' | 'on';

export interface Condition {
  id: string;
  workflow: WorkflowKind;
  /** Roles in stage order of first appearance: solo [impl], pi [planner, impl], irf [impl, reviewer, impl]. */
  assignment: RoleKey[];
  checks: CheckCondition;
}

export interface MatrixConfig {
  cohort: string;
  repetitions: number;
  checkConditions: CheckCondition[];
  workflows: Record<WorkflowKind, { stages: string[]; assignments: RoleKey[][] }>;
  canonicalConditionOrder: string[];
  schedule: { seed: number; blocks: number; prng: string; concurrency: number };
}

export interface ScheduleSlot {
  block: number;
  slot: number;
  conditionId: string;
}

export interface Schedule {
  schema: typeof SCHEDULE_SCHEMA;
  cohort: string;
  seed: number;
  prng: 'mulberry32';
  shuffle: 'fisher-yates-descending';
  concurrency: 1;
  blocks: { block: number; slots: ScheduleSlot[] }[];
}

/** mulberry32: a 32-bit seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, i from n-1 down to 1, j = floor(rand() * (i + 1)). Returns a new array. */
export function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i >= 1; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const ROLES: ReadonlySet<string> = new Set(['CF', 'CC', 'AF', 'AC']);

/** Parses `solo.CF.off`, `pi.CF-CC.on`, `irf.CC-AF-CC.off`. Throws on anything else. */
export function parseConditionId(id: string): Condition {
  const m = /^(solo|pi|irf)\.([A-Z]{2}(?:-[A-Z]{2})*)\.(off|on)$/.exec(id);
  if (!m) throw new Error(`invalid condition id ${JSON.stringify(id)}`);
  const workflow = m[1] as WorkflowKind;
  const assignment = m[2]!.split('-');
  if (!assignment.every((r) => ROLES.has(r))) throw new Error(`unknown role in ${id}`);
  const expected = { solo: 1, pi: 2, irf: 3 }[workflow];
  if (assignment.length !== expected) throw new Error(`${workflow} needs ${expected} roles, got ${assignment.length} in ${id}`);
  if (workflow === 'irf' && assignment[0] !== assignment[2]) throw new Error(`irf fix must resume the original implementer role in ${id}`);
  return { id, workflow, assignment: assignment as RoleKey[], checks: m[3] as CheckCondition };
}

/** Pure: the canonical condition ids implied by the matrix, in canonical order. */
export function expandConditions(matrix: MatrixConfig): string[] {
  const out: string[] = [];
  for (const kind of ['solo', 'pi', 'irf'] as const) {
    for (const a of matrix.workflows[kind].assignments) for (const c of matrix.checkConditions) out.push(`${kind}.${a.join('-')}.${c}`);
  }
  return out;
}

export function generateSchedule(matrix: MatrixConfig): Schedule {
  const canonical = matrix.canonicalConditionOrder;
  const expanded = expandConditions(matrix);
  if (canonical.length !== expanded.length || canonical.some((c, i) => c !== expanded[i])) {
    throw new Error('canonicalConditionOrder does not match the matrix workflows and assignments');
  }
  canonical.forEach(parseConditionId);
  if (matrix.schedule.prng !== 'mulberry32') throw new Error(`unsupported prng ${matrix.schedule.prng}`);
  if (matrix.schedule.concurrency !== 1) throw new Error('only concurrency one is supported');
  const rand = mulberry32(matrix.schedule.seed);
  const blocks = Array.from({ length: matrix.schedule.blocks }, (_, b) => ({
    block: b + 1,
    slots: shuffle(canonical, rand).map((conditionId, s) => ({ block: b + 1, slot: s + 1, conditionId })),
  }));
  return { schema: SCHEDULE_SCHEMA, cohort: matrix.cohort, seed: matrix.schedule.seed, prng: 'mulberry32', shuffle: 'fisher-yates-descending', concurrency: 1, blocks };
}

/** Unscored pilots: every configuration once, in canonical order, kept apart from scored blocks. */
export function pilotSlots(matrix: MatrixConfig): ScheduleSlot[] {
  return matrix.canonicalConditionOrder.map((conditionId, i) => ({ block: 0, slot: i + 1, conditionId }));
}

export const renderSchedule = (s: Schedule): string => `${JSON.stringify(s, null, 2)}\n`;
