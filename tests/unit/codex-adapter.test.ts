import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  classifyCodexFailure,
  codexArgs,
  codexEnv,
  decideCodexTermination,
  loginMode,
  parseCodexEvents,
  parseRollout,
  runCodexStage,
  usageCompleteness,
  versionMatches,
  type CodexConfig,
  type CodexDeps,
  type OutcomeInput,
} from '../../src/adapters/codex.ts';
import type { ProcessOutcome } from '../../src/adapters/process.ts';
import type { StageRequest } from '../../src/adapters/types.ts';
import { fakeWorld, tick, type FakeChild, type Script } from './support/fake-process.ts';

const BENCHMARK_ROOT = resolve(import.meta.dirname, '../..');
const TMP_ROOT = process.env.HARNESS_TEST_TMP ?? join(BENCHMARK_ROOT, '.runs', 'unit-tmp');
mkdirSync(TMP_ROOT, { recursive: true });
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const SID = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const SAMPLE = [
  `{"type":"thread.started","thread_id":"${SID}"}`,
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}',
  '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}',
].join('\n');

const base = { requestedModel: 'gpt-6-luna', effort: 'high', permission: 'workspace-write' as const, workspaceDir: '/ws' };

describe('codexArgs', () => {
  it('fresh: JSON events, explicit model/effort/sandbox, user config and rules ignored, prompt on stdin', () => {
    const a = codexArgs({ ...base, mode: { kind: 'fresh' } }, '/cap/last.md');
    expect(a.slice(0, 2)).toEqual(['exec', '--json']);
    expect(a).toEqual(expect.arrayContaining(['--ignore-user-config', '--ignore-rules']));
    expect(a[a.indexOf('-m') + 1]).toBe('gpt-6-luna');
    expect(a).toContain('model_reasoning_effort="high"');
    expect(a).toContain('approval_policy="never"');
    expect(a).toContain('sandbox_workspace_write.network_access=false');
    expect(a[a.indexOf('--sandbox') + 1]).toBe('workspace-write');
    expect(a[a.indexOf('-C') + 1]).toBe('/ws');
    expect(a[a.indexOf('-o') + 1]).toBe('/cap/last.md');
    expect(a.at(-1)).toBe('-');
  });

  it('resume: explicit session id, sandbox via config override, never --last', () => {
    const a = codexArgs({ ...base, permission: 'read-only', mode: { kind: 'resume', sessionId: SID } }, '/cap/last.md');
    expect(a.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(a.slice(-2)).toEqual([SID, '-']);
    expect(a).toContain('sandbox_mode="read-only"');
    expect(a).not.toContain('--sandbox');
    expect(a).not.toContain('-C');
  });

  it('never emits latest-session selection, approval bypass, or ephemeral sessions', () => {
    for (const mode of [{ kind: 'fresh' as const }, { kind: 'resume' as const, sessionId: SID }]) {
      const a = codexArgs({ ...base, mode }, '/x');
      for (const banned of ['--last', '--all', '--ephemeral', '--dangerously-bypass-approvals-and-sandbox', '--approve-for-me', '--full-auto', '--oss', '--worktree']) expect(a).not.toContain(banned);
    }
  });

  it('rejects a resume without an explicit session UUID', () => {
    for (const sessionId of ['', '--last', 'my-thread', `${SID}x`]) {
      expect(() => codexArgs({ ...base, mode: { kind: 'resume', sessionId } }, '/x')).toThrow(/explicit session UUID/);
    }
  });

  it('quotes effort values as TOML strings', () => {
    expect(codexArgs({ ...base, effort: 'a"b', mode: { kind: 'fresh' } }, '/x')).toContain('model_reasoning_effort="a\\"b"');
  });
});

describe('codexEnv', () => {
  it('is built from scratch: isolated HOME/CODEX_HOME, no credentials or operator variables', () => {
    const env = codexEnv({ path: '/usr/bin:/bin', toolHome: '/runs/h1' });
    expect(env).toMatchObject({ PATH: '/usr/bin:/bin', HOME: '/runs/h1/home', CODEX_HOME: '/runs/h1/codex', TMPDIR: '/runs/h1/tmp' });
    for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'NODE_OPTIONS', 'USER', 'SHELL']) expect(env).not.toHaveProperty(k);
  });

  it('property: every path-valued variable except PATH lies inside the tool home', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\/[a-z0-9/]{1,30}$/), (home) => {
        const env = codexEnv({ path: '/bin', toolHome: home });
        for (const [k, v] of Object.entries(env)) if (k !== 'PATH' && v.startsWith('/')) expect(v.startsWith(join(home, '/'))).toBe(true);
      }),
    );
  });
});

describe('parseCodexEvents', () => {
  it('reads the documented sample', () => {
    const p = parseCodexEvents(SAMPLE);
    expect(p).toMatchObject({ threadId: SID, finalMessage: 'Repo contains docs, sdk, and examples directories.', turnsStarted: 1, turnsCompleted: 1, failures: [], malformedLines: 0 });
    expect(p.turnUsages).toEqual([{ input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0 }]);
  });

  it('counts malformed lines and records failures without throwing', () => {
    const p = parseCodexEvents(['not json', '[1,2]', '{"no":"type"}', '{"type":"turn.failed","error":{"message":"boom"}}', '{"type":"error","message":"stream disconnected"}'].join('\n'));
    expect(p.malformedLines).toBe(3);
    expect(p.failures).toEqual(['boom', 'stream disconnected']);
  });

  it('keeps the last agent message and collects model fields when present', () => {
    const p = parseCodexEvents(['{"type":"item.completed","item":{"type":"agent_message","text":"a"}}', '{"type":"session.configured","model":"gpt-6-luna"}', '{"type":"item.completed","item":{"type":"agent_message","text":"b"}}'].join('\n'));
    expect(p.finalMessage).toBe('b');
    expect(p.models).toEqual(['gpt-6-luna']);
  });

  it('property: arbitrary input never throws; one usage per turn.completed carrying a usage object', () => {
    const usage = fc.record({ input_tokens: fc.nat(), output_tokens: fc.nat() });
    const line = fc.oneof(
      fc.string({ maxLength: 80 }).map((s) => s.replace(/\n/g, ' ')),
      usage.map((u) => JSON.stringify({ type: 'turn.completed', usage: u })),
      fc.constant('{"type":"turn.completed"}'),
      fc.constant('{"type":"turn.started"}'),
    );
    fc.assert(
      fc.property(fc.array(line, { maxLength: 30 }), (lines) => {
        const p = parseCodexEvents(lines.join('\n'));
        const expected = lines.filter((l) => {
          try {
            const v = JSON.parse(l);
            return v?.type === 'turn.completed' && typeof v.usage === 'object' && v.usage !== null && !Array.isArray(v.usage);
          } catch {
            return false;
          }
        }).length;
        expect(p.turnUsages).toHaveLength(expected);
      }),
    );
  });
});

describe('classifyCodexFailure', () => {
  it.each([
    ["You've hit your usage limit. Upgrade to Pro or try again at 4:05 PM.", 'quota-exhausted'],
    ['usage_limit_reached', 'quota-exhausted'],
    ['exceeded retry limit, last status: 429 Too Many Requests', 'quota-exhausted'],
    ['Not logged in', 'auth-missing'],
    ['unexpected status 401 Unauthorized', 'auth-missing'],
    ['Your access token could not be refreshed. Please log in again.', 'auth-missing'],
    ['The model `gpt-6-luna` does not exist or you do not have access to it.', 'model-access'],
    ['unexpected status 503 Service Unavailable', 'provider-outage'],
    ['stream disconnected before completion', 'provider-outage'],
  ])('%s → %s', (text, cls) => expect(classifyCodexFailure([text])).toBe(cls));

  it('returns null for ordinary model failures', () => {
    expect(classifyCodexFailure(['TypeError: cannot read properties of undefined', ''])).toBeNull();
  });
});

const proc = (o: Partial<ProcessOutcome> = {}): ProcessOutcome => ({ exitCode: 0, signal: null, timedOut: false, spawnError: null, startedAt: 0, endedAt: 10, signalsSent: [], ...o });
const outcome = (o: Partial<OutcomeInput> = {}): OutcomeInput => ({ proc: proc(), events: parseCodexEvents(SAMPLE), stderr: '', mode: { kind: 'fresh' }, requestedModel: 'gpt-6-luna', resolvedModel: 'gpt-6-luna', ...o });

describe('decideCodexTermination', () => {
  it('completes a clean run', () => expect(decideCodexTermination(outcome())).toEqual({ termination: 'completed', detail: null }));
  it('spawn failure is infrastructure', () => expect(decideCodexTermination(outcome({ proc: proc({ spawnError: 'ENOENT' }) })).termination).toBe('runner-infrastructure-failure'));
  it('timeout', () => expect(decideCodexTermination(outcome({ proc: proc({ timedOut: true, exitCode: null, signal: 'SIGTERM' }) })).termination).toBe('stage-timeout'));
  it('quota wins over a timeout or exit code', () => {
    const events = parseCodexEvents(`${SAMPLE}\n{"type":"turn.failed","error":{"message":"You've hit your usage limit"}}`);
    expect(decideCodexTermination(outcome({ events, proc: proc({ exitCode: 1 }) })).termination).toBe('quota-exhausted');
  });
  it('stderr is consulted only on failure', () => {
    expect(decideCodexTermination(outcome({ stderr: 'retrying after 503', proc: proc({ exitCode: 0 }) })).termination).toBe('completed');
    expect(decideCodexTermination(outcome({ stderr: 'unexpected status 503', proc: proc({ exitCode: 1 }) })).termination).toBe('provider-outage');
  });
  it('model access maps to missing access, qualified', () => {
    expect(decideCodexTermination(outcome({ stderr: 'model gpt-6-luna is not supported', proc: proc({ exitCode: 1 }) }))).toEqual({ termination: 'auth-missing', detail: 'model-access' });
  });
  it('unrecognised non-zero exit is a model error exit', () => expect(decideCodexTermination(outcome({ proc: proc({ exitCode: 2 }) }))).toEqual({ termination: 'model-error-exit', detail: 'exit 2' }));
  it('fresh run without a session id is infrastructure', () => expect(decideCodexTermination(outcome({ events: parseCodexEvents('{"type":"turn.started"}') })).detail).toBe('no session id in output'));
  it('resume that reports another session is infrastructure', () => {
    expect(decideCodexTermination(outcome({ mode: { kind: 'resume', sessionId: '11111111-1111-1111-1111-111111111111' } })).detail).toBe('resumed a different session');
  });
  it('a different served model is a substitution; an unknown one is not judged here', () => {
    expect(decideCodexTermination(outcome({ resolvedModel: 'gpt-6-sol' }))).toEqual({ termination: 'model-substituted', detail: 'served gpt-6-sol' });
    expect(decideCodexTermination(outcome({ resolvedModel: null })).termination).toBe('completed');
  });
});

describe('usageCompleteness', () => {
  it('missing, partial and complete', () => {
    expect(usageCompleteness('completed', parseCodexEvents('{"type":"turn.started"}'))).toBe('missing');
    expect(usageCompleteness('stage-timeout', parseCodexEvents(SAMPLE))).toBe('partial');
    expect(usageCompleteness('completed', parseCodexEvents(SAMPLE))).toBe('complete');
    expect(usageCompleteness('completed', parseCodexEvents(`${SAMPLE}\n{"type":"turn.started"}`))).toBe('partial');
  });
});

describe('parseRollout, versionMatches, loginMode', () => {
  it('reads model, effort and cumulative totals', () => {
    const r = parseRollout(
      [
        '{"type":"session_meta","payload":{"id":"x"}}',
        '{"type":"turn_context","payload":{"model":"gpt-6-luna","effort":"high"}}',
        '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":2,"bad":"x"}}}}',
        'garbage',
        '{"type":"event_msg","payload":{"type":"token_count","info":null}}',
      ].join('\n'),
    );
    expect(r).toEqual({ models: ['gpt-6-luna'], efforts: ['high'], totals: [{ input_tokens: 10, output_tokens: 2 }], lines: 5 });
  });
  it('version pin is exact', () => {
    expect(versionMatches('codex-cli 0.169.0\n', '0.169.0')).toEqual({ ok: true, observed: '0.169.0' });
    expect(versionMatches('codex-cli 0.167.2', '0.169.0')).toEqual({ ok: false, observed: '0.167.2' });
    expect(versionMatches('', '0.169.0').ok).toBe(false);
  });
  it('login modes', () => {
    expect(loginMode('Not logged in')).toBe('none');
    expect(loginMode('Logged in using ChatGPT')).toBe('chatgpt');
    expect(loginMode('Logged in using an API key - sk-***')).toBe('api-key');
    expect(loginMode('???')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------------------------
// runCodexStage against a fake CLI. Homes and records are test-owned temporary directories.

const AUTH_JSON = '{"tokens":{"access_token":"SECRET-ACCESS-0123456789","refresh_token":"SECRET-REFRESH-0123456789"}}';

function setup(opts: { auth?: string | null } = {}) {
  const root = mkdtempSync(join(TMP_ROOT, 'codex-'));
  made.push(root);
  const authHome = join(root, 'auth');
  mkdirSync(authHome, { recursive: true });
  if (opts.auth !== null) writeFileSync(join(authHome, 'auth.json'), opts.auth ?? AUTH_JSON);
  const ws = join(root, 'ws');
  mkdirSync(ws);
  const cfg: CodexConfig = { bin: '/pinned/codex', toolVersion: '0.169.0', authHome, path: '/usr/bin:/bin', graceMs: 1_000 };
  const req = (over: Partial<StageRequest> = {}): StageRequest => ({
    stageId: 'wf01-implement',
    role: 'CC',
    requestedModel: 'gpt-6-luna',
    effort: 'high',
    permission: 'workspace-write',
    mode: { kind: 'fresh' },
    prompt: 'Implement the task in TASK.md.',
    workspaceDir: ws,
    toolHome: join(root, 'homes', 'wf01-CC'),
    recordDir: join(root, 'records', 'wf01-implement'),
    deadlineAt: 1_000_000 + 15 * 60_000,
    ...over,
  });
  return { root, authHome, ws, cfg, req };
}

const versionOk: Script = (c) => {
  c.stdout.write('codex-cli 0.169.0\n');
  c.exit(0);
};
const loginOk: Script = (c) => {
  c.stdout.write('Logged in using ChatGPT\n');
  c.exit(0);
};

function writeRollout(c: FakeChild, lines: string[]) {
  const dir = join(c.opts.env!.CODEX_HOME!, 'sessions', '2026', '11', '14');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-11-14T10-00-00-${SID}.jsonl`), `${lines.join('\n')}\n`, { flag: 'a' });
}
const lastMessagePath = (c: FakeChild) => c.args[c.args.indexOf('-o') + 1]!;

function depsFor(w: ReturnType<typeof fakeWorld>): CodexDeps {
  return { process: w.deps, readText: (p) => w.files.get(p) ?? (existsSync(p) ? readFileSync(p, 'utf8') : null) };
}

const allRecordText = (dir: string) => readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');

describe('runCodexStage', () => {
  it('fresh stage: isolated launch, captured session, usage, resolved model, scrubbed records', async () => {
    const s = setup();
    const exec: Script = (c) => {
      writeRollout(c, ['{"type":"turn_context","payload":{"model":"gpt-6-luna","effort":"high"}}', '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":24763,"output_tokens":122}}}}']);
      writeFileSync(lastMessagePath(c), 'Done. Key was sk-abcdefghijklmnopqrstuvwxyz0123.');
      c.stdout.write(`${SAMPLE}\n{"type":"item.completed","item":{"type":"agent_message","text":"used sk-abcdefghijklmnopqrstuvwxyz0123"}}\n`);
      c.stderr.write('Authorization: Bearer abcdefghijklmnopqrstuvwxyz\n');
      c.exit(0);
    };
    const w = fakeWorld([versionOk, loginOk, exec]);
    const r = await runCodexStage(s.req(), s.cfg, depsFor(w));

    expect(w.spawned.map((c) => c.args.slice(0, 2))).toEqual([['--version'], ['login', 'status'], ['exec', '--json']]);
    const x = w.spawned[2]!;
    expect(x.cmd).toBe('/pinned/codex');
    expect(x.opts.cwd).toBe(s.ws);
    expect(x.opts.env).toEqual(codexEnv({ path: s.cfg.path, toolHome: s.req().toolHome }));
    expect(x.stdinText).toBe('Implement the task in TASK.md.');
    expect(r).toMatchObject({
      provider: 'openai',
      tool: 'codex',
      toolVersion: '0.169.0',
      mode: 'fresh',
      sessionId: SID,
      termination: 'completed',
      resolvedModel: 'gpt-6-luna',
      resolvedModelSource: 'session rollout turn_context',
      appliedEffort: 'high',
      exitCode: 0,
    });
    expect(r.usage).toMatchObject({ completeness: 'complete', raw: [{ input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0 }] });
    expect(r.usage.supplementary).toMatchObject({ rolloutFound: true, rolloutCumulativeBefore: null, rolloutCumulativeAfter: { input_tokens: 24763, output_tokens: 122 } });
    expect(r.recordFiles.sort()).toEqual(['events.jsonl', 'last-message.md', 'prompt.md', 'stage.json', 'stderr.txt']);
    const records = allRecordText(s.req().recordDir);
    expect(records).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(records).not.toContain('abcdefghijklmnopqrstuvwxyz\n');
    expect(records).not.toContain('SECRET-');
    expect(records).not.toContain(s.ws);
    expect(r.finalMessage).toContain('[redacted]');
    expect(JSON.parse(readFileSync(join(s.req().recordDir, 'stage.json'), 'utf8')).sessionId).toBe(SID);
  });

  it('copies the login into the stage home and writes a refreshed token back to the auth home', async () => {
    const s = setup();
    const exec: Script = (c) => {
      const stageAuth = join(c.opts.env!.CODEX_HOME!, 'auth.json');
      expect(readFileSync(stageAuth, 'utf8')).toBe(AUTH_JSON);
      writeFileSync(stageAuth, AUTH_JSON.replace('0123456789', 'REFRESHED'));
      c.stdout.write(SAMPLE);
      c.exit(0);
    };
    await runCodexStage(s.req(), s.cfg, depsFor(fakeWorld([versionOk, loginOk, exec])));
    expect(readFileSync(join(s.authHome, 'auth.json'), 'utf8')).toContain('REFRESHED');
  });

  it('resume: explicit session in the original home, cumulative rollout totals before and after', async () => {
    const s = setup();
    const req = s.req({ stageId: 'wf01-fix', mode: { kind: 'resume', sessionId: SID } });
    mkdirSync(join(req.toolHome, 'codex'), { recursive: true });
    writeRollout({ opts: { env: { CODEX_HOME: join(req.toolHome, 'codex') } } } as unknown as FakeChild, [
      '{"type":"turn_context","payload":{"model":"gpt-6-luna","effort":"high"}}',
      '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10}}}}',
    ]);
    const exec: Script = (c) => {
      writeRollout(c, ['{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":250,"output_tokens":30}}}}']);
      c.stdout.write(`{"type":"thread.started","thread_id":"${SID}"}\n{"type":"turn.started"}\n{"type":"turn.completed","usage":{"input_tokens":150,"output_tokens":20}}\n`);
      c.exit(0);
    };
    const w = fakeWorld([versionOk, loginOk, exec]);
    const r = await runCodexStage(req, s.cfg, depsFor(w));
    expect(w.spawned[2]!.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(w.spawned[2]!.args.slice(-2)).toEqual([SID, '-']);
    expect(w.spawned[2]!.args).not.toContain('--last');
    expect(r).toMatchObject({ mode: 'resume', sessionId: SID, termination: 'completed' });
    expect(r.usage.supplementary).toMatchObject({ rolloutCumulativeBefore: { input_tokens: 100, output_tokens: 10 }, rolloutCumulativeAfter: { input_tokens: 250, output_tokens: 30 } });
  });

  it('terminates at the stage deadline and keeps the partial usage it saw', async () => {
    const s = setup();
    const exec: Script = (c) => void c.stdout.write(`${SAMPLE}\n{"type":"turn.started"}\n`);
    const w = fakeWorld([versionOk, loginOk, exec], {
      onSignal: (c, sig) => {
        if (sig === 'SIGKILL') c.exit(null, 'SIGKILL');
      },
    });
    const p = runCodexStage(s.req({ deadlineAt: 1_000_000 + 60_000 }), s.cfg, depsFor(w));
    while (w.spawned.length < 3) await tick();
    await tick();
    w.advance(60_000);
    w.advance(1_000);
    const r = await p;
    expect(w.killed.map((k) => k.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(r).toMatchObject({ termination: 'stage-timeout', sessionId: SID, signal: 'SIGKILL' });
    expect(r.usage.completeness).toBe('partial');
    expect(r.usage.raw).toHaveLength(1);
  });

  it('quota exhaustion is operational and preserves incurred usage', async () => {
    const s = setup();
    const exec: Script = (c) => {
      c.stdout.write(`${SAMPLE}\n{"type":"turn.failed","error":{"message":"You've hit your usage limit. Try again at 4:05 PM."}}\n`);
      c.exit(1);
    };
    const r = await runCodexStage(s.req(), s.cfg, depsFor(fakeWorld([versionOk, loginOk, exec])));
    expect(r.termination).toBe('quota-exhausted');
    expect(r.usage).toMatchObject({ completeness: 'partial', raw: [expect.objectContaining({ input_tokens: 24763 })] });
  });

  it('missing usage stays missing; it is never zero-filled', async () => {
    const s = setup();
    const exec: Script = (c) => {
      c.stdout.write(`{"type":"thread.started","thread_id":"${SID}"}\n{"type":"turn.started"}\n{"type":"turn.completed"}\n`);
      c.exit(0);
    };
    const r = await runCodexStage(s.req(), s.cfg, depsFor(fakeWorld([versionOk, loginOk, exec])));
    expect(r).toMatchObject({ termination: 'completed', resolvedModel: null, resolvedModelSource: 'unavailable' });
    expect(r.usage).toMatchObject({ completeness: 'missing', raw: [] });
  });

  it('rejects a served model other than the one requested', async () => {
    const s = setup();
    const exec: Script = (c) => {
      writeRollout(c, ['{"type":"turn_context","payload":{"model":"gpt-6-sol"}}']);
      c.stdout.write(SAMPLE);
      c.exit(0);
    };
    const r = await runCodexStage(s.req(), s.cfg, depsFor(fakeWorld([versionOk, loginOk, exec])));
    expect(r).toMatchObject({ termination: 'model-substituted', resolvedModel: 'gpt-6-sol' });
  });

  it('refuses an unpinned CLI before any model call', async () => {
    const s = setup();
    const w = fakeWorld([(c) => (c.stdout.write('codex-cli 0.167.2\n'), c.exit(0))]);
    const r = await runCodexStage(s.req(), s.cfg, depsFor(w));
    expect(w.spawned).toHaveLength(1);
    expect(r).toMatchObject({ termination: 'runner-infrastructure-failure', terminationDetail: 'version-mismatch: want 0.169.0, got 0.167.2', toolVersion: '0.167.2' });
    expect(r.usage.completeness).toBe('missing');
    expect(existsSync(join(s.req().recordDir, 'stage.json'))).toBe(true);
  });

  it('records a missing login as auth-missing and reads no other directory', async () => {
    const s = setup({ auth: null });
    const w = fakeWorld([versionOk]);
    const r = await runCodexStage(s.req(), s.cfg, depsFor(w));
    expect(w.spawned).toHaveLength(1);
    expect(r).toMatchObject({ termination: 'auth-missing', terminationDetail: 'isolated auth home has no login' });
  });

  it('refuses API-key authentication and removes the copied credential', async () => {
    const s = setup();
    const w = fakeWorld([versionOk, (c) => (c.stdout.write('Logged in using an API key - sk-proj-***\n'), c.exit(0))]);
    const r = await runCodexStage(s.req(), s.cfg, depsFor(w));
    expect(w.spawned).toHaveLength(2);
    expect(r).toMatchObject({ termination: 'auth-missing', terminationDetail: 'api-key-auth refused (subscription login required)' });
    expect(existsSync(join(s.req().toolHome, 'codex', 'auth.json'))).toBe(false);
  });

  it('an invalid resume id fails before launch', async () => {
    const s = setup();
    const w = fakeWorld([versionOk, loginOk]);
    const r = await runCodexStage(s.req({ mode: { kind: 'resume', sessionId: 'latest' } }), s.cfg, depsFor(w));
    expect(w.spawned).toHaveLength(2);
    expect(r.termination).toBe('runner-infrastructure-failure');
    expect(r.terminationDetail).toMatch(/explicit session UUID/);
  });

  it('records stay inside the record directory and the capture stays in the tool home', async () => {
    const s = setup();
    const exec: Script = (c) => {
      expect(dirname(lastMessagePath(c)).startsWith(s.req().toolHome)).toBe(true);
      c.stdout.write(SAMPLE);
      c.exit(0);
    };
    const r = await runCodexStage(s.req(), s.cfg, depsFor(fakeWorld([versionOk, loginOk, exec])));
    expect(r.settings.argv).toContain('<capture>/last-message.md');
    expect(r.settings.argv).toContain('<workspace>');
  });
});
