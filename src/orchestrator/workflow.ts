/**
 * Runs one workflow attempt: the planned stages in order, artifact-only handoffs, the deterministic
 * feedback loop after implementing stages (checks `on` only), and the whole-workflow and per-stage
 * deadlines. Every boundary (adapters, checks, filesystem copies, persistence) is injected, so all
 * sequences are unit-testable without a coding CLI.
 *
 * Deadline rules (methodology section 7): a stage's deadline is its own budget from when it starts,
 * clipped to the workflow ceiling; unused time never rolls over. A model stage killed at its
 * deadline is `stage-timeout`, or `task-timeout` when the workflow ceiling, not the stage's own
 * budget, was the binding limit. Either is a scored failure.
 */
import { join } from 'node:path';
import type { RoleKey, StageRequest, StageResult, StageTermination } from '../adapters/types.ts';
import { OPERATIONAL_TERMINATIONS } from '../adapters/types.ts';
import { runFeedbackLoop, type RepairOutcome } from '../feedback/loop.ts';
import type { CheckRun } from '../feedback/types.ts';
import { StageLedger, type StagePlan } from './plan.ts';
import { makeHandoff, sha256, stagePrompt, type Handoff } from './prompts.ts';
import type { Condition } from './schedule.ts';
import type { StageSummary, TransitionEvent, WorkflowTermination } from './state.ts';

/** The isolation a stage launch runs under; built by the orchestrator, applied by the adapter. */
export type StageIsolationFactory = (o: { permission: StageRequest['permission']; workspaceDir: string; toolHome: string }) => StageRequest['isolation'];

export interface WorkflowDeps {
  /** Epoch milliseconds: the same clock the adapters use for `deadlineAt`. */
  now(): number;
  wallClock(): Date;
  runStage(req: StageRequest): Promise<StageResult>;
  runChecks(o: { workspaceDir: string; workDir: string; timeoutMs: number }): Promise<CheckRun>;
  /** Copies `from` into the new directory `to` (including .git and dependencies). */
  copyTree(from: string, to: string): void;
  /** Content hash of a workspace's own files (excludes .git, node_modules, dist, data). */
  treeHash(dir: string): string;
  writeText(path: string, text: string): void;
  /** Persisted (fsynced) before the runner acts on it. */
  transition(e: TransitionEvent): void;
  isolation?: StageIsolationFactory;
}

export interface WorkflowInput {
  /** Unique within the campaign; prefixes stage ids. */
  attemptKey: string;
  condition: Condition;
  plan: StagePlan[];
  roles: Record<RoleKey, { requestedModel: string; effort: string }>;
  task: string;
  /** Template text by file name (from `prompts/`). */
  templates: Record<string, string>;
  fragments: { on: string; off: string };
  repairTemplate: string;
  maxRepairs: number;
  workflowCeilingMs: number;
  checkCeilingMs: number;
  feedbackMaxBytes: number;
  /** The implementer workspace (already created), runtime scratch root, and committed record root. */
  dirs: { workspace: string; runtime: string; records: string };
}

export interface WorkflowOutcome {
  termination: WorkflowTermination;
  detail: string | null;
  startedAt: string;
  endedAt: string;
  activeMs: number;
  stages: StageSummary[];
  results: StageResult[];
  sensorRepairs: number;
  checkRuns: number;
  /** The implementer workspace whose final state is evaluated (null if none was produced). */
  finalWorkspace: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function mapStageTermination(t: StageTermination, o: { stageStart: number; budgetMs: number; workflowDeadline: number }): WorkflowTermination {
  if (t !== 'stage-timeout') return t;
  return o.workflowDeadline < o.stageStart + o.budgetMs ? 'task-timeout' : 'stage-timeout';
}

export async function runWorkflow(input: WorkflowInput, deps: WorkflowDeps): Promise<WorkflowOutcome> {
  const start = deps.now();
  const workflowDeadline = start + input.workflowCeilingMs;
  const stages: StageSummary[] = [];
  const results: StageResult[] = [];
  const ledger = new StageLedger(input.plan, input.maxRepairs);
  const sessions = new Map<string, { sessionId: string | null; toolHome: string; workspaceDir: string }>();
  let handoff: Handoff | null = null;
  let repairsUsed = 0;
  let checkRuns = 0;
  const emit = (type: string, fields: Record<string, unknown> = {}) => deps.transition({ at: deps.wallClock().toISOString(), type, ...fields });

  const end = (termination: WorkflowTermination, detail: string | null): WorkflowOutcome => {
    const endMs = deps.now();
    emit('workflow-ended', { termination, detail, sensorRepairs: repairsUsed });
    return {
      termination,
      detail,
      startedAt: iso(start),
      endedAt: iso(endMs),
      activeMs: endMs - start,
      stages,
      results,
      sensorRepairs: repairsUsed,
      checkRuns,
      finalWorkspace: stages.some((s) => s.kind === 'implement') ? input.dirs.workspace : null,
    };
  };

  /** One adapter invocation (principal stage or sensor repair), checkpointed before and after. */
  const invoke = async (
    sp: StagePlan,
    o: { id: string; kind: string; mode: StageRequest['mode']; prompt: string; workspaceDir: string; toolHome: string; deadlineAt: number; hashBefore: string | null },
  ): Promise<{ result: StageResult; summary: StageSummary }> => {
    const role = input.roles[sp.role];
    const stageId = `${input.attemptKey}--${o.id}`;
    const recordDir = join(input.dirs.records, 'stages', o.id);
    const req: StageRequest = {
      stageId,
      role: sp.role,
      requestedModel: role.requestedModel,
      effort: role.effort,
      permission: sp.permission,
      mode: o.mode,
      prompt: o.prompt,
      workspaceDir: o.workspaceDir,
      toolHome: o.toolHome,
      recordDir,
      deadlineAt: o.deadlineAt,
      isolation: deps.isolation?.({ permission: sp.permission, workspaceDir: o.workspaceDir, toolHome: o.toolHome }),
    };
    const promptSha256 = sha256(o.prompt);
    emit('stage-started', { stage: o.id, kind: o.kind, role: sp.role, mode: o.mode.kind, resumedSession: o.mode.kind === 'resume' ? o.mode.sessionId : null, promptSha256, workspaceHashBefore: o.hashBefore, deadlineAt: iso(o.deadlineAt) });
    const result = await deps.runStage(req);
    results.push(result);
    const summary: StageSummary = {
      id: o.id,
      kind: o.kind,
      role: sp.role,
      mode: o.mode.kind,
      resumedSession: o.mode.kind === 'resume' ? o.mode.sessionId : null,
      sessionId: result.sessionId,
      requestedModel: role.requestedModel,
      resolvedModel: result.resolvedModel,
      termination: result.termination,
      terminationDetail: result.terminationDetail,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      durationMs: result.durationMs,
      promptSha256,
      workspaceHashBefore: o.hashBefore,
      workspaceHashAfter: deps.treeHash(o.workspaceDir),
      handoff: null,
      usageCompleteness: result.usage.completeness,
      recordDir: `stages/${o.id}`,
    };
    stages.push(summary);
    emit('stage-ended', { stage: o.id, termination: result.termination, detail: result.terminationDetail, sessionId: result.sessionId, resolvedModel: result.resolvedModel, workspaceHashAfter: summary.workspaceHashAfter, usageCompleteness: result.usage.completeness });
    return { result, summary };
  };

  try {
    emit('workflow-started', { condition: input.condition.id, plan: input.plan.map((s) => s.id), workflowDeadline: iso(workflowDeadline) });
    for (const sp of input.plan) {
      ledger.startStage(sp.id);
      const stageStart = deps.now();
      if (stageStart >= workflowDeadline) return end('task-timeout', `workflow ceiling reached before ${sp.id}`);
      const stageDeadline = Math.min(stageStart + sp.budgetMs, workflowDeadline);
      const mapT = (t: StageTermination) => mapStageTermination(t, { stageStart, budgetMs: sp.budgetMs, workflowDeadline });

      let mode: StageRequest['mode'];
      let toolHome: string;
      let workspaceDir: string;
      if (sp.session.kind === 'resume') {
        const prior = sessions.get(sp.session.ofStage);
        if (!prior || !prior.sessionId) return end('runner-infrastructure-failure', `no session to resume for ${sp.id} (from ${sp.session.ofStage})`);
        mode = { kind: 'resume', sessionId: prior.sessionId };
        toolHome = prior.toolHome;
        workspaceDir = prior.workspaceDir;
      } else {
        mode = { kind: 'fresh' };
        toolHome = join(input.dirs.runtime, 'homes', sp.id);
        if (sp.permission === 'read-only') {
          // Read-only roles see an immutable copy, never the implementer's live workspace.
          workspaceDir = join(input.dirs.runtime, 'snapshots', sp.id);
          deps.copyTree(input.dirs.workspace, workspaceDir);
        } else {
          workspaceDir = input.dirs.workspace;
        }
      }

      const prompt = stagePrompt(sp, input.templates[sp.template] ?? missing(sp.template), { task: input.task, checks: input.condition.checks, fragments: input.fragments, handoff });
      const hashBefore = deps.treeHash(workspaceDir);
      const { result, summary } = await invoke(sp, { id: sp.id, kind: sp.kind, mode, prompt, workspaceDir, toolHome, deadlineAt: stageDeadline, hashBefore });

      if (OPERATIONAL_TERMINATIONS.has(result.termination)) return end(result.termination, result.terminationDetail);
      if (result.termination !== 'completed') return end(mapT(result.termination), result.terminationDetail);

      if (sp.produces) {
        if (summary.workspaceHashAfter !== hashBefore) return end('runner-infrastructure-failure', `read-only stage ${sp.id} changed its workspace copy`);
        handoff = makeHandoff(sp.produces, result.finalMessage, sp.handoffMaxBytes ?? Infinity);
        const file = handoff.text !== null ? `handoffs/${sp.produces}.md` : null;
        if (file && handoff.text !== null) deps.writeText(join(input.dirs.records, file), handoff.text);
        summary.handoff = { kind: handoff.kind, status: handoff.status, sha256: handoff.sha256, originalBytes: handoff.originalBytes, truncated: handoff.truncated, file };
        emit('handoff', { stage: sp.id, ...summary.handoff });
        if (handoff.status !== 'ok') return end('failed-required-handoff', `${sp.produces} ${handoff.status}`);
        continue;
      }

      if (!sp.implementing) continue;
      if (sp.session.kind === 'fresh') sessions.set(sp.id, { sessionId: result.sessionId, toolHome, workspaceDir });
      const own = sp.session.kind === 'resume' ? sessions.get(sp.session.ofStage)! : sessions.get(sp.id)!;

      const loop = await runFeedbackLoop(
        {
          checkCondition: input.condition.checks,
          position: sp.position ?? 'final',
          repairsUsed,
          maxRepairs: input.maxRepairs,
          stageDeadlineAt: stageDeadline,
          workflowDeadlineAt: workflowDeadline,
          checkCeilingMs: input.checkCeilingMs,
          feedbackMaxBytes: input.feedbackMaxBytes,
          replacements: { [input.dirs.runtime]: '<runner>', [input.dirs.workspace]: '.' },
        },
        {
          now: () => deps.now(),
          wallClock: () => deps.wallClock(),
          repairTemplate: input.repairTemplate,
          runChecks: async (timeoutMs) => {
            checkRuns += 1;
            const n = checkRuns;
            const run = await deps.runChecks({ workspaceDir: own.workspaceDir, workDir: join(input.dirs.runtime, 'checks', String(n)), timeoutMs });
            deps.writeText(join(input.dirs.records, 'checks', `${String(n).padStart(2, '0')}.json`), `${JSON.stringify(run, null, 2)}\n`);
            emit('checks', { stage: sp.id, run: n, status: run.status, snapshotHash: run.snapshotHash });
            return run;
          },
          repair: async (repairPrompt, ctx): Promise<RepairOutcome> => {
            if (own.sessionId === null) return { kind: 'ended', termination: 'runner-infrastructure-failure' };
            const index = ledger.startRepair(sp.id);
            const id = `${sp.id}-repair-${index}`;
            const r = await invoke(sp, {
              id,
              kind: 'sensor-repair',
              mode: { kind: 'resume', sessionId: own.sessionId },
              prompt: repairPrompt,
              workspaceDir: own.workspaceDir,
              toolHome: own.toolHome,
              deadlineAt: ctx.deadlineAt,
              hashBefore: deps.treeHash(own.workspaceDir),
            });
            if (r.result.termination === 'completed') return { kind: 'returned' };
            return { kind: 'ended', termination: OPERATIONAL_TERMINATIONS.has(r.result.termination) ? r.result.termination : mapT(r.result.termination) };
          },
        },
      );
      repairsUsed = loop.repairsUsed;
      emit('feedback-loop', { stage: sp.id, outcome: loop.outcome, termination: loop.termination, repairsUsed });
      if (loop.outcome === 'terminate') return end((loop.termination ?? 'runner-infrastructure-failure') as WorkflowTermination, `feedback loop after ${sp.id}`);
    }
    return end('completed', null);
  } catch (e) {
    return end('runner-infrastructure-failure', `runner error: ${(e as Error).message}`);
  }
}

function missing(name: string): never {
  throw new Error(`template ${name} not loaded`);
}
