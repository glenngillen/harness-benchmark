import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  claudeStageTmp,
  CLAUDE_TOOLS,
  auxiliaryModels,
  claudeArgs,
  claudeEnv,
  claudeLoginMode,
  claudeUsageCompleteness,
  claudeVersionMatches,
  classifyClaudeFailure,
  classifyStatus,
  decideClaudeTermination,
  hasEffortCap,
  managedPolicyFacts,
  parseClaudeEvents,
  runClaudeStage,
  sanitiseRecord,
  type ClaudeConfig,
  type ClaudeDeps,
  type ClaudeOutcomeInput,
} from '../../src/adapters/claude.ts';
import type { ProcessOutcome } from '../../src/adapters/process.ts';
import type { StageRequest } from '../../src/adapters/types.ts';
import { fakeWorld, tick, type Script } from './support/fake-process.ts';

const BENCHMARK_ROOT = resolve(import.meta.dirname, '../..');
const TMP_ROOT = process.env.HARNESS_TEST_TMP ?? join(BENCHMARK_ROOT, '.runs', 'unit-tmp');
mkdirSync(TMP_ROOT, { recursive: true });
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const SID = '7f163707-5ac7-44ea-a537-7c3262b76a58';
const MODEL = 'claude-haiku-5-5';
const TOKEN = 'sk-ant-oat01-SECRETSECRETSECRET0123456789';

// Shapes observed from the installed Claude Code 2.1.323 (stream-json, --verbose) on 2026-11-14.
const init = (o: Record<string, unknown> = {}) => JSON.stringify({ type: 'system', subtype: 'init', cwd: '/ws', session_id: SID, tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], mcp_servers: [{ name: 'infracost', status: 'connected', source: 'enterprise' }], model: MODEL, permissionMode: 'default', apiKeySource: 'none', claude_code_version: '2.1.323', ...o });
const usage = (input: number, cr: number, cw: number, out: number) => ({ input_tokens: input, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, output_tokens: out, cache_creation: { ephemeral_5m_input_tokens: cw, ephemeral_1h_input_tokens: 0 }, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } });
const assistant = (id: string, content: unknown[], u: object, o: Record<string, unknown> = {}) => JSON.stringify({ type: 'assistant', message: { id, model: MODEL, role: 'assistant', type: 'message', usage: u, content }, parent_tool_use_id: null, session_id: SID, ...o });
const mu = (input: number, out: number, cr = 0, cw = 0) => ({ inputTokens: input, outputTokens: out, cacheReadInputTokens: cr, cacheCreationInputTokens: cw, cacheCreationEphemeral5mInputTokens: cw, cacheCreationEphemeral1hInputTokens: 0, webSearchRequests: 0, costUSD: 0.01, contextWindow: 1_000_000, maxOutputTokens: 64_000 });
const result = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'Implemented the job tracker.', session_id: SID, total_cost_usd: 0.02, usage: usage(30, 1000, 200, 80), modelUsage: { [MODEL]: mu(30, 80, 1000, 200) }, model_usage_since_last_result: { [MODEL]: mu(30, 80, 1000, 200) }, permission_denials: [], terminal_reason: 'completed', ...o });

const SAMPLE = [
  init(),
  assistant('msg_1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'TASK.md' } }], usage(10, 0, 200, 20)),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'task' }] }, session_id: SID }),
  assistant('msg_2', [{ type: 'thinking', thinking: '...' }], usage(20, 1000, 0, 60)),
  assistant('msg_2', [{ type: 'text', text: 'Implemented the job tracker.' }], usage(20, 1000, 0, 60)),
  result(),
].join('\n');

const AUTH_401 = [
  init({ tools: ['Read'] }),
  JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 592, error_status: 401, error: 'authentication_failed', session_id: SID }),
  JSON.stringify({ type: 'assistant', message: { id: 'x', model: '<synthetic>', role: 'assistant', usage: usage(0, 0, 0, 0), content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' }] }, parent_tool_use_id: null, session_id: SID, error: 'authentication_failed', is_api_error_message: true, api_error_status: 401 }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: true, num_turns: 1, api_error_status: 401, result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.', session_id: SID, total_cost_usd: 0, usage: usage(0, 0, 0, 0), modelUsage: {}, model_usage_since_last_result: {}, permission_denials: [], terminal_reason: 'api_error' }),
].join('\n');

const base = { requestedModel: MODEL, effort: 'medium', permission: 'workspace-write' as const };

describe('claudeArgs', () => {
  it('fresh: print mode, stream-json, explicit model/effort/session, no settings sources, explicit toolset', () => {
    const a = claudeArgs({ ...base, mode: { kind: 'fresh' } }, SID);
    expect(a.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(a[a.indexOf('--model') + 1]).toBe(MODEL);
    expect(a[a.indexOf('--effort') + 1]).toBe('medium');
    expect(a[a.indexOf('--setting-sources') + 1]).toBe('');
    expect(a[a.indexOf('--prompt-suggestions') + 1]).toBe('false');
    expect(a[a.indexOf('--permission-prompts') + 1]).toBe('none');
    expect(a[a.indexOf('--permission-mode') + 1]).toBe('default');
    expect(a[a.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Edit,Write,Bash');
    expect(a[a.indexOf('--allowedTools') + 1]).toBe('Read,Grep,Glob,Edit,Write,Bash');
    expect(a[a.indexOf('--disallowedTools') + 1]).toBe('mcp__*');
    expect(a).toContain('--disable-slash-commands');
    expect(a.slice(-2)).toEqual(['--session-id', SID]);
  });

  it('read-only stages get only read tools; both permissions use the default mode', () => {
    const a = claudeArgs({ ...base, permission: 'read-only', mode: { kind: 'fresh' } }, SID);
    expect(a[a.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(a[a.indexOf('--permission-mode') + 1]).toBe('default');
    expect(CLAUDE_TOOLS['read-only'].tools).not.toEqual(expect.arrayContaining(['Edit']));
  });

  it('resume: explicit --resume <uuid>; the fresh id is ignored', () => {
    const other = '11111111-1111-1111-1111-111111111111';
    const a = claudeArgs({ ...base, mode: { kind: 'resume', sessionId: other } }, SID);
    expect(a.slice(-2)).toEqual(['--resume', other]);
    expect(a).not.toContain('--session-id');
  });

  it('never emits bare mode, latest-session selection, forks, fallbacks, permission bypass, or non-persistence', () => {
    for (const mode of [{ kind: 'fresh' as const }, { kind: 'resume' as const, sessionId: SID }]) {
      for (const permission of ['read-only', 'workspace-write'] as const) {
        const a = claudeArgs({ ...base, permission, mode }, SID);
        for (const banned of ['--bare', '-c', '--continue', '--fork-session', '--fallback-model', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--no-session-persistence', 'bypassPermissions', '--worktree', '--bg', '--cloud', '--max-budget-usd']) {
          expect(a).not.toContain(banned);
        }
      }
    }
  });

  it('rejects non-UUID session ids for both fresh and resumed stages', () => {
    for (const sessionId of ['', 'latest', `${SID}x`]) {
      expect(() => claudeArgs({ ...base, mode: { kind: 'resume', sessionId } }, SID)).toThrow(/explicit session UUID/);
      expect(() => claudeArgs({ ...base, mode: { kind: 'fresh' } }, sessionId)).toThrow(/explicit session UUID/);
    }
  });
});

describe('claudeEnv', () => {
  it('is built from scratch: isolated config dir, no credential, no operator variables', () => {
    const env = claudeEnv({ path: '/usr/bin:/bin', toolHome: '/runs/h1' });
    expect(env).toMatchObject({ PATH: '/usr/bin:/bin', HOME: '/runs/h1/home', CLAUDE_CONFIG_DIR: '/runs/h1/claude', TMPDIR: '/runs/h1/tmp', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_SIMPLE', 'NODE_OPTIONS', 'USER', 'SHELL']) expect(env).not.toHaveProperty(k);
  });

  it('property: every path-valued variable except PATH lies inside the tool home', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\/[a-z0-9/]{1,30}$/), (home) => {
        const env = claudeEnv({ path: '/bin', toolHome: home });
        for (const [k, v] of Object.entries(env)) if (k !== 'PATH' && v.startsWith('/')) expect(v.startsWith(join(home, '/'))).toBe(true);
      }),
    );
  });
});

describe('parseClaudeEvents', () => {
  it('reads init, de-duplicates per-request usage by message id, and keeps both result counters', () => {
    const p = parseClaudeEvents(SAMPLE);
    expect(p.init).toMatchObject({ sessionId: SID, model: MODEL, apiKeySource: 'none', version: '2.1.323', permissionMode: 'default' });
    expect(p.requests.map((r) => r.messageId)).toEqual(['msg_1', 'msg_2']);
    expect(p.requests[1]!.usage).toMatchObject({ input_tokens: 20, cache_read_input_tokens: 1000, output_tokens: 60 });
    expect(p.principalModels).toEqual([MODEL, MODEL]);
    expect(p.results).toHaveLength(1);
    expect(p.results[0]).toMatchObject({ isError: false, sessionId: SID, numTurns: 2, totalCostUsd: 0.02 });
    expect(p.results[0]!.sinceLastResult).toEqual({ [MODEL]: mu(30, 80, 1000, 200) });
    expect(p.finalMessage).toBe('Implemented the job tracker.');
    expect(p.malformedLines).toBe(0);
  });

  it('keeps absent model_usage_since_last_result distinct from {}', () => {
    const absent = parseClaudeEvents(result({ model_usage_since_last_result: undefined }));
    const empty = parseClaudeEvents(result({ model_usage_since_last_result: {} }));
    expect(absent.results[0]!.sinceLastResult).toBeUndefined();
    expect(empty.results[0]!.sinceLastResult).toEqual({});
  });

  it('records the observed 401 shape as API errors and ignores the synthetic message for usage and models', () => {
    const p = parseClaudeEvents(AUTH_401);
    expect(p.requests).toEqual([]);
    expect(p.principalModels).toEqual([]);
    expect(p.apiErrors).toEqual([
      { status: 401, kind: 'authentication_failed', text: null, retry: true },
      { status: 401, kind: 'authentication_failed', text: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.', retry: false },
    ]);
    expect(p.results[0]).toMatchObject({ isError: true, apiErrorStatus: 401, terminalReason: 'api_error' });
    expect(p.finalMessage).toBeNull();
  });

  it('subagent messages count for usage but are not principal', () => {
    const p = parseClaudeEvents(assistant('m9', [{ type: 'text', text: 'sub' }], usage(1, 0, 0, 1), { parent_tool_use_id: 'toolu_1', message: { id: 'm9', model: 'claude-other', usage: usage(1, 0, 0, 1), content: [] } }));
    expect(p.requests).toEqual([{ messageId: 'm9', model: 'claude-other', usage: usage(1, 0, 0, 1) }]);
    expect(p.principalModels).toEqual([]);
  });

  it('counts malformed lines without throwing', () => {
    expect(parseClaudeEvents(['nope', '[1]', '{"no":"type"}', init()].join('\n')).malformedLines).toBe(3);
  });

  it('property: arbitrary input never throws; one request per distinct message id with usage', () => {
    const line = fc.oneof(
      fc.string({ maxLength: 60 }).map((s) => s.replace(/\n/g, ' ')),
      fc.tuple(fc.constantFrom('a', 'b', 'c', 'd'), fc.nat(1000)).map(([id, n]) => assistant(id, [], usage(n, 0, 0, n))),
      fc.constantFrom(result(), init(), '{"type":"assistant"}', '{"type":"result"}'),
    );
    fc.assert(
      fc.property(fc.array(line, { maxLength: 30 }), (lines) => {
        const p = parseClaudeEvents(lines.join('\n'));
        const ids = new Set<string>();
        for (const l of lines) {
          try {
            const v = JSON.parse(l);
            if (v?.type === 'assistant' && typeof v.message?.id === 'string' && v.message.usage) ids.add(v.message.id);
          } catch {
            // not JSON
          }
        }
        expect(p.requests.map((r) => r.messageId).sort()).toEqual([...ids].sort());
      }),
    );
  });
});

describe('failure classification', () => {
  it.each([
    [401, 'auth-missing'],
    [403, 'auth-missing'],
    [429, 'quota-exhausted'],
    [404, 'model-access'],
    [500, 'provider-outage'],
    [529, 'provider-outage'],
    [400, null],
    [null, null],
  ])('status %s → %s', (s, cls) => expect(classifyStatus(s)).toBe(cls));

  it.each([
    ['Claude AI usage limit reached|1763100000', 'quota-exhausted'],
    ["You've hit your limit · resets 3pm", 'quota-exhausted'],
    ['Failed to authenticate. API Error: 401 OAuth access token is invalid.', 'auth-missing'],
    ['Invalid API key · Please run /login', 'auth-missing'],
    ['There is an issue with the selected model (claude-haiku-5-5). It may not exist or you may not have access to it. not_found_error', 'model-access'],
    ['API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}', 'provider-outage'],
    ['API Error: Connection error. fetch failed', 'provider-outage'],
  ])('%s → %s', (text, cls) => expect(classifyClaudeFailure([text])).toBe(cls));

  it('returns null for ordinary model failures', () => expect(classifyClaudeFailure(['TypeError: x is undefined', ''])).toBeNull());
});

const proc = (o: Partial<ProcessOutcome> = {}): ProcessOutcome => ({ exitCode: 0, signal: null, timedOut: false, spawnError: null, startedAt: 0, endedAt: 10, signalsSent: [], ...o });
const outcome = (o: Partial<ClaudeOutcomeInput> = {}): ClaudeOutcomeInput => ({ proc: proc(), events: parseClaudeEvents(SAMPLE), stderr: '', mode: { kind: 'fresh' }, sessionId: SID, requestedModel: MODEL, allowedTools: CLAUDE_TOOLS['workspace-write'].tools, permissionMode: 'default', ...o });

describe('decideClaudeTermination', () => {
  it('completes a clean run', () => expect(decideClaudeTermination(outcome())).toEqual({ termination: 'completed', detail: null }));
  it('spawn failure is infrastructure', () => expect(decideClaudeTermination(outcome({ proc: proc({ spawnError: 'ENOENT' }) })).termination).toBe('runner-infrastructure-failure'));
  it('the observed 401 transcript is auth-missing', () => {
    expect(decideClaudeTermination(outcome({ events: parseClaudeEvents(AUTH_401), proc: proc({ exitCode: 1 }), allowedTools: ['Read'] }))).toEqual({ termination: 'auth-missing', detail: null });
  });
  it('an API-key source in init is refused even if the run succeeded', () => {
    expect(decideClaudeTermination(outcome({ events: parseClaudeEvents(SAMPLE.replace('"apiKeySource":"none"', '"apiKeySource":"ANTHROPIC_API_KEY"')) })).detail).toMatch(/api-key-auth/);
  });
  it('a tool outside the launched toolset (for example a managed MCP tool) breaks isolation', () => {
    const events = parseClaudeEvents(SAMPLE.replace('"Bash"]', '"Bash","mcp__infracost__scan"]'));
    expect(decideClaudeTermination(outcome({ events }))).toEqual({ termination: 'runner-infrastructure-failure', detail: 'unexpected tools exposed: mcp__infracost__scan' });
  });
  it('a permission mode other than the launched one (for example a forced override) breaks isolation', () => {
    const events = parseClaudeEvents(SAMPLE.replace('"permissionMode":"default"', '"permissionMode":"bypassPermissions"'));
    expect(decideClaudeTermination(outcome({ events }))).toEqual({ termination: 'runner-infrastructure-failure', detail: 'permission mode bypassPermissions, expected default' });
  });
  it('retries that eventually succeed do not classify a successful run', () => {
    const events = parseClaudeEvents(`${init()}\n{"type":"system","subtype":"api_retry","error_status":529,"error":"overloaded"}\n${SAMPLE.split('\n').slice(1).join('\n')}`);
    expect(decideClaudeTermination(outcome({ events })).termination).toBe('completed');
  });
  it('quota in the error result wins over a timeout', () => {
    const events = parseClaudeEvents(`${init()}\n${result({ is_error: true, api_error_status: 429, result: 'Claude AI usage limit reached' })}`);
    expect(decideClaudeTermination(outcome({ events, proc: proc({ timedOut: true, exitCode: null, signal: 'SIGTERM' }) })).termination).toBe('quota-exhausted');
  });
  it('a timeout with no recognised cause, still retrying an outage, is an outage', () => {
    const events = parseClaudeEvents(`${init()}\n{"type":"system","subtype":"api_retry","error_status":529,"error":"overloaded"}`);
    expect(decideClaudeTermination(outcome({ events, proc: proc({ timedOut: true, exitCode: null }) })).termination).toBe('provider-outage');
  });
  it('a plain timeout', () => {
    expect(decideClaudeTermination(outcome({ events: parseClaudeEvents(init()), proc: proc({ timedOut: true, exitCode: null, signal: 'SIGKILL' }) })).termination).toBe('stage-timeout');
  });
  it('model access maps to missing access, qualified', () => {
    const events = parseClaudeEvents(`${init()}\n${result({ is_error: true, api_error_status: 404, result: 'model not found' })}`);
    expect(decideClaudeTermination(outcome({ events, proc: proc({ exitCode: 1 }) }))).toEqual({ termination: 'auth-missing', detail: 'model-access' });
  });
  it('unrecognised error results and exits are model error exits', () => {
    expect(decideClaudeTermination(outcome({ events: parseClaudeEvents(`${init()}\n${result({ is_error: true, subtype: 'error_max_turns', terminal_reason: 'max_turns', result: '' })}`) }))).toEqual({ termination: 'model-error-exit', detail: 'max_turns' });
    expect(decideClaudeTermination(outcome({ proc: proc({ exitCode: 2 }), events: parseClaudeEvents(init()) }))).toEqual({ termination: 'model-error-exit', detail: 'exit 2' });
  });
  it('a clean exit with no result event is infrastructure', () => expect(decideClaudeTermination(outcome({ events: parseClaudeEvents(init()) })).detail).toBe('no result event in output'));
  it('a resume that reports another session is infrastructure', () => {
    expect(decideClaudeTermination(outcome({ mode: { kind: 'resume', sessionId: '11111111-1111-1111-1111-111111111111' }, sessionId: '11111111-1111-1111-1111-111111111111' })).detail).toBe('resumed a different session');
  });
  it('a different principal or init model is a substitution; auxiliary models are not', () => {
    expect(decideClaudeTermination(outcome({ requestedModel: 'claude-opus-5-5' }))).toEqual({ termination: 'model-substituted', detail: `served ${MODEL}` });
    const aux = `${SAMPLE.replace(/,"model_usage_since_last_result":\{/, `,"model_usage_since_last_result":{"claude-tiny-1":${JSON.stringify(mu(5, 1))},`)}`;
    expect(decideClaudeTermination(outcome({ events: parseClaudeEvents(aux) })).termination).toBe('completed');
  });
});

describe('usage completeness and auxiliary models', () => {
  it('missing, partial and complete', () => {
    expect(claudeUsageCompleteness('completed', parseClaudeEvents(init()))).toBe('missing');
    expect(claudeUsageCompleteness('stage-timeout', parseClaudeEvents(SAMPLE))).toBe('partial');
    expect(claudeUsageCompleteness('completed', parseClaudeEvents(SAMPLE))).toBe('complete');
    expect(claudeUsageCompleteness('completed', parseClaudeEvents(SAMPLE.split('\n').slice(0, -1).join('\n')))).toBe('partial');
    expect(claudeUsageCompleteness('completed', parseClaudeEvents(SAMPLE.replace(/,"model_usage_since_last_result":\{[^}]*\}\}/, '')))).toBe('partial');
  });
  it('lists every non-requested model from incremental counters and requests', () => {
    const aux = SAMPLE.replace(/,"model_usage_since_last_result":\{/, `,"model_usage_since_last_result":{"claude-tiny-1":${JSON.stringify(mu(5, 1))},`);
    expect(auxiliaryModels(parseClaudeEvents(aux), MODEL)).toEqual(['claude-tiny-1']);
    expect(auxiliaryModels(parseClaudeEvents(SAMPLE), MODEL)).toEqual([]);
  });
});

describe('preflight helpers', () => {
  it('version pin', () => {
    expect(claudeVersionMatches('2.1.323 (Claude Code)\n', '2.1.323')).toEqual({ ok: true, observed: '2.1.323' });
    expect(claudeVersionMatches('2.1.322 (Claude Code)\n', '2.1.323')).toEqual({ ok: false, observed: '2.1.322' });
    expect(claudeVersionMatches('command not found', '2.1.323')).toEqual({ ok: false, observed: null });
  });
  it('login mode from the observed auth status JSON', () => {
    expect(claudeLoginMode('{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}')).toBe('oauth-token');
    expect(claudeLoginMode('{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}')).toBe('api-key');
    expect(claudeLoginMode('{"loggedIn":true,"authMethod":"oauth_token","apiKeySource":"apiKeyHelper"}')).toBe('api-key');
    expect(claudeLoginMode('{"loggedIn":false,"authMethod":"none"}')).toBe('none');
    expect(claudeLoginMode('{"loggedIn":true,"authMethod":"claude.ai"}')).toBe('other');
    expect(claudeLoginMode('garbage')).toBe('unknown');
  });
  it('effort caps are found at any depth; policy is recorded by hash and keys only', () => {
    expect(hasEffortCap({ permissions: { deny: ['x'] } })).toBe(false);
    expect(hasEffortCap({ a: [{ maxEffortLevel: 'low' }] })).toBe(true);
    const facts = managedPolicyFacts(['/m.json', '/absent.json', '/bad.json'], (p) => (p === '/m.json' ? '{"permissions":{"deny":["WebFetch"]}}' : p === '/bad.json' ? '{' : null));
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({ path: '/m.json', topLevelKeys: ['permissions'], effortCap: false, parseable: true });
    expect(facts[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(facts)).not.toContain('WebFetch');
    expect(facts[1]).toMatchObject({ parseable: false });
  });
});

describe('sanitiseRecord', () => {
  it('removes the literal token, credential shapes, and absolute paths', () => {
    const out = sanitiseRecord(`token ${TOKEN} in /runs/h1/claude/x and /ws/src, bearer Bearer abcdefghijklmnop`, { secrets: [TOKEN], paths: [['/ws', '<workspace>'], ['/runs/h1', '<tool-home>']] });
    expect(out).toBe('token [redacted] in <tool-home>/claude/x and <workspace>/src, bearer Bearer [redacted]');
  });
  it('property: an arbitrary secret of 8+ characters never survives', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 8, maxLength: 40 }).filter((s) => !s.includes('[redacted]') && !'[redacted]'.includes(s)), fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (secret, a, b) => {
        expect(sanitiseRecord(`${a}${secret}${b}${secret}`, { secrets: [secret], paths: [] })).not.toContain(secret);
      }),
    );
  });
});

// runClaudeStage against a fake CLI. Homes and records are test-owned temporary directories.

function setup(opts: { token?: string | null; managed?: string } = {}) {
  const root = mkdtempSync(join(TMP_ROOT, 'claude-'));
  made.push(root);
  const authHome = join(root, 'auth');
  mkdirSync(authHome, { recursive: true });
  if (opts.token !== null) writeFileSync(join(authHome, 'oauth-token'), `${opts.token ?? TOKEN}\n`);
  const managedPath = join(root, 'managed-settings.json');
  writeFileSync(managedPath, opts.managed ?? '{"permissions":{"deny":["WebFetch"]}}');
  const ws = join(root, 'ws');
  mkdirSync(ws);
  const cfg: ClaudeConfig = { bin: '/pinned/claude', toolVersion: '2.1.323', authHome, path: '/usr/bin:/bin', managedSettingsPaths: [managedPath], graceMs: 1_000 };
  const req = (over: Partial<StageRequest> = {}): StageRequest => ({
    stageId: 'wf02-implement',
    role: 'AC',
    requestedModel: MODEL,
    effort: 'medium',
    permission: 'workspace-write',
    mode: { kind: 'fresh' },
    prompt: 'Implement the task in TASK.md.',
    workspaceDir: ws,
    toolHome: join(root, 'homes', 'wf02-AC'),
    recordDir: join(root, 'records', 'wf02-implement'),
    deadlineAt: 1_000_000 + 15 * 60_000,
    ...over,
  });
  return { root, authHome, ws, cfg, req };
}

const versionOk: Script = (c) => {
  c.stdout.write('2.1.323 (Claude Code)\n');
  c.exit(0);
};
const authOk: Script = (c) => {
  expect(c.opts.env!.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  c.stdout.write('{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty","loginExpiresAt":null}\n');
  c.exit(0);
};

function depsFor(w: ReturnType<typeof fakeWorld>): ClaudeDeps {
  return { process: w.deps, readText: (p) => w.files.get(p) ?? (existsSync(p) ? readFileSync(p, 'utf8') : null), newSessionId: () => SID };
}
const allRecordText = (dir: string) => readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');

describe('runClaudeStage', () => {
  it('fresh stage: isolated launch with an assigned session, usage sources, resolved model, sanitised records', async () => {
    const s = setup();
    const exec: Script = (c) => {
      c.stdout.write(`${SAMPLE.replace('"cwd":"/ws"', `"cwd":${JSON.stringify(s.ws)}`)}\n`);
      c.stdout.write(`${assistant('msg_3', [{ type: 'text', text: `env says ${TOKEN}` }], usage(1, 0, 0, 1))}\n`);
      c.stdout.write(result({ result: 'Done.' }));
      c.stderr.write(`debug: token=${TOKEN}\n`);
      c.exit(0);
    };
    const w = fakeWorld([versionOk, authOk, exec]);
    const r = await runClaudeStage(s.req(), s.cfg, depsFor(w));

    expect(w.spawned.map((c) => c.args)).toEqual([['--version'], ['auth', 'status', '--json'], claudeArgs(s.req(), SID)]);
    const x = w.spawned[2]!;
    expect(x.cmd).toBe('/pinned/claude');
    expect(x.opts.cwd).toBe(s.ws);
    expect(x.opts.env).toEqual({ ...claudeEnv({ path: s.cfg.path, toolHome: s.req().toolHome }), CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    expect(x.stdinText).toBe('Implement the task in TASK.md.');
    expect(r).toMatchObject({ provider: 'anthropic', tool: 'claude-code', toolVersion: '2.1.323', mode: 'fresh', sessionId: SID, termination: 'completed', resolvedModel: MODEL, resolvedModelSource: 'stream-json assistant message.model', appliedEffort: null, exitCode: 0 });
    expect(r.usage.completeness).toBe('complete');
    expect(r.usage.raw.filter((e) => (e as { kind: string }).kind === 'request')).toHaveLength(3);
    expect(r.usage.raw.filter((e) => (e as { kind: string }).kind === 'result')).toHaveLength(2);
    expect(r.usage.supplementary).toMatchObject({ cumulativeBefore: null, cumulativeAfter: { [MODEL]: mu(30, 80, 1000, 200) }, auxiliaryModels: [], resultCount: 2, resultsMissingSinceLastResult: 0 });
    expect(r.recordFiles.sort()).toEqual(['events.jsonl', 'last-message.md', 'prompt.md', 'stage.json', 'stderr.txt']);
    const records = allRecordText(s.req().recordDir);
    expect(records).not.toContain(TOKEN);
    expect(records).not.toContain('SECRETSECRET');
    expect(records).not.toContain(s.ws);
    expect(records).not.toContain(s.req().toolHome);
    expect(records).toContain('<workspace>');
    expect(JSON.stringify(r.settings)).not.toContain(TOKEN);
    expect(r.settings.env).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(r.finalMessage).toBe('Done.');
  });

  it('resume: explicit session in the original home, cumulative totals before and after', async () => {
    const s = setup();
    const first: Script = (c) => {
      c.stdout.write(SAMPLE);
      c.exit(0);
    };
    await runClaudeStage(s.req(), s.cfg, depsFor(fakeWorld([versionOk, authOk, first])));
    const resumed: Script = (c) => {
      c.stdout.write([init(), assistant('msg_9', [{ type: 'text', text: 'Fixed.' }], usage(5, 1200, 0, 40)), result({ result: 'Fixed.', modelUsage: { [MODEL]: mu(35, 120, 2200, 200) }, model_usage_since_last_result: { [MODEL]: mu(5, 40, 1200, 0) } })].join('\n'));
      c.exit(0);
    };
    const w = fakeWorld([versionOk, authOk, resumed]);
    const r = await runClaudeStage(s.req({ stageId: 'wf02-fix', mode: { kind: 'resume', sessionId: SID } }), s.cfg, depsFor(w));
    expect(w.spawned[2]!.args.slice(-2)).toEqual(['--resume', SID]);
    expect(w.spawned[2]!.opts.env!.CLAUDE_CONFIG_DIR).toBe(join(s.req().toolHome, 'claude'));
    expect(r).toMatchObject({ mode: 'resume', sessionId: SID, termination: 'completed' });
    expect(r.usage.supplementary).toMatchObject({ cumulativeBefore: { [MODEL]: mu(30, 80, 1000, 200) }, cumulativeAfter: { [MODEL]: mu(35, 120, 2200, 200) } });
    expect(r.usage.raw.find((e) => (e as { kind: string }).kind === 'result')).toMatchObject({ sinceLastResult: { [MODEL]: mu(5, 40, 1200, 0) } });
  });

  it('terminates at the stage deadline and keeps the partial per-request usage it saw', async () => {
    const s = setup();
    const exec: Script = (c) => void c.stdout.write(`${SAMPLE.split('\n').slice(0, 2).join('\n')}\n`);
    const w = fakeWorld([versionOk, authOk, exec], {
      onSignal: (c, sig) => {
        if (sig === 'SIGKILL') c.exit(null, 'SIGKILL');
      },
    });
    const p = runClaudeStage(s.req({ deadlineAt: 1_000_000 + 60_000 }), s.cfg, depsFor(w));
    while (w.spawned.length < 3) await tick();
    await tick();
    w.advance(60_000);
    w.advance(1_000);
    const r = await p;
    expect(w.killed.map((k) => k.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(r).toMatchObject({ termination: 'stage-timeout', sessionId: SID, signal: 'SIGKILL' });
    expect(r.usage.completeness).toBe('partial');
    expect(r.usage.raw).toEqual([{ kind: 'request', messageId: 'msg_1', model: MODEL, usage: usage(10, 0, 200, 20) }]);
    expect(r.usage.supplementary).toMatchObject({ cumulativeAfter: null, resultCount: 0 });
  });

  it('quota exhaustion is operational and preserves incurred usage', async () => {
    const s = setup();
    const exec: Script = (c) => {
      c.stdout.write([init(), assistant('msg_1', [], usage(10, 0, 0, 5)), result({ is_error: true, api_error_status: 429, result: 'Claude AI usage limit reached|1763100000', model_usage_since_last_result: { [MODEL]: mu(10, 5) } })].join('\n'));
      c.exit(1);
    };
    const r = await runClaudeStage(s.req(), s.cfg, depsFor(fakeWorld([versionOk, authOk, exec])));
    expect(r.termination).toBe('quota-exhausted');
    expect(r.usage.completeness).toBe('partial');
    expect(r.usage.raw).toHaveLength(2);
  });

  it('missing usage stays missing; it is never zero-filled', async () => {
    const s = setup();
    const exec: Script = (c) => {
      c.stdout.write(`${init()}\n${result({ usage: undefined, modelUsage: undefined, model_usage_since_last_result: undefined })}`);
      c.exit(0);
    };
    const r = await runClaudeStage(s.req(), s.cfg, depsFor(fakeWorld([versionOk, authOk, exec])));
    expect(r).toMatchObject({ termination: 'completed', resolvedModel: MODEL, resolvedModelSource: 'stream-json system init model' });
    expect(r.usage.completeness).toBe('missing');
    expect(r.usage.supplementary).toMatchObject({ cumulativeAfter: null, resultsMissingSinceLastResult: 1 });
  });

  it('rejects a served model other than the one requested', async () => {
    const s = setup();
    const exec: Script = (c) => {
      c.stdout.write(SAMPLE);
      c.exit(0);
    };
    const r = await runClaudeStage(s.req({ requestedModel: 'claude-opus-5-5', role: 'AF' }), s.cfg, depsFor(fakeWorld([versionOk, authOk, exec])));
    expect(r).toMatchObject({ termination: 'model-substituted', terminationDetail: `served ${MODEL}`, resolvedModel: MODEL });
  });

  it('refuses an unpinned CLI before any model call', async () => {
    const s = setup();
    const w = fakeWorld([(c) => (c.stdout.write('2.1.322 (Claude Code)\n'), c.exit(0))]);
    const r = await runClaudeStage(s.req(), s.cfg, depsFor(w));
    expect(w.spawned).toHaveLength(1);
    expect(r).toMatchObject({ termination: 'runner-infrastructure-failure', terminationDetail: 'version-mismatch: want 2.1.323, got 2.1.322', toolVersion: '2.1.322', sessionId: null });
    expect(r.usage.completeness).toBe('missing');
    expect(existsSync(join(s.req().recordDir, 'stage.json'))).toBe(true);
  });

  it('refuses a managed effort cap before any model call', async () => {
    const s = setup({ managed: '{"maxEffortLevel":"low"}' });
    const w = fakeWorld([versionOk]);
    const r = await runClaudeStage(s.req(), s.cfg, depsFor(w));
    expect(w.spawned).toHaveLength(1);
    expect(r.terminationDetail).toMatch(/^effort-cap-present/);
  });

  it('records a missing token as auth-missing and reads no other directory', async () => {
    const s = setup({ token: null });
    const w = fakeWorld([versionOk]);
    const r = await runClaudeStage(s.req(), s.cfg, depsFor(w));
    expect(w.spawned).toHaveLength(1);
    expect(r).toMatchObject({ termination: 'auth-missing', terminationDetail: 'isolated auth home has no oauth-token' });
  });

  it('refuses API-key authentication', async () => {
    const s = setup();
    const w = fakeWorld([versionOk, (c) => (c.stdout.write('{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}'), c.exit(0))]);
    const r = await runClaudeStage(s.req(), s.cfg, depsFor(w));
    expect(w.spawned).toHaveLength(2);
    expect(r).toMatchObject({ termination: 'auth-missing', terminationDetail: 'api-key-auth refused (subscription login required)' });
  });

  it('an invalid resume id fails before launch', async () => {
    const s = setup();
    const w = fakeWorld([versionOk, authOk]);
    const r = await runClaudeStage(s.req({ mode: { kind: 'resume', sessionId: 'latest' } }), s.cfg, depsFor(w));
    expect(w.spawned).toHaveLength(2);
    expect(r.termination).toBe('runner-infrastructure-failure');
    expect(r.terminationDetail).toMatch(/explicit session UUID/);
  });

  it('records managed policy by hash and key names, never contents', async () => {
    const s = setup();
    const exec: Script = (c) => {
      c.stdout.write(SAMPLE);
      c.exit(0);
    };
    const r = await runClaudeStage(s.req(), s.cfg, depsFor(fakeWorld([versionOk, authOk, exec])));
    expect(r.settings.managedPolicy).toEqual([expect.objectContaining({ topLevelKeys: ['permissions'], effortCap: false })]);
    expect(JSON.stringify(r.settings)).not.toContain('WebFetch');
  });
});

describe('claudeStageTmp', () => {
  // Claude Code's Linux Bash sandbox binds claude-http-<16 hex>.sock and claude-socks-<16 hex>.sock in
  // the temp directory; a Unix socket path must fit in 108 bytes including the terminating NUL.
  const SOCKET = 'claude-socks-0123456789abcdef.sock';
  it('uses the private /tmp of a bwrap stage sandbox, and the tool home elsewhere', () => {
    const deep = '/opt/harness/work/.runs/campaign/cohort-03/block-01/slot-02-irf.AC-AF-AC.on/attempt-1/homes/s1-implement';
    expect(claudeStageTmp('bwrap', deep)).toBe('/tmp');
    expect(claudeStageTmp('sandbox-exec', '/runs/h1')).toBe('/runs/h1/tmp');
    expect(claudeStageTmp(undefined, '/runs/h1')).toBe('/runs/h1/tmp');
    // The runner's tool-home temp directory is too deep for a socket.
    expect(`${claudeStageTmp('none', deep)}/${SOCKET}`.length).toBeGreaterThan(107);
  });

  describe('properties', () => {
    it('under bwrap the bridge socket path always fits, whatever the tool home', () => {
      fc.assert(fc.property(fc.string({ maxLength: 400 }), (home) => `${claudeStageTmp('bwrap', `/${home}`)}/${SOCKET}`.length <= 107));
    });
  });
});
