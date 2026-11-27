/**
 * Provider-neutral contract between the orchestrator and a native coding-CLI adapter. One call is
 * one principal stage invocation (plan, implement, review, fix, or a sensor repair): either a fresh
 * session or an explicit resume of a known session. The adapter never chooses a session itself.
 */
export type RoleKey = 'CF' | 'CC' | 'AF' | 'AC';
export type Permission = 'read-only' | 'workspace-write';
export type StageMode = { kind: 'fresh' } | { kind: 'resume'; sessionId: string };

export interface StageRequest {
  /** Unique within the campaign; names the capture and record directories. */
  stageId: string;
  role: RoleKey;
  requestedModel: string;
  effort: string;
  permission: Permission;
  mode: StageMode;
  prompt: string;
  /** The workflow's Git workspace (the only directory the stage may write when permitted). */
  workspaceDir: string;
  /** Isolated tool home for this session, inside the worktree. A resume must reuse the original. */
  toolHome: string;
  /** Committed, secrets-scrubbed record directory for this stage. */
  recordDir: string;
  /** Absolute epoch milliseconds. */
  deadlineAt: number;
  /**
   * OS-level isolation the orchestrator applies around the CLI launch (src/orchestrator/isolation.ts).
   * Absent in adapter unit tests and preflights; required for scored and pilot stages.
   */
  isolation?: StageIsolation;
}

export interface StageIsolation {
  mechanism: 'sandbox-exec' | 'bwrap' | 'none';
  /** Prefixes the CLI argv with the sandbox launcher. */
  wrap(argv: string[]): string[];
  /** Recorded in the stage settings as isolation evidence (paths are recorded in public form). */
  describe(): Record<string, unknown>;
}

/** Applies a stage's isolation to a launch; identity when none is supplied. */
export function isolatedLaunch(req: Pick<StageRequest, 'isolation'>, cmd: string, args: string[]): { cmd: string; args: string[] } {
  if (!req.isolation) return { cmd, args };
  const [c, ...a] = req.isolation.wrap([cmd, ...args]);
  return { cmd: c!, args: a };
}

/** Closed vocabulary shared with config/limits.json `termination`. `completed` means the CLI returned normally. */
export type StageTermination =
  | 'completed'
  | 'stage-timeout'
  | 'model-error-exit'
  | 'auth-missing'
  | 'quota-exhausted'
  | 'provider-outage'
  | 'model-substituted'
  | 'runner-infrastructure-failure';

export const OPERATIONAL_TERMINATIONS: ReadonlySet<StageTermination> = new Set(['auth-missing', 'quota-exhausted', 'provider-outage', 'model-substituted', 'runner-infrastructure-failure']);

export type Completeness = 'complete' | 'partial' | 'missing';

export interface StageResult {
  stageId: string;
  role: RoleKey;
  provider: 'openai' | 'anthropic';
  tool: 'codex' | 'claude-code';
  toolVersion: string | null;
  mode: StageMode['kind'];
  requestedModel: string;
  /** What the client reported serving, or null when it exposed nothing. */
  resolvedModel: string | null;
  resolvedModelSource: string;
  requestedEffort: string;
  appliedEffort: string | null;
  sessionId: string | null;
  termination: StageTermination;
  /** Free-text qualifier, for example `version-mismatch`, `model-access`, `api-key-auth`. Never contains secrets. */
  terminationDetail: string | null;
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Final agent message (the plan/review artifact for read-only stages), scrubbed. */
  finalMessage: string | null;
  usage: UsageCapture;
  /** Files written into `recordDir`, relative to it. */
  recordFiles: string[];
  /** Effective native settings, recorded for the freeze manifest. */
  settings: Record<string, unknown>;
}

export interface UsageCapture {
  /** Where the counters came from. */
  source: string;
  /** How the counters relate to this invocation; `unverified` until a pilot settles it. */
  semantics: string;
  completeness: Completeness;
  /** Raw counter objects in emission order, verbatim (numbers only; no prompt text). */
  raw: unknown[];
  /** Supplementary counters (for example session-cumulative totals before and after a resume). */
  supplementary?: Record<string, unknown>;
}
