/**
 * Subscription-backed Codex CLI adapter (methodology sections 4, 9 and 12).
 *
 * One invocation is `codex exec --json` (fresh) or `codex exec resume <UUID> --json` (explicit
 * resume; `--last` is never used). Everything Codex reads lives in an isolated tool home inside the
 * worktree: `CODEX_HOME` and `HOME` both point there, the environment is built from scratch (no
 * `OPENAI_API_KEY`/`CODEX_API_KEY`, nothing from the operator's shell), `--ignore-user-config` and
 * `--ignore-rules` skip config.toml and execpolicy rules, and every effective setting is passed as
 * an explicit flag or `-c` override so it is recorded rather than inherited.
 *
 * Authentication is the user's ChatGPT subscription login, held in a dedicated isolated auth home
 * (default `.runs/auth/codex`, gitignored) that a human populates once with
 * `CODEX_HOME=<that dir> npx codex login`. Each stage home receives a private copy of `auth.json`;
 * a token refreshed during the stage is written back, so the auth home stays current. Credentials
 * never enter records or handoffs, and no other directory is read as a fallback. A home logged in
 * with an API key is refused (no paid API usage).
 *
 * Usage capture is per invocation: the stage's own JSONL stdout (`turn.completed.usage`), plus the
 * session rollout's cumulative `token_count` totals before and after, kept as supplementary raw
 * counters. Whether `turn.completed` is per-turn or session-cumulative on resume is recorded as
 * unverified until the pilot settles it; normalisation is a later slice and must not guess.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultProcessDeps, runSupervised, type ProcessDeps, type ProcessOutcome } from './process.ts';
import { scrubSecrets } from './scrub.ts';
import type { Completeness, StageRequest, StageResult, StageTermination } from './types.ts';
import { isolatedLaunch } from './types.ts';

export const CODEX_USAGE_SEMANTICS = 'turn.completed usage summed within this invocation; per-turn vs session-cumulative on resume is unverified until the pilot (methodology 9)';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFLIGHT_MS = 30_000;

export interface CodexConfig {
  /** Path to the pinned CLI, normally `node_modules/.bin/codex`. */
  bin: string;
  /** Required `codex --version` pin, for example `0.169.0`. */
  toolVersion: string;
  /** Isolated CODEX_HOME holding the subscription login (inside the worktree). */
  authHome: string;
  /** PATH given to Codex and the commands it runs. */
  path: string;
  graceMs?: number;
}

export interface CodexDeps {
  process: ProcessDeps;
  /** Reads a captured file; injectable so process doubles need not touch disk. */
  readText: (path: string) => string | null;
}

export const defaultCodexDeps: CodexDeps = {
  process: defaultProcessDeps,
  readText: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
};

export const codexHomeDirs = (toolHome: string) => ({
  codexHome: join(toolHome, 'codex'),
  home: join(toolHome, 'home'),
  tmp: join(toolHome, 'tmp'),
  capture: join(toolHome, 'capture'),
});

/** Pure: the complete environment for a Codex invocation. Nothing is inherited. */
export function codexEnv(o: { path: string; toolHome: string }): Record<string, string> {
  const d = codexHomeDirs(o.toolHome);
  return {
    PATH: o.path,
    HOME: d.home,
    CODEX_HOME: d.codexHome,
    TMPDIR: d.tmp,
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
    npm_config_cache: join(d.home, '.npm'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
}

/** Pure: the effective settings passed explicitly, recorded verbatim. */
/**
 * Codex's own sandbox on macOS is Seatbelt, which cannot be applied inside another Seatbelt sandbox.
 * When the orchestrator already confines the whole CLI with sandbox-exec (read-only workspace for
 * planners and reviewers, workspace-only writes for implementers, evaluator and home hidden), the
 * native sandbox is set to `danger-full-access` and the outer sandbox enforces the stage permission.
 * Otherwise (bwrap, or no outer sandbox) the native sandbox applies the stage permission itself.
 */
export function codexNativeSandbox(req: Pick<StageRequest, 'permission' | 'isolation'>): string {
  return req.isolation?.mechanism === 'sandbox-exec' ? 'danger-full-access' : req.permission;
}

export function codexSettings(req: Pick<StageRequest, 'requestedModel' | 'effort' | 'permission' | 'isolation'>): Record<string, string> {
  return {
    model: req.requestedModel,
    model_reasoning_effort: req.effort,
    approval_policy: 'never',
    sandbox_mode: codexNativeSandbox(req),
    stage_permission: req.permission,
    outer_isolation: req.isolation?.mechanism ?? 'none',
    'sandbox_workspace_write.network_access': 'false',
  };
}

const tomlString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Pure: argv for a stage. The prompt always arrives on stdin (`-`). */
export function codexArgs(req: Pick<StageRequest, 'requestedModel' | 'effort' | 'permission' | 'mode' | 'workspaceDir' | 'isolation'>, lastMessagePath: string): string[] {
  const sandbox = codexNativeSandbox(req);
  const common = [
    '--json',
    '--ignore-user-config',
    '--ignore-rules',
    '-m',
    req.requestedModel,
    '-c',
    `model_reasoning_effort=${tomlString(req.effort)}`,
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-o',
    lastMessagePath,
  ];
  if (req.mode.kind === 'fresh') return ['exec', ...common, '--sandbox', sandbox, '-C', req.workspaceDir, '-'];
  if (!UUID.test(req.mode.sessionId)) throw new Error(`resume requires an explicit session UUID, got ${JSON.stringify(req.mode.sessionId)}`);
  // `exec resume` has no --sandbox/-C: the sandbox is a config override and the cwd is the workspace.
  return ['exec', 'resume', ...common, '-c', `sandbox_mode=${tomlString(sandbox)}`, req.mode.sessionId, '-'];
}

export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  [k: string]: unknown;
}

export interface ParsedCodexEvents {
  threadId: string | null;
  finalMessage: string | null;
  turnUsages: CodexUsage[];
  turnsStarted: number;
  turnsCompleted: number;
  failures: string[];
  models: string[];
  malformedLines: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const errText = (v: unknown): string | null => (typeof v === 'string' ? v : isObj(v) && typeof v.message === 'string' ? v.message : null);

/** Pure: parse a `--json` stream. Unknown events are ignored; malformed lines are counted, never fatal. */
export function parseCodexEvents(text: string): ParsedCodexEvents {
  const p: ParsedCodexEvents = { threadId: null, finalMessage: null, turnUsages: [], turnsStarted: 0, turnsCompleted: 0, failures: [], models: [], malformedLines: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      p.malformedLines++;
      continue;
    }
    if (!isObj(ev) || typeof ev.type !== 'string') {
      p.malformedLines++;
      continue;
    }
    if (typeof ev.model === 'string') p.models.push(ev.model);
    switch (ev.type) {
      case 'thread.started':
        if (typeof ev.thread_id === 'string') p.threadId = ev.thread_id;
        break;
      case 'turn.started':
        p.turnsStarted++;
        break;
      case 'turn.completed':
        p.turnsCompleted++;
        if (isObj(ev.usage)) p.turnUsages.push(ev.usage as CodexUsage);
        break;
      case 'turn.failed': {
        p.failures.push(errText(ev.error) ?? 'turn.failed');
        break;
      }
      case 'error':
        p.failures.push(errText(ev.message) ?? errText(ev.error) ?? 'error');
        break;
      case 'item.completed':
        if (isObj(ev.item) && ev.item.type === 'agent_message' && typeof ev.item.text === 'string') p.finalMessage = ev.item.text;
        break;
    }
  }
  return p;
}

export type FailureClass = 'quota-exhausted' | 'auth-missing' | 'model-access' | 'provider-outage';

const FAILURE_PATTERNS: Array<[FailureClass, RegExp]> = [
  ['quota-exhausted', /usage[ _]limit|usage_limit_reached|quota|rate[ _-]?limit|too many requests|\b429\b|try again (?:at|in)/i],
  ['auth-missing', /not logged in|unauthori[sz]ed|\b401\b|\b403\b|forbidden|log ?in again|codex login|refresh token|token (?:has )?expired|authentication/i],
  ['model-access', /model\b.*\b(?:not found|does not exist|not supported|unavailable|not available|no access)|unknown model|invalid model/i],
  ['provider-outage', /\b50[0234]\b|internal server error|bad gateway|service unavailable|gateway timeout|overloaded|stream disconnected|connection (?:reset|refused|closed)|network error|timed out connecting|dns/i],
];

/** Pure: classify CLI failure text into an operational cause, or null when it is not recognisable. */
export function classifyCodexFailure(texts: string[]): FailureClass | null {
  const joined = texts.join('\n');
  for (const [cls, re] of FAILURE_PATTERNS) if (re.test(joined)) return cls;
  return null;
}

export interface RolloutSummary {
  models: string[];
  efforts: string[];
  /** Session-cumulative totals from `token_count` events, in order. */
  totals: Record<string, number>[];
  lines: number;
}

/** Pure: read model, effort, and cumulative token totals from a session rollout file. */
export function parseRollout(text: string): RolloutSummary {
  const s: RolloutSummary = { models: [], efforts: [], totals: [], lines: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    s.lines++;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(ev) || !isObj(ev.payload)) continue;
    const pl = ev.payload;
    if (ev.type === 'turn_context') {
      if (typeof pl.model === 'string') s.models.push(pl.model);
      const effort = pl.effort ?? pl.reasoning_effort ?? pl.model_reasoning_effort;
      if (typeof effort === 'string') s.efforts.push(effort);
    } else if (ev.type === 'session_meta' && typeof pl.model === 'string') {
      s.models.push(pl.model);
    } else if (ev.type === 'event_msg' && pl.type === 'token_count' && isObj(pl.info) && isObj(pl.info.total_token_usage)) {
      const t: Record<string, number> = {};
      for (const [k, v] of Object.entries(pl.info.total_token_usage)) if (typeof v === 'number' && Number.isFinite(v)) t[k] = v;
      s.totals.push(t);
    }
  }
  return s;
}

/** Locate the rollout for a session inside the isolated CODEX_HOME only. */
export function findRollout(codexHome: string, sessionId: string): string | null {
  const root = join(codexHome, 'sessions');
  if (!existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) stack.push(p);
      else if (name.endsWith('.jsonl') && name.includes(sessionId)) return p;
    }
  }
  return null;
}

/** Pure: whether `codex --version` output matches the pin exactly. */
export function versionMatches(output: string, pin: string): { ok: boolean; observed: string | null } {
  const m = /codex-cli\s+(\S+)/.exec(output);
  const observed = m?.[1] ?? null;
  return { ok: observed === pin, observed };
}

export type LoginMode = 'chatgpt' | 'api-key' | 'none' | 'unknown';

/** Pure: interpret `codex login status`. */
export function loginMode(output: string): LoginMode {
  if (/not logged in/i.test(output)) return 'none';
  if (/api key/i.test(output)) return 'api-key';
  if (/chatgpt/i.test(output)) return 'chatgpt';
  return 'unknown';
}

export interface OutcomeInput {
  proc: ProcessOutcome;
  events: ParsedCodexEvents;
  stderr: string;
  mode: StageRequest['mode'];
  requestedModel: string;
  resolvedModel: string | null;
}

/** Pure: the stage termination. Recognised operational causes win over exit status. */
export function decideCodexTermination(i: OutcomeInput): { termination: StageTermination; detail: string | null } {
  if (i.proc.spawnError !== null) return { termination: 'runner-infrastructure-failure', detail: `spawn: ${i.proc.spawnError}` };
  const failureTexts = [...i.events.failures, ...(i.proc.exitCode !== 0 || i.events.failures.length ? [i.stderr] : [])];
  const cls = classifyCodexFailure(failureTexts);
  if (cls === 'model-access') return { termination: 'auth-missing', detail: 'model-access' };
  if (cls) return { termination: cls, detail: null };
  if (i.proc.timedOut) return { termination: 'stage-timeout', detail: null };
  if (i.proc.exitCode !== 0) return { termination: 'model-error-exit', detail: `exit ${i.proc.exitCode ?? i.proc.signal}` };
  if (i.events.failures.length) return { termination: 'model-error-exit', detail: 'turn.failed' };
  if (i.mode.kind === 'fresh' && i.events.threadId === null) return { termination: 'runner-infrastructure-failure', detail: 'no session id in output' };
  if (i.mode.kind === 'resume' && i.events.threadId !== null && i.events.threadId !== i.mode.sessionId) {
    return { termination: 'runner-infrastructure-failure', detail: 'resumed a different session' };
  }
  if (i.resolvedModel !== null && i.resolvedModel !== i.requestedModel) return { termination: 'model-substituted', detail: `served ${i.resolvedModel}` };
  return { termination: 'completed', detail: null };
}

/** Pure: usage completeness for the invocation. */
export function usageCompleteness(termination: StageTermination, events: ParsedCodexEvents): Completeness {
  if (events.turnUsages.length === 0) return 'missing';
  if (termination !== 'completed' && termination !== 'model-substituted') return 'partial';
  return events.turnsCompleted >= Math.max(1, events.turnsStarted) ? 'complete' : 'partial';
}

/** Create the isolated home directories (idempotent; a resume reuses the original home). */
export function prepareCodexHome(toolHome: string): void {
  const d = codexHomeDirs(toolHome);
  for (const p of [d.codexHome, d.home, d.tmp, d.capture]) mkdirSync(p, { recursive: true, mode: 0o700 });
}

/** Copy the subscription login into a stage home. Returns false when the auth home has none. */
export function provisionAuth(authHome: string, toolHome: string): boolean {
  const src = join(authHome, 'auth.json');
  if (!existsSync(src)) return false;
  const dst = join(codexHomeDirs(toolHome).codexHome, 'auth.json');
  copyFileSync(src, dst);
  return true;
}

/** Write a token refreshed during the stage back to the auth home (atomic rename). */
export function syncAuthBack(toolHome: string, authHome: string): boolean {
  const src = join(codexHomeDirs(toolHome).codexHome, 'auth.json');
  const dst = join(authHome, 'auth.json');
  if (!existsSync(src) || !existsSync(dst)) return false;
  const next = readFileSync(src);
  if (next.equals(readFileSync(dst))) return false;
  const tmp = `${dst}.${process.pid}.tmp`;
  writeFileSync(tmp, next, { mode: 0o600 });
  renameSync(tmp, dst);
  return true;
}

/** Remove the credential copy from a home whose sessions will not be resumed again. */
export function removeAuth(toolHome: string): void {
  rmSync(join(codexHomeDirs(toolHome).codexHome, 'auth.json'), { force: true });
}

const iso = (ms: number) => new Date(ms).toISOString();

interface ProbeResult {
  out: string;
  proc: ProcessOutcome;
}

async function probe(cfg: CodexConfig, toolHome: string, args: string[], name: string, deps: CodexDeps): Promise<ProbeResult> {
  const d = codexHomeDirs(toolHome);
  const stdoutPath = join(d.capture, `${name}.out`);
  const stderrPath = join(d.capture, `${name}.err`);
  const proc = await runSupervised(
    { cmd: cfg.bin, args, cwd: d.home, env: codexEnv({ path: cfg.path, toolHome }), stdin: '', stdoutPath, stderrPath, deadlineAt: deps.process.now() + PREFLIGHT_MS, graceMs: 1_000 },
    deps.process,
  );
  return { proc, out: `${deps.readText(stdoutPath) ?? ''}\n${deps.readText(stderrPath) ?? ''}` };
}

export interface PreflightResult {
  ok: boolean;
  toolVersion: string | null;
  loginMode: LoginMode | null;
  termination: StageTermination | null;
  detail: string | null;
}

/** Version pin, then subscription login, both against the isolated home. No model is invoked. */
export async function preflightCodex(cfg: CodexConfig, toolHome: string, deps: CodexDeps = defaultCodexDeps): Promise<PreflightResult> {
  prepareCodexHome(toolHome);
  const v = await probe(cfg, toolHome, ['--version'], 'version', deps);
  const vm = versionMatches(v.out, cfg.toolVersion);
  if (v.proc.spawnError || !vm.ok) {
    return { ok: false, toolVersion: vm.observed, loginMode: null, termination: 'runner-infrastructure-failure', detail: v.proc.spawnError ? `spawn: ${v.proc.spawnError}` : `version-mismatch: want ${cfg.toolVersion}, got ${vm.observed}` };
  }
  if (!provisionAuth(cfg.authHome, toolHome)) {
    return { ok: false, toolVersion: vm.observed, loginMode: 'none', termination: 'auth-missing', detail: 'isolated auth home has no login' };
  }
  const l = await probe(cfg, toolHome, ['login', 'status'], 'login-status', deps);
  const mode = loginMode(l.out);
  if (mode === 'chatgpt') return { ok: true, toolVersion: vm.observed, loginMode: mode, termination: null, detail: null };
  removeAuth(toolHome);
  if (mode === 'api-key') return { ok: false, toolVersion: vm.observed, loginMode: mode, termination: 'auth-missing', detail: 'api-key-auth refused (subscription login required)' };
  return { ok: false, toolVersion: vm.observed, loginMode: mode, termination: 'auth-missing', detail: mode === 'none' ? 'not logged in' : 'login status unrecognised' };
}

function emptyResult(req: StageRequest, pre: PreflightResult, at: number, settings: Record<string, unknown>): StageResult {
  return {
    stageId: req.stageId,
    role: req.role,
    provider: 'openai',
    tool: 'codex',
    toolVersion: pre.toolVersion,
    mode: req.mode.kind,
    requestedModel: req.requestedModel,
    resolvedModel: null,
    resolvedModelSource: 'unavailable',
    requestedEffort: req.effort,
    appliedEffort: null,
    sessionId: req.mode.kind === 'resume' ? req.mode.sessionId : null,
    termination: pre.termination ?? 'runner-infrastructure-failure',
    terminationDetail: pre.detail,
    exitCode: null,
    signal: null,
    startedAt: iso(at),
    endedAt: iso(at),
    durationMs: 0,
    finalMessage: null,
    usage: { source: 'none (stage not launched)', semantics: CODEX_USAGE_SEMANTICS, completeness: 'missing', raw: [] },
    recordFiles: [],
    settings,
  };
}

const last = <T>(xs: T[]): T | null => (xs.length ? xs[xs.length - 1]! : null);

/** Run one stage: preflight, launch, capture, scrub into the record directory, classify. */
export async function runCodexStage(req: StageRequest, cfg: CodexConfig, deps: CodexDeps = defaultCodexDeps): Promise<StageResult> {
  const toolHome = resolve(req.toolHome);
  const settings: Record<string, unknown> = { ...codexSettings(req), ignoreUserConfig: true, ignoreRules: true, ephemeral: false, resumeLatest: 'never', fallbackModel: 'none (Codex has no fallback option)', env: Object.keys(codexEnv({ path: cfg.path, toolHome })).sort(), isolation: req.isolation ? req.isolation.describe() : { mechanism: 'none', note: 'no orchestrator isolation supplied' } };
  const pre = await preflightCodex(cfg, toolHome, deps);
  mkdirSync(req.recordDir, { recursive: true });
  if (!pre.ok) {
    const r = emptyResult(req, pre, deps.process.now(), settings);
    writeFileSync(join(req.recordDir, 'stage.json'), `${JSON.stringify(r, null, 2)}\n`);
    return { ...r, recordFiles: ['stage.json'] };
  }

  const d = codexHomeDirs(toolHome);
  const cap = join(d.capture, req.stageId);
  mkdirSync(cap, { recursive: true, mode: 0o700 });
  const paths = { stdout: join(cap, 'events.jsonl'), stderr: join(cap, 'stderr.txt'), last: join(cap, 'last-message.md') };

  const priorRollout = req.mode.kind === 'resume' ? findRollout(d.codexHome, req.mode.sessionId) : null;
  const before = priorRollout ? parseRollout(deps.readText(priorRollout) ?? '') : null;

  let args: string[];
  try {
    args = codexArgs({ ...req, workspaceDir: resolve(req.workspaceDir) }, paths.last);
  } catch (e) {
    const r = emptyResult(req, { ...pre, termination: 'runner-infrastructure-failure', detail: (e as Error).message }, deps.process.now(), settings);
    writeFileSync(join(req.recordDir, 'stage.json'), `${JSON.stringify(r, null, 2)}\n`);
    return { ...r, recordFiles: ['stage.json'] };
  }
  const launch = isolatedLaunch(req, cfg.bin, args);
  const proc = await runSupervised(
    { cmd: launch.cmd, args: launch.args, cwd: resolve(req.workspaceDir), env: codexEnv({ path: cfg.path, toolHome }), stdin: req.prompt, stdoutPath: paths.stdout, stderrPath: paths.stderr, deadlineAt: req.deadlineAt, graceMs: cfg.graceMs },
    deps.process,
  );
  syncAuthBack(toolHome, cfg.authHome);

  const rawEvents = deps.readText(paths.stdout) ?? '';
  const rawStderr = deps.readText(paths.stderr) ?? '';
  const events = parseCodexEvents(rawEvents);
  const sessionId = req.mode.kind === 'resume' ? req.mode.sessionId : events.threadId;
  const rolloutPath = sessionId ? findRollout(d.codexHome, sessionId) : null;
  const after = rolloutPath ? parseRollout(deps.readText(rolloutPath) ?? '') : null;
  const resolvedModel = last(events.models) ?? last(after?.models ?? []);
  const resolvedModelSource = events.models.length ? 'exec --json event' : after?.models.length ? 'session rollout turn_context' : 'unavailable';
  const { termination, detail } = decideCodexTermination({ proc, events, stderr: rawStderr, mode: req.mode, requestedModel: req.requestedModel, resolvedModel });
  const lastMessage = deps.readText(paths.last);
  const finalMessage = lastMessage !== null && lastMessage !== '' ? lastMessage : events.finalMessage;

  const recordFiles = ['prompt.md', 'events.jsonl', 'stderr.txt'];
  writeFileSync(join(req.recordDir, 'prompt.md'), req.prompt);
  writeFileSync(join(req.recordDir, 'events.jsonl'), scrubSecrets(rawEvents));
  writeFileSync(join(req.recordDir, 'stderr.txt'), scrubSecrets(rawStderr));
  if (finalMessage !== null) {
    writeFileSync(join(req.recordDir, 'last-message.md'), scrubSecrets(finalMessage));
    recordFiles.push('last-message.md');
  }

  const result: StageResult = {
    stageId: req.stageId,
    role: req.role,
    provider: 'openai',
    tool: 'codex',
    toolVersion: pre.toolVersion,
    mode: req.mode.kind,
    requestedModel: req.requestedModel,
    resolvedModel,
    resolvedModelSource,
    requestedEffort: req.effort,
    appliedEffort: last(after?.efforts ?? []),
    sessionId,
    termination,
    terminationDetail: detail,
    exitCode: proc.exitCode,
    signal: proc.signal,
    startedAt: iso(proc.startedAt),
    endedAt: iso(proc.endedAt),
    durationMs: proc.endedAt - proc.startedAt,
    finalMessage: finalMessage === null ? null : scrubSecrets(finalMessage),
    usage: {
      source: 'codex exec --json turn.completed.usage',
      semantics: CODEX_USAGE_SEMANTICS,
      completeness: usageCompleteness(termination, events),
      raw: events.turnUsages,
      supplementary: {
        rolloutCumulativeBefore: before ? last(before.totals) : null,
        rolloutCumulativeAfter: after ? last(after.totals) : null,
        rolloutFound: rolloutPath !== null,
        malformedEventLines: events.malformedLines,
        turnsStarted: events.turnsStarted,
        turnsCompleted: events.turnsCompleted,
        signalsSent: proc.signalsSent,
      },
    },
    recordFiles: [...recordFiles, 'stage.json'],
    settings: { ...settings, argv: args.map((a) => (a === paths.last ? '<capture>/last-message.md' : a === resolve(req.workspaceDir) ? '<workspace>' : a)) },
  };
  writeFileSync(join(req.recordDir, 'stage.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export const DEFAULT_AUTH_HOME = (benchmarkRoot: string) => join(benchmarkRoot, '.runs', 'auth', 'codex');
export const DEFAULT_CODEX_BIN = (benchmarkRoot: string) => join(benchmarkRoot, 'node_modules', '.bin', 'codex');
