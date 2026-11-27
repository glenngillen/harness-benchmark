/**
 * Default wiring of the orchestrator to the real boundaries: the pinned Codex and Claude Code
 * adapters, the protected deterministic checks, the supervised independent evaluator, the stage
 * sandbox, and fresh workspaces. Everything here is configuration; the behaviour lives in
 * workflow.ts and campaign.ts, which are unit-tested with doubles.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_CLAUDE_AUTH_HOME, DEFAULT_CLAUDE_BIN, runClaudeStage } from '../adapters/claude.ts';
import { DEFAULT_AUTH_HOME, DEFAULT_CODEX_BIN, runCodexStage } from '../adapters/codex.ts';
import type { RoleKey, StageRequest, StageResult } from '../adapters/types.ts';
import { hiddenRoots, publicPath } from '../evaluator/evaluate.ts';
import { usableSandboxTool, type IsolationMode } from '../evaluator/sandbox.ts';
import { superviseEvaluation } from '../evaluator/supervise.ts';
import { runDeterministicChecks } from '../feedback/checks.ts';
import { BENCHMARK_ROOT } from '../fixtures.ts';
import { pilotLeftUnexercised } from '../freeze/pilot-attempt.ts';
import { auditOverlay } from '../audit/files.ts';
import type { CampaignConfig, CampaignDeps } from './campaign.ts';
import { buildStageIsolation, stageReadable, stageSandboxPaths } from './isolation.ts';
import { workflowPlan, type LimitsConfig } from './plan.ts';
import { parseConditionId, type MatrixConfig, type Schedule, type ScheduleSlot } from './schedule.ts';
import { captureEnvironment, defaultEnvironmentDeps } from './environment.ts';
import { appendJsonl } from './state.ts';
import { runWorkflow, type WorkflowDeps, type WorkflowInput, type WorkflowOutcome } from './workflow.ts';
import { copyTree, createWorkspace, workspaceHash } from './workspace.ts';

interface ModelsConfig {
  roles: Record<RoleKey, { tool: 'codex' | 'claude-code'; toolVersion: string; requestedModel: string; effort: string }>;
}

export interface LoadedConfig {
  matrix: MatrixConfig;
  limits: LimitsConfig;
  models: ModelsConfig;
  schedule: Schedule;
}

const readJsonFile = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

export function loadConfig(root = BENCHMARK_ROOT): LoadedConfig {
  return {
    matrix: readJsonFile(join(root, 'config', 'matrix.json')),
    limits: readJsonFile(join(root, 'config', 'limits.json')),
    models: readJsonFile(join(root, 'config', 'models.json')),
    schedule: readJsonFile(join(root, 'config', 'schedule.json')),
  };
}

export function loadPrompts(root = BENCHMARK_ROOT): { templates: Record<string, string>; fragments: { on: string; off: string }; repairTemplate: string; task: string } {
  const p = (f: string) => readFileSync(join(root, 'prompts', f), 'utf8');
  const templates = Object.fromEntries(['solo-implement.md', 'plan.md', 'plan-implement.md', 'irf-implement.md', 'review.md', 'fix.md'].map((f) => [f, p(f)]));
  return {
    templates,
    fragments: { on: p('fragments/checks-on.md'), off: p('fragments/checks-off.md') },
    repairTemplate: p('sensor-repair.md'),
    task: readFileSync(join(root, 'fixtures', 'scaffold', 'TASK.md'), 'utf8'),
  };
}

/** PATH for CLIs and the commands they run: the Node.js install first, then system directories only. */
export function stagePath(nodeExecPath = process.execPath, exists: (p: string) => boolean = existsSync): string {
  return [dirname(nodeExecPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter((d, i, a) => a.indexOf(d) === i && exists(d)).join(':');
}

export interface RunOptions {
  label: string;
  slots: ScheduleSlot[];
  isolation: IsolationMode;
  root?: string;
  outageBackoffMs?: number;
  /** Pilots only: start a fresh attempt for a configuration whose finished pilots never exercised it. */
  retryUnexercisedPilots?: boolean;
}

export function defaultCampaign(o: RunOptions): { cfg: CampaignConfig; deps: CampaignDeps } {
  const root = o.root ?? BENCHMARK_ROOT;
  const conf = loadConfig(root);
  const prompts = loadPrompts(root);
  const path = stagePath();
  const scaffoldDir = join(root, 'fixtures', 'scaffold');
  const hidden = hiddenRoots(root);
  const readable = stageReadable(root);
  const tools = { sandboxExec: usableSandboxTool('sandbox-exec'), bwrap: usableSandboxTool('bwrap') };
  const pub = (p: string) => publicPath(p, root);

  const runStage = (req: StageRequest): Promise<StageResult> => {
    const role = conf.models.roles[req.role];
    if (role.tool === 'codex') return runCodexStage(req, { bin: DEFAULT_CODEX_BIN(root), toolVersion: role.toolVersion, authHome: DEFAULT_AUTH_HOME(root), path });
    return runClaudeStage(req, { bin: DEFAULT_CLAUDE_BIN(root), toolVersion: role.toolVersion, authHome: DEFAULT_CLAUDE_AUTH_HOME(root), path });
  };

  const cfg: CampaignConfig = {
    label: o.label,
    slots: o.slots,
    maxReplacements: conf.limits.operationalReplacements.maxPerSlot,
    recordsRoot: join(root, 'records', o.label),
    // Real path: sandbox profiles match resolved paths, so runtime directories must not go through symlinks.
    runtimeRoot: realRuntimeRoot(join(root, '.runs', 'campaign', o.label)),
    outageBackoffMs: o.outageBackoffMs ?? 5 * 60_000,
  };
  // Quota audit decisions (records/<label>/block-NN/audit.json): a reclassified attempt is refilled.
  cfg.effectiveRecord = auditOverlay(root, cfg.recordsRoot);
  if (o.retryUnexercisedPilots) {
    // Same test the freeze gate applies (`pilot-exercise`), against the runner's own stage plan.
    cfg.pilotRetry = { unexercised: pilotLeftUnexercised(conf.limits) };
  }

  const envDeps = defaultEnvironmentDeps(root);
  const deps: CampaignDeps = {
    environment: () => captureEnvironment(envDeps),
    now: () => Date.now(),
    wallClock: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    freeze: (workspace, dest) => {
      copyTree(workspace, dest);
      return workspaceHash(dest);
    },
    evaluate: (e) => superviseEvaluation({ ...e, isolation: o.isolation, ceilingMs: conf.limits.evaluator.ceilingMinutes * 60_000 }),
    copyFile: (from, to) => {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    },
    runAttempt: async (ctx): Promise<WorkflowOutcome> => {
      const condition = parseConditionId(ctx.slot.conditionId);
      const workspace = join(ctx.runtimeDir, 'workspace');
      const transitions = join(ctx.recordsDir, 'transitions.jsonl');
      const wdeps: WorkflowDeps = {
        now: () => Date.now(),
        wallClock: () => new Date(),
        runStage,
        runChecks: (c) => runDeterministicChecks({ ...c, isolation: o.isolation, scaffoldDir }),
        copyTree,
        treeHash: workspaceHash,
        writeText: (p, t) => {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, t);
        },
        transition: (e) => appendJsonl(transitions, e),
        isolation: (s) =>
          buildStageIsolation(o.isolation, process.platform, tools, stageSandboxPaths({ permission: s.permission, workspaceDir: s.workspaceDir, toolHome: s.toolHome, hidden, readable }), pub),
      };
      try {
        const created = createWorkspace(scaffoldDir, workspace, { path, gitHome: join(ctx.runtimeDir, 'git-home') });
        appendJsonl(transitions, { at: new Date().toISOString(), type: 'workspace-created', scaffoldHash: created.scaffoldHash, files: created.files });
      } catch (e) {
        const at = new Date().toISOString();
        appendJsonl(transitions, { at, type: 'workflow-ended', termination: 'runner-infrastructure-failure', detail: (e as Error).message });
        return { termination: 'runner-infrastructure-failure', detail: `workspace: ${(e as Error).message}`, startedAt: at, endedAt: at, activeMs: 0, stages: [], results: [], sensorRepairs: 0, checkRuns: 0, finalWorkspace: null };
      }
      const input: WorkflowInput = {
        attemptKey: ctx.attemptKey,
        condition,
        plan: workflowPlan(condition, conf.limits),
        roles: conf.models.roles,
        ...prompts,
        maxRepairs: conf.limits.sensorRepairs.maxPerWorkflow,
        workflowCeilingMs: conf.limits.workflowCeilingMinutes * 60_000,
        checkCeilingMs: conf.limits.deterministicChecks.ceilingSeconds * 1000,
        feedbackMaxBytes: conf.limits.handoff.sensorFeedbackMaxBytes,
        dirs: { workspace, runtime: ctx.runtimeDir, records: ctx.recordsDir },
      };
      return runWorkflow(input, wdeps);
    },
  };
  return { cfg, deps };
}

function realRuntimeRoot(p: string): string {
  mkdirSync(p, { recursive: true });
  return realpathSync(p);
}
