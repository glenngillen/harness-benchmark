/**
 * Pure stage plans for the three workflows (methodology section 6). The plan is the only source of
 * stages: the runner executes it in order and its ledger refuses any stage the plan does not name,
 * so plan -> implement can never reach a reviewer and implement -> review -> fix always fixes with
 * its original implementer.
 */
import type { Permission, RoleKey } from '../adapters/types.ts';
import type { Condition, WorkflowKind } from './schedule.ts';

export type StageKind = 'plan' | 'implement' | 'review' | 'fix';
export type HandoffKind = 'plan' | 'findings';

export interface StagePlan {
  /** Zero-based position in the workflow; also names the stage (`s1-plan`, `s2-implement`, ...). */
  index: number;
  id: string;
  kind: StageKind;
  role: RoleKey;
  permission: Permission;
  /** Fresh session, or an explicit resume of the session an earlier stage started. */
  session: { kind: 'fresh' } | { kind: 'resume'; ofStage: string };
  template: string;
  budgetMs: number;
  /** Implementing stages are followed by the feedback loop (checks `on` only). */
  implementing: boolean;
  /** For implementing stages: is this the last implementing stage (completion gate)? */
  position: 'intermediate' | 'final' | null;
  /** Read-only stages work on an immutable copy of the workspace and return a handoff artifact. */
  produces: HandoffKind | null;
  consumes: HandoffKind | null;
  handoffMaxBytes: number | null;
}

export interface LimitsConfig {
  workflowCeilingMinutes: number;
  stageCeilingMinutes: { solo: { implement: number }; pi: { plan: number; implement: number }; irf: { implement: number; review: number; fix: number } };
  sensorRepairs: { maxPerWorkflow: number };
  evaluator: { ceilingMinutes: number };
  deterministicChecks: { ceilingSeconds: number };
  handoff: { planMaxBytes: number; reviewMaxBytes: number; reviewMaxFindings: number; sensorFeedbackMaxBytes: number };
  operationalReplacements: { maxPerSlot: number };
}

const MIN = 60_000;

export function workflowPlan(c: Condition, limits: LimitsConfig): StagePlan[] {
  const b = limits.stageCeilingMinutes;
  const stage = (index: number, kind: StageKind, role: RoleKey, rest: Omit<StagePlan, 'index' | 'id' | 'kind' | 'role'>): StagePlan => ({ index, id: `s${index + 1}-${kind}`, kind, role, ...rest });
  const plain = { produces: null, consumes: null, handoffMaxBytes: null } as const;
  switch (c.workflow) {
    case 'solo':
      return [stage(0, 'implement', c.assignment[0]!, { permission: 'workspace-write', session: { kind: 'fresh' }, template: 'solo-implement.md', budgetMs: b.solo.implement * MIN, implementing: true, position: 'final', ...plain })];
    case 'pi':
      return [
        stage(0, 'plan', c.assignment[0]!, { permission: 'read-only', session: { kind: 'fresh' }, template: 'plan.md', budgetMs: b.pi.plan * MIN, implementing: false, position: null, produces: 'plan', consumes: null, handoffMaxBytes: limits.handoff.planMaxBytes }),
        stage(1, 'implement', c.assignment[1]!, { permission: 'workspace-write', session: { kind: 'fresh' }, template: 'plan-implement.md', budgetMs: b.pi.implement * MIN, implementing: true, position: 'final', produces: null, consumes: 'plan', handoffMaxBytes: limits.handoff.planMaxBytes }),
      ];
    case 'irf':
      return [
        stage(0, 'implement', c.assignment[0]!, { permission: 'workspace-write', session: { kind: 'fresh' }, template: 'irf-implement.md', budgetMs: b.irf.implement * MIN, implementing: true, position: 'intermediate', ...plain }),
        stage(1, 'review', c.assignment[1]!, { permission: 'read-only', session: { kind: 'fresh' }, template: 'review.md', budgetMs: b.irf.review * MIN, implementing: false, position: null, produces: 'findings', consumes: null, handoffMaxBytes: limits.handoff.reviewMaxBytes }),
        stage(2, 'fix', c.assignment[2]!, { permission: 'workspace-write', session: { kind: 'resume', ofStage: 's1-implement' }, template: 'fix.md', budgetMs: b.irf.fix * MIN, implementing: true, position: 'final', produces: null, consumes: 'findings', handoffMaxBytes: limits.handoff.reviewMaxBytes }),
      ];
  }
}

/** Pure: the stage kinds a workflow may run, for the ledger and for tests. */
export const STAGE_SEQUENCE: Record<WorkflowKind, StageKind[]> = { solo: ['implement'], pi: ['plan', 'implement'], irf: ['implement', 'review', 'fix'] };

export type LedgerEntry = { type: 'stage'; id: string } | { type: 'repair'; ofStage: string };

/**
 * Refuses any invocation the plan does not allow: stages out of order or repeated, a repair after a
 * non-implementing stage or a stage other than the one just run, and more than `maxRepairs` repairs.
 */
export class StageLedger {
  private next = 0;
  private repairs = 0;
  private current: StagePlan | null = null;
  readonly entries: LedgerEntry[] = [];
  private readonly plan: readonly StagePlan[];
  private readonly maxRepairs: number;
  constructor(plan: readonly StagePlan[], maxRepairs: number) {
    this.plan = plan;
    this.maxRepairs = maxRepairs;
  }

  startStage(id: string): StagePlan {
    const expected = this.plan[this.next];
    if (!expected || expected.id !== id) throw new Error(`stage ${id} is not scheduled next (expected ${expected?.id ?? 'none'})`);
    this.next += 1;
    this.current = expected;
    this.entries.push({ type: 'stage', id });
    return expected;
  }

  startRepair(ofStage: string): number {
    if (!this.current || this.current.id !== ofStage || !this.current.implementing) throw new Error(`repair of ${ofStage} is not allowed here`);
    if (this.repairs >= this.maxRepairs) throw new Error(`repair limit ${this.maxRepairs} reached`);
    this.repairs += 1;
    this.entries.push({ type: 'repair', ofStage });
    return this.repairs;
  }

  get repairsUsed(): number {
    return this.repairs;
  }
}
