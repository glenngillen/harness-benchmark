/**
 * Subscription-backed Claude Code adapter (methodology sections 4, 9, 10 and 12).
 *
 * One invocation is `claude -p --output-format stream-json --verbose` with the prompt on stdin. A
 * fresh stage fixes its own session id up front (`--session-id <uuid>`), so even a stage killed
 * before its first event has a known session; a resume is `--resume <uuid>` (never `--continue`,
 * never `--fork-session`). Everything Claude Code reads lives in an isolated tool home inside the
 * worktree: `CLAUDE_CONFIG_DIR`, `HOME` and `TMPDIR` point there and the environment is built from
 * scratch. `--setting-sources ""` loads no user/project/local settings, an explicit `--tools` list
 * is the model's whole toolset (which also keeps enterprise-managed MCP tools away from it), and
 * `--disable-slash-commands` removes skills. `--bare` is never used: it abandons subscription login.
 *
 * Authentication is the user's Claude subscription through a long-lived OAuth token that a human
 * creates once with `claude setup-token` and stores, alone, in `.runs/auth/claude/oauth-token`
 * (gitignored, mode 0600). The token reaches the CLI only through `CLAUDE_CODE_OAUTH_TOKEN` in the
 * child environment; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` keeps it out of the commands the model
 * runs, and every record is scrubbed for the literal token as well as for credential shapes.
 * `claude auth status` must report `authMethod: "oauth_token"` with no `apiKeySource`; an API key
 * is refused. No keychain, personal config, or other directory is read as a fallback.
 *
 * Usage capture keeps three raw sources, all verbatim counters (no prompt text):
 *  1. per-request `assistant.message.usage`, de-duplicated by message id (stream-json repeats a
 *     message's usage on every content block), which carries the per-request prompt length needed
 *     for prompt-length price tiers and the principal model of each request;
 *  2. each `result.model_usage_since_last_result`: per model, what this process counted since its
 *     previous result. The installed client documents it as the field to *sum* within a
 *     conversation (each call appears on at most one result, across resumes and kills);
 *  3. each `result.modelUsage`: the session-cumulative per-model totals, which a resume continues
 *     from the transcript's saved totals. Kept with the previous stage's last totals as
 *     before/after so normalisation can cross-check, never summed.
 * Auxiliary models (any model key other than the requested one) are reported, not hidden.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultProcessDeps, runSupervised, type ProcessDeps, type ProcessOutcome } from './process.ts';
import { scrubSecrets } from './scrub.ts';
import type { Completeness, Permission, StageRequest, StageResult, StageTermination } from './types.ts';
import { isolatedLaunch } from './types.ts';

export const CLAUDE_USAGE_SEMANTICS =
  'requests: assistant message usage per API request (deduplicated by message id); sinceLastResult: result.model_usage_since_last_result per model, incremental, summed across results; cumulative: result.modelUsage per model, session-cumulative (continues across resume), never summed';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFLIGHT_MS = 30_000;
const SYNTHETIC_MODEL = '<synthetic>';

/** macOS and Linux locations of Claude Code's managed (enterprise policy) settings. */
export const DEFAULT_MANAGED_SETTINGS = ['/Library/Application Support/ClaudeCode/managed-settings.json', '/etc/claude-code/managed-settings.json'];

export interface ClaudeConfig {
  /** Path to the pinned CLI, normally `node_modules/.bin/claude`. */
  bin: string;
  /** Required `claude --version` pin, for example `2.1.323`. */
  toolVersion: string;
  /** Isolated auth home holding `oauth-token` (inside the worktree). */
  authHome: string;
  /** PATH given to Claude Code and the commands it runs. */
  path: string;
  /** Managed-settings files to check for an effort cap; recorded by hash, never copied. */
  managedSettingsPaths?: string[];
  graceMs?: number;
}

export interface ClaudeDeps {
  process: ProcessDeps;
  readText: (path: string) => string | null;
  newSessionId: () => string;
}

export const defaultClaudeDeps: ClaudeDeps = {
  process: defaultProcessDeps,
  readText: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
  newSessionId: () => randomUUID(),
};

export const claudeHomeDirs = (toolHome: string) => ({
  configDir: join(toolHome, 'claude'),
  home: join(toolHome, 'home'),
  tmp: join(toolHome, 'tmp'),
  capture: join(toolHome, 'capture'),
  sessions: join(toolHome, 'capture', 'sessions'),
});

/** Pure: the environment for a Claude Code invocation, without the credential. Nothing is inherited. */
export function claudeEnv(o: { path: string; toolHome: string }): Record<string, string> {
  const d = claudeHomeDirs(o.toolHome);
  return {
    PATH: o.path,
    HOME: d.home,
    CLAUDE_CONFIG_DIR: d.configDir,
    TMPDIR: d.tmp,
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    npm_config_cache: join(d.home, '.npm'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
}

/**
 * Pure: TMPDIR for a stage. Claude Code's Linux Bash sandbox creates its network-bridge Unix sockets
 * in the temp directory (`claude-http-<16 hex>.sock`), and a Unix socket path is limited to 108 bytes.
 * The tool home's temp directory is far deeper than that on the runner, so socat could not bind and
 * every Bash call failed ("Failed to create bridge sockets"). Under bwrap the stage has its own
 * private, empty /tmp (a tmpfs discarded with the sandbox), which is short and isolated, so use it.
 * Elsewhere keep the tool home's temp directory.
 */
export function claudeStageTmp(mechanism: string | undefined, toolHome: string): string {
  return mechanism === 'bwrap' ? '/tmp' : claudeHomeDirs(toolHome).tmp;
}

/** The credential is added only at launch; recorded settings list variable names, never values. */
const withToken = (env: Record<string, string>, token: string) => ({ ...env, CLAUDE_CODE_OAUTH_TOKEN: token });

/**
 * Toolsets per permission. Task (subagents), web, scheduling and worktree tools are excluded
 * throughout. The permission mode is `default` for both: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` forces
 * it anyway (observed on 2.1.323, which overrides `acceptEdits` with a stderr warning), so the
 * explicit `--allowedTools` list is what pre-approves edits and commands, and `--permission-prompts
 * none` denies anything else instead of waiting for a person.
 */
export const CLAUDE_PERMISSION_MODE = 'default';
export const CLAUDE_TOOLS: Record<Permission, { tools: string[]; permissionMode: string }> = {
  'read-only': { tools: ['Read', 'Grep', 'Glob'], permissionMode: CLAUDE_PERMISSION_MODE },
  'workspace-write': { tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], permissionMode: CLAUDE_PERMISSION_MODE },
};
/**
 * MCP tools are denied by pattern: an explicit `--tools` list does not remove tools from
 * enterprise-managed MCP servers (observed on this host), and `--strict-mcp-config` is refused when
 * managed MCP config exists. The servers may still start; the model cannot call them.
 */
export const CLAUDE_DISALLOWED_TOOLS = ['mcp__*'];

/** Pure: the effective settings passed explicitly, recorded verbatim. */
export function claudeSettings(req: Pick<StageRequest, 'requestedModel' | 'effort' | 'permission'>): Record<string, unknown> {
  const t = CLAUDE_TOOLS[req.permission];
  return {
    model: req.requestedModel,
    effort: req.effort,
    tools: t.tools,
    allowedTools: t.tools,
    disallowedTools: CLAUDE_DISALLOWED_TOOLS,
    permissionMode: t.permissionMode,
    permissionPrompts: 'none',
    settingSources: 'none',
    promptSuggestions: false,
    slashCommands: 'disabled',
    fallbackModel: 'unset',
    bare: false,
    sessionPersistence: true,
  };
}

/** Pure: argv for a stage. The prompt always arrives on stdin. */
export function claudeArgs(req: Pick<StageRequest, 'requestedModel' | 'effort' | 'permission' | 'mode'>, freshSessionId: string): string[] {
  const t = CLAUDE_TOOLS[req.permission];
  const sid = req.mode.kind === 'fresh' ? freshSessionId : req.mode.sessionId;
  if (!UUID.test(sid)) throw new Error(`${req.mode.kind === 'fresh' ? 'fresh session' : 'resume'} requires an explicit session UUID, got ${JSON.stringify(sid)}`);
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    req.requestedModel,
    '--effort',
    req.effort,
    '--setting-sources',
    '',
    '--prompt-suggestions',
    'false',
    '--disable-slash-commands',
    '--permission-prompts',
    'none',
    '--permission-mode',
    t.permissionMode,
    '--tools',
    t.tools.join(','),
    '--allowedTools',
    t.tools.join(','),
    '--disallowedTools',
    CLAUDE_DISALLOWED_TOOLS.join(','),
    req.mode.kind === 'fresh' ? '--session-id' : '--resume',
    sid,
  ];
}

export interface RequestUsage {
  messageId: string;
  model: string;
  usage: Record<string, unknown>;
}

export interface ResultEvent {
  isError: boolean;
  subtype: string | null;
  terminalReason: string | null;
  apiErrorStatus: number | null;
  sessionId: string | null;
  text: string | null;
  numTurns: number | null;
  usage: Record<string, unknown> | null;
  modelUsage: Record<string, unknown> | null;
  /** `undefined` when the client did not set it (absent is not `{}`). */
  sinceLastResult: Record<string, unknown> | undefined;
  totalCostUsd: number | null;
  permissionDenials: number;
}

export interface ParsedClaudeEvents {
  init: { sessionId: string | null; model: string | null; apiKeySource: string | null; tools: string[]; permissionMode: string | null; version: string | null; mcpServers: Array<{ name: string; status: string; source: string }> } | null;
  requests: RequestUsage[];
  /** Models of principal (non-synthetic, non-subagent) assistant messages, in order. */
  principalModels: string[];
  results: ResultEvent[];
  /** Typed API errors seen on assistant messages and retry notices. */
  apiErrors: Array<{ status: number | null; kind: string | null; text: string | null; retry: boolean }>;
  finalMessage: string | null;
  malformedLines: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (isObj(v) ? v : null);

function textOf(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content.filter((c) => isObj(c) && c.type === 'text' && typeof c.text === 'string').map((c) => (c as { text: string }).text);
  return parts.length ? parts.join('\n') : null;
}

/** Pure: parse a stream-json transcript. Unknown events are ignored; malformed lines are counted, never fatal. */
export function parseClaudeEvents(text: string): ParsedClaudeEvents {
  const p: ParsedClaudeEvents = { init: null, requests: [], principalModels: [], results: [], apiErrors: [], finalMessage: null, malformedLines: 0 };
  const seen = new Set<string>();
  const seenPrincipal = new Set<string>();
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
    if (ev.type === 'system' && ev.subtype === 'init') {
      p.init = {
        sessionId: str(ev.session_id),
        model: str(ev.model),
        apiKeySource: str(ev.apiKeySource),
        tools: Array.isArray(ev.tools) ? ev.tools.filter((t): t is string => typeof t === 'string') : [],
        permissionMode: str(ev.permissionMode),
        version: str(ev.claude_code_version),
        mcpServers: Array.isArray(ev.mcp_servers) ? ev.mcp_servers.filter(isObj).map((m) => ({ name: String(m.name), status: String(m.status), source: String(m.source) })) : [],
      };
    } else if (ev.type === 'system' && ev.subtype === 'api_retry') {
      p.apiErrors.push({ status: num(ev.error_status), kind: str(ev.error), text: null, retry: true });
    } else if (ev.type === 'assistant' && isObj(ev.message)) {
      const m = ev.message;
      const model = str(m.model);
      const id = str(m.id);
      const subagent = ev.parent_tool_use_id !== null && ev.parent_tool_use_id !== undefined;
      if (ev.error !== undefined || ev.is_api_error_message === true) {
        p.apiErrors.push({ status: num(ev.api_error_status), kind: str(ev.error), text: textOf(m.content), retry: false });
      }
      if (model !== null && model !== SYNTHETIC_MODEL && !subagent) {
        if (id === null || !seenPrincipal.has(id)) p.principalModels.push(model);
        if (id !== null) seenPrincipal.add(id);
        const t = textOf(m.content);
        if (t !== null) p.finalMessage = t;
      }
      if (model !== null && model !== SYNTHETIC_MODEL && id !== null && isObj(m.usage) && !seen.has(id)) {
        seen.add(id);
        p.requests.push({ messageId: id, model, usage: m.usage });
      }
    } else if (ev.type === 'result') {
      p.results.push({
        isError: ev.is_error === true,
        subtype: str(ev.subtype),
        terminalReason: str(ev.terminal_reason),
        apiErrorStatus: num(ev.api_error_status),
        sessionId: str(ev.session_id),
        text: str(ev.result),
        numTurns: num(ev.num_turns),
        usage: obj(ev.usage),
        modelUsage: obj(ev.modelUsage),
        sinceLastResult: isObj(ev.model_usage_since_last_result) ? ev.model_usage_since_last_result : undefined,
        totalCostUsd: num(ev.total_cost_usd),
        permissionDenials: Array.isArray(ev.permission_denials) ? ev.permission_denials.length : 0,
      });
      if (typeof ev.result === 'string' && ev.result !== '' && ev.is_error !== true) p.finalMessage = ev.result;
    }
  }
  return p;
}

export type FailureClass = 'quota-exhausted' | 'auth-missing' | 'model-access' | 'provider-outage';

/** Pure: classify an HTTP status from the API. */
export function classifyStatus(status: number | null): FailureClass | null {
  if (status === null) return null;
  if (status === 401 || status === 403) return 'auth-missing';
  if (status === 429) return 'quota-exhausted';
  if (status === 404) return 'model-access';
  if (status >= 500) return 'provider-outage';
  return null;
}

const FAILURE_PATTERNS: Array<[FailureClass, RegExp]> = [
  ['quota-exhausted', /usage[ _]limit|hit your limit|limit reached|rate[ _-]?limit|quota|billing|too many requests|\b429\b|resets? (?:at|in)\b/i],
  ['auth-missing', /authentication_failed|failed to authenticate|not logged in|invalid api key|oauth (?:access )?token|unauthori[sz]ed|\b401\b|\b403\b|forbidden|\/login|setup-token|token (?:has )?expired/i],
  ['model-access', /model\b.*\b(?:not found|does not exist|not supported|unavailable|not available|no access)|unknown model|invalid model|not_found_error/i],
  ['provider-outage', /overloaded|\b5\d\d\b|internal server error|api_error|server_error|bad gateway|service unavailable|gateway timeout|connection (?:reset|refused|closed|error)|network error|ECONNRESET|ETIMEDOUT|fetch failed/i],
];

/** Pure: classify failure text into an operational cause, or null when it is not recognisable. */
export function classifyClaudeFailure(texts: string[]): FailureClass | null {
  const joined = texts.join('\n');
  for (const [cls, re] of FAILURE_PATTERNS) if (re.test(joined)) return cls;
  return null;
}

/** Pure: whether `claude --version` output matches the pin exactly. */
export function claudeVersionMatches(output: string, pin: string): { ok: boolean; observed: string | null } {
  const m = /(\d+\.\d+\.\d+)\s*\(Claude Code\)/.exec(output);
  const observed = m?.[1] ?? null;
  return { ok: observed === pin, observed };
}

export type ClaudeLoginMode = 'oauth-token' | 'api-key' | 'other' | 'none' | 'unknown';

/** Pure: interpret `claude auth status --json`. */
export function claudeLoginMode(output: string): ClaudeLoginMode {
  let s: unknown;
  try {
    s = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1));
  } catch {
    return 'unknown';
  }
  if (!isObj(s)) return 'unknown';
  if (typeof s.apiKeySource === 'string' || s.authMethod === 'api_key') return 'api-key';
  if (s.loggedIn !== true || s.authMethod === 'none') return 'none';
  if (s.authMethod === 'oauth_token') return 'oauth-token';
  return 'other';
}

/** Pure: whether a settings object contains `maxEffortLevel` at any depth. */
export function hasEffortCap(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasEffortCap);
  if (!isObj(v)) return false;
  return Object.entries(v).some(([k, x]) => k === 'maxEffortLevel' || hasEffortCap(x));
}

export interface ManagedPolicyFact {
  path: string;
  sha256: string;
  topLevelKeys: string[];
  effortCap: boolean;
  parseable: boolean;
}

/** Facts about managed policy, recorded by hash and key names only; contents are never copied. */
export function managedPolicyFacts(paths: string[], readText: (p: string) => string | null): ManagedPolicyFact[] {
  const out: ManagedPolicyFact[] = [];
  for (const path of paths) {
    const text = readText(path);
    if (text === null) continue;
    const sha256 = createHash('sha256').update(text).digest('hex');
    try {
      const v: unknown = JSON.parse(text);
      out.push({ path, sha256, topLevelKeys: isObj(v) ? Object.keys(v).sort() : [], effortCap: hasEffortCap(v), parseable: true });
    } catch {
      out.push({ path, sha256, topLevelKeys: [], effortCap: false, parseable: false });
    }
  }
  return out;
}

export interface ClaudeOutcomeInput {
  proc: ProcessOutcome;
  events: ParsedClaudeEvents;
  stderr: string;
  mode: StageRequest['mode'];
  sessionId: string;
  requestedModel: string;
  /** The toolset the stage was launched with; anything else in the init event breaks isolation. */
  allowedTools: string[];
  /** The permission mode the stage was launched with. */
  permissionMode: string;
}

const lastOf = <T>(xs: T[]): T | null => (xs.length ? xs[xs.length - 1]! : null);

/** Pure: the stage termination. Recognised operational causes win over exit status. */
export function decideClaudeTermination(i: ClaudeOutcomeInput): { termination: StageTermination; detail: string | null } {
  if (i.proc.spawnError !== null) return { termination: 'runner-infrastructure-failure', detail: `spawn: ${i.proc.spawnError}` };
  if (i.events.init?.apiKeySource && i.events.init.apiKeySource !== 'none') return { termination: 'auth-missing', detail: 'api-key-auth refused (subscription login required)' };
  const extra = (i.events.init?.tools ?? []).filter((t) => !i.allowedTools.includes(t));
  if (extra.length) return { termination: 'runner-infrastructure-failure', detail: `unexpected tools exposed: ${extra.join(',')}` };
  const pm = i.events.init?.permissionMode ?? null;
  if (pm !== null && pm !== i.permissionMode) return { termination: 'runner-infrastructure-failure', detail: `permission mode ${pm}, expected ${i.permissionMode}` };
  const result = lastOf(i.events.results);
  const failed = i.proc.exitCode !== 0 || i.proc.timedOut || result === null || result.isError;
  if (failed) {
    const final = i.events.apiErrors.filter((e) => !e.retry);
    const statuses = [result?.apiErrorStatus ?? null, ...final.map((e) => e.status), ...(result === null || result.isError ? i.events.apiErrors.filter((e) => e.retry).map((e) => e.status) : [])];
    let cls: FailureClass | null = null;
    for (const s of statuses) if ((cls = classifyStatus(s))) break;
    cls ??= classifyClaudeFailure([...(result?.isError && result.text ? [result.text] : []), ...final.flatMap((e) => [e.kind ?? '', e.text ?? '']), i.stderr]);
    if (cls === 'model-access') return { termination: 'auth-missing', detail: 'model-access' };
    if (cls) return { termination: cls, detail: null };
  }
  if (i.proc.timedOut) return { termination: 'stage-timeout', detail: null };
  if (i.proc.exitCode !== 0) return { termination: 'model-error-exit', detail: `exit ${i.proc.exitCode ?? i.proc.signal}` };
  if (result === null) return { termination: 'runner-infrastructure-failure', detail: 'no result event in output' };
  if (result.isError) return { termination: 'model-error-exit', detail: result.terminalReason ?? result.subtype ?? 'is_error' };
  const reported = result.sessionId ?? i.events.init?.sessionId ?? null;
  if (reported !== null && reported !== i.sessionId) return { termination: 'runner-infrastructure-failure', detail: i.mode.kind === 'resume' ? 'resumed a different session' : 'session id differs from the one assigned' };
  const served = [...(i.events.init?.model ? [i.events.init.model] : []), ...i.events.principalModels].find((m) => m !== i.requestedModel);
  if (served !== undefined) return { termination: 'model-substituted', detail: `served ${served}` };
  return { termination: 'completed', detail: null };
}

/** Pure: usage completeness. The final result's incremental counter is the invocation's account. */
export function claudeUsageCompleteness(termination: StageTermination, events: ParsedClaudeEvents): Completeness {
  const result = lastOf(events.results);
  if (events.requests.length === 0 && (result === null || result.sinceLastResult === undefined)) return 'missing';
  if (termination !== 'completed' && termination !== 'model-substituted') return 'partial';
  if (result === null || result.sinceLastResult === undefined) return 'partial';
  return 'complete';
}

/** Pure: models in the stage's incremental counters other than the requested one. */
export function auxiliaryModels(events: ParsedClaudeEvents, requestedModel: string): string[] {
  const keys = new Set<string>();
  for (const r of events.results) for (const k of Object.keys(r.sinceLastResult ?? {})) keys.add(k);
  for (const r of events.requests) keys.add(r.model);
  keys.delete(requestedModel);
  return [...keys].sort();
}

/** Pure: replace absolute paths and literal secrets so records are portable and credential-free. */
export function sanitiseRecord(text: string, o: { secrets: string[]; paths: Array<[string, string]> }): string {
  let out = text;
  for (const s of o.secrets) if (s.length >= 8) out = out.split(s).join('[redacted]');
  out = scrubSecrets(out);
  for (const [p, label] of [...o.paths].sort((a, b) => b[0].length - a[0].length)) if (p) out = out.split(p).join(label);
  return out;
}

export function prepareClaudeHome(toolHome: string): void {
  const d = claudeHomeDirs(toolHome);
  for (const p of [d.configDir, d.home, d.tmp, d.capture, d.sessions]) mkdirSync(p, { recursive: true, mode: 0o700 });
}

/** Reads the subscription token from the isolated auth home. Null when absent or empty. */
export function readOAuthToken(authHome: string, readText: (p: string) => string | null): string | null {
  const t = readText(join(authHome, 'oauth-token'))?.trim() ?? '';
  return t === '' ? null : t;
}

/** Store a token produced by `claude setup-token` (human step) with private permissions. */
export function storeOAuthToken(authHome: string, token: string): void {
  mkdirSync(authHome, { recursive: true, mode: 0o700 });
  const p = join(authHome, 'oauth-token');
  writeFileSync(p, `${token.trim()}\n`, { mode: 0o600 });
  chmodSync(p, 0o600);
}

const iso = (ms: number) => new Date(ms).toISOString();

async function probe(cfg: ClaudeConfig, toolHome: string, args: string[], name: string, env: Record<string, string>, deps: ClaudeDeps) {
  const d = claudeHomeDirs(toolHome);
  const stdoutPath = join(d.capture, `${name}.out`);
  const stderrPath = join(d.capture, `${name}.err`);
  const proc = await runSupervised({ cmd: cfg.bin, args, cwd: d.home, env, stdin: '', stdoutPath, stderrPath, deadlineAt: deps.process.now() + PREFLIGHT_MS, graceMs: 1_000 }, deps.process);
  return { proc, out: `${deps.readText(stdoutPath) ?? ''}\n${deps.readText(stderrPath) ?? ''}` };
}

export interface ClaudePreflightResult {
  ok: boolean;
  toolVersion: string | null;
  loginMode: ClaudeLoginMode | null;
  managedPolicy: ManagedPolicyFact[];
  termination: StageTermination | null;
  detail: string | null;
  /** Present only when ok; never recorded. */
  token?: string;
}

/** Version pin, managed effort cap, then subscription login, all against the isolated home. No model is invoked. */
export async function preflightClaude(cfg: ClaudeConfig, toolHome: string, deps: ClaudeDeps = defaultClaudeDeps): Promise<ClaudePreflightResult> {
  prepareClaudeHome(toolHome);
  const env = claudeEnv({ path: cfg.path, toolHome });
  const managedPolicy = managedPolicyFacts(cfg.managedSettingsPaths ?? DEFAULT_MANAGED_SETTINGS, deps.readText);
  const fail = (o: Partial<ClaudePreflightResult> & Pick<ClaudePreflightResult, 'termination' | 'detail'>): ClaudePreflightResult => ({ ok: false, toolVersion: null, loginMode: null, managedPolicy, ...o });

  const v = await probe(cfg, toolHome, ['--version'], 'version', env, deps);
  const vm = claudeVersionMatches(v.out, cfg.toolVersion);
  if (v.proc.spawnError || !vm.ok) {
    return fail({ toolVersion: vm.observed, termination: 'runner-infrastructure-failure', detail: v.proc.spawnError ? `spawn: ${v.proc.spawnError}` : `version-mismatch: want ${cfg.toolVersion}, got ${vm.observed}` });
  }
  const capped = managedPolicy.find((m) => m.effortCap);
  if (capped) return fail({ toolVersion: vm.observed, termination: 'runner-infrastructure-failure', detail: `effort-cap-present: maxEffortLevel in ${capped.path}` });
  const token = readOAuthToken(cfg.authHome, deps.readText);
  if (token === null) return fail({ toolVersion: vm.observed, loginMode: 'none', termination: 'auth-missing', detail: 'isolated auth home has no oauth-token' });
  const l = await probe(cfg, toolHome, ['auth', 'status', '--json'], 'auth-status', withToken(env, token), deps);
  const mode = claudeLoginMode(l.out);
  if (mode === 'oauth-token') return { ok: true, toolVersion: vm.observed, loginMode: mode, managedPolicy, termination: null, detail: null, token };
  const detail = mode === 'api-key' ? 'api-key-auth refused (subscription login required)' : mode === 'none' ? 'not logged in' : mode === 'other' ? 'unsupported auth method (oauth_token required)' : 'auth status unrecognised';
  return fail({ toolVersion: vm.observed, loginMode: mode, termination: 'auth-missing', detail });
}

function writeJson(path: string, v: unknown) {
  writeFileSync(path, `${JSON.stringify(v, null, 2)}\n`);
}

/** Run one stage: preflight, launch, capture, sanitise into the record directory, classify. */
export async function runClaudeStage(req: StageRequest, cfg: ClaudeConfig, deps: ClaudeDeps = defaultClaudeDeps): Promise<StageResult> {
  const toolHome = resolve(req.toolHome);
  const workspace = resolve(req.workspaceDir);
  const baseEnv = { ...claudeEnv({ path: cfg.path, toolHome }), TMPDIR: claudeStageTmp(req.isolation?.mechanism, toolHome) };
  const settings: Record<string, unknown> = { ...claudeSettings(req), env: [...Object.keys(baseEnv), 'CLAUDE_CODE_OAUTH_TOKEN'].sort(), tmpdir: baseEnv.TMPDIR === '/tmp' ? '/tmp (private tmpfs of the stage sandbox)' : 'tool home' };
  const pre = await preflightClaude(cfg, toolHome, deps);
  settings.managedPolicy = pre.managedPolicy;
  settings.isolation = req.isolation ? req.isolation.describe() : { mechanism: 'none', note: 'no orchestrator isolation supplied' };
  mkdirSync(req.recordDir, { recursive: true });

  const base = {
    stageId: req.stageId,
    role: req.role,
    provider: 'anthropic' as const,
    tool: 'claude-code' as const,
    toolVersion: pre.toolVersion,
    mode: req.mode.kind,
    requestedModel: req.requestedModel,
    requestedEffort: req.effort,
    appliedEffort: null,
  };
  const notLaunched = (termination: StageTermination, detail: string | null, sessionId: string | null): StageResult => {
    const at = iso(deps.process.now());
    const r: StageResult = {
      ...base,
      resolvedModel: null,
      resolvedModelSource: 'unavailable',
      sessionId,
      termination,
      terminationDetail: detail,
      exitCode: null,
      signal: null,
      startedAt: at,
      endedAt: at,
      durationMs: 0,
      finalMessage: null,
      usage: { source: 'none (stage not launched)', semantics: CLAUDE_USAGE_SEMANTICS, completeness: 'missing', raw: [] },
      recordFiles: ['stage.json'],
      settings,
    };
    writeJson(join(req.recordDir, 'stage.json'), r);
    return r;
  };
  if (!pre.ok || pre.token === undefined) return notLaunched(pre.termination ?? 'runner-infrastructure-failure', pre.detail, req.mode.kind === 'resume' ? req.mode.sessionId : null);
  const token = pre.token;

  const sessionId = req.mode.kind === 'fresh' ? deps.newSessionId() : req.mode.sessionId;
  let args: string[];
  try {
    args = claudeArgs(req, sessionId);
  } catch (e) {
    return notLaunched('runner-infrastructure-failure', (e as Error).message, req.mode.kind === 'resume' ? req.mode.sessionId : null);
  }

  const d = claudeHomeDirs(toolHome);
  const cap = join(d.capture, req.stageId);
  mkdirSync(cap, { recursive: true, mode: 0o700 });
  const paths = { stdout: join(cap, 'events.jsonl'), stderr: join(cap, 'stderr.txt') };
  const sessionFile = join(d.sessions, `${sessionId}.json`);
  const before = req.mode.kind === 'resume' ? (JSON.parse(deps.readText(sessionFile) ?? 'null') as { modelUsage: unknown } | null) : null;

  const launch = isolatedLaunch(req, cfg.bin, args);
  const proc = await runSupervised({ cmd: launch.cmd, args: launch.args, cwd: workspace, env: withToken(baseEnv, token), stdin: req.prompt, stdoutPath: paths.stdout, stderrPath: paths.stderr, deadlineAt: req.deadlineAt, graceMs: cfg.graceMs }, deps.process);

  const rawEvents = deps.readText(paths.stdout) ?? '';
  const rawStderr = deps.readText(paths.stderr) ?? '';
  const events = parseClaudeEvents(rawEvents);
  const { termination, detail } = decideClaudeTermination({ proc, events, stderr: rawStderr, mode: req.mode, sessionId, requestedModel: req.requestedModel, allowedTools: CLAUDE_TOOLS[req.permission].tools, permissionMode: CLAUDE_TOOLS[req.permission].permissionMode });
  const lastResult = lastOf(events.results);
  if (lastResult?.modelUsage) writeJson(sessionFile, { sessionId, stageId: req.stageId, modelUsage: lastResult.modelUsage });

  const resolvedModel = lastOf(events.principalModels) ?? events.init?.model ?? null;
  const resolvedModelSource = events.principalModels.length ? 'stream-json assistant message.model' : events.init?.model ? 'stream-json system init model' : 'unavailable';
  const clean = (t: string) => sanitiseRecord(t, { secrets: [token], paths: [[workspace, '<workspace>'], [toolHome, '<tool-home>']] });
  const finalMessage = events.finalMessage === null ? null : clean(events.finalMessage);

  const recordFiles = ['prompt.md', 'events.jsonl', 'stderr.txt'];
  writeFileSync(join(req.recordDir, 'prompt.md'), req.prompt);
  writeFileSync(join(req.recordDir, 'events.jsonl'), clean(rawEvents));
  writeFileSync(join(req.recordDir, 'stderr.txt'), clean(rawStderr));
  if (finalMessage !== null) {
    writeFileSync(join(req.recordDir, 'last-message.md'), finalMessage);
    recordFiles.push('last-message.md');
  }

  const result: StageResult = {
    ...base,
    resolvedModel,
    resolvedModelSource,
    sessionId,
    termination,
    terminationDetail: detail,
    exitCode: proc.exitCode,
    signal: proc.signal,
    startedAt: iso(proc.startedAt),
    endedAt: iso(proc.endedAt),
    durationMs: proc.endedAt - proc.startedAt,
    finalMessage,
    usage: {
      source: 'claude -p --output-format stream-json: assistant message.usage, result.model_usage_since_last_result, result.modelUsage',
      semantics: CLAUDE_USAGE_SEMANTICS,
      completeness: claudeUsageCompleteness(termination, events),
      raw: [
        ...events.requests.map((r) => ({ kind: 'request', messageId: r.messageId, model: r.model, usage: r.usage })),
        ...events.results.map((r, index) => ({ kind: 'result', index, usage: r.usage, sinceLastResult: r.sinceLastResult ?? null, modelUsage: r.modelUsage, nativeCostEstimateUsd: r.totalCostUsd })),
      ],
      supplementary: {
        cumulativeBefore: before?.modelUsage ?? null,
        cumulativeAfter: lastResult?.modelUsage ?? null,
        auxiliaryModels: auxiliaryModels(events, req.requestedModel),
        resultCount: events.results.length,
        resultsMissingSinceLastResult: events.results.filter((r) => r.sinceLastResult === undefined).length,
        numTurns: lastResult?.numTurns ?? null,
        permissionDenials: lastResult?.permissionDenials ?? null,
        apiRetries: events.apiErrors.filter((e) => e.retry).length,
        malformedEventLines: events.malformedLines,
        signalsSent: proc.signalsSent,
        init: events.init && { model: events.init.model, apiKeySource: events.init.apiKeySource, tools: events.init.tools, permissionMode: events.init.permissionMode, version: events.init.version, mcpServers: events.init.mcpServers },
      },
    },
    recordFiles: [...recordFiles, 'stage.json'],
    settings: { ...settings, argv: args },
  };
  writeJson(join(req.recordDir, 'stage.json'), result);
  return result;
}

export const DEFAULT_CLAUDE_AUTH_HOME = (benchmarkRoot: string) => join(benchmarkRoot, '.runs', 'auth', 'claude');
export const DEFAULT_CLAUDE_BIN = (benchmarkRoot: string) => join(benchmarkRoot, 'node_modules', '.bin', 'claude');
