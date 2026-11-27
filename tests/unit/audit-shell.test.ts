import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { shellHealth, shellProblem } from '../../src/audit/shell.ts';

const SOCAT = 'Sandbox is required but failed to initialize: Sandbox dependencies not available: socat not installed. Restart to retry. Running it outside the sandbox (dangerouslyDisableSandbox) is not allowed either.';
const j = (o: unknown) => JSON.stringify(o);
const bashUse = (id: string) => j({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm run build' } }] } });
const otherUse = (id: string) => j({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Edit', input: {} }] } });
const result = (id: string, isError: boolean, content: unknown = isError ? SOCAT : 'ok') => j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } });
const cmd = (id: string, exit: number | null, done = true) => j({ type: done ? 'item.completed' : 'item.started', item: { id, type: 'command_execution', command: 'npm test', aggregated_output: exit === 0 ? '' : 'boom', exit_code: exit } });

describe('shellHealth: Claude Code', () => {
  it('reports a socat failure as attempted with no successes', () => {
    const h = shellHealth('anthropic', [bashUse('a'), result('a', true), bashUse('b'), result('b', true)].join('\n'));
    expect(h).toEqual({ attempted: 2, succeeded: 0, failed: 2, malformedLines: 0, firstFailure: SOCAT.slice(0, 200) });
  });

  it('counts non-error Bash results as successes and ignores other tools', () => {
    const h = shellHealth('anthropic', [otherUse('e'), result('e', true, 'edit failed'), bashUse('a'), result('a', false, [{ type: 'text', text: 'built' }]), bashUse('b'), result('b', true, 'exit 2')].join('\n'));
    expect(h).toMatchObject({ attempted: 2, succeeded: 1, failed: 1, firstFailure: 'exit 2' });
  });

  it('counts a Bash call with no result as failed', () => {
    expect(shellHealth('anthropic', bashUse('a'))).toMatchObject({ attempted: 1, succeeded: 0, firstFailure: 'no tool result recorded' });
  });

  it('skips malformed lines and counts them', () => {
    expect(shellHealth('anthropic', ['not json', '[1]', bashUse('a'), result('a', false)].join('\n'))).toMatchObject({ attempted: 1, succeeded: 1, malformedLines: 2 });
  });
});

describe('shellHealth: Codex', () => {
  it('counts completed command items by exit code and ignores the started copies', () => {
    const h = shellHealth('openai', [cmd('1', null, false), cmd('1', 0), cmd('2', null, false), cmd('2', 1)].join('\n'));
    expect(h).toMatchObject({ attempted: 2, succeeded: 1, failed: 1, firstFailure: 'exit 1: boom' });
  });

  it('counts a command that never completed as failed', () => {
    expect(shellHealth('openai', cmd('1', null, false))).toMatchObject({ attempted: 1, succeeded: 0, firstFailure: 'command never completed' });
  });
});

describe('shellProblem', () => {
  const h = (attempted: number, succeeded: number) => ({ attempted, succeeded, failed: attempted - succeeded, malformedLines: 0, firstFailure: attempted > succeeded ? 'why' : null });
  it('needs at least one successful command', () => {
    expect(shellProblem(null)).toBe('no event stream recorded');
    expect(shellProblem(h(2, 0))).toBe('all 2 shell command(s) failed (why)');
    expect(shellProblem(h(0, 0))).toBe('ran no shell command');
    expect(shellProblem(h(3, 1))).toBeNull();
  });
});

describe('isFreshImplementStage', () => {
  it('matches fresh implement stage ids only', async () => {
    const { isFreshImplementStage } = await import('../../src/audit/shell.ts');
    expect(['s1-implement', 's2-implement', 'cohort-03-b01-s01-a1--s2-implement'].every(isFreshImplementStage)).toBe(true);
    expect(['s1-implement-repair-1', 's3-fix', 's1-plan', 's2-review', 'implement'].some(isFreshImplementStage)).toBe(false);
  });
});

describe('properties', () => {
  const claudeLines = fc.array(fc.record({ ok: fc.boolean(), answered: fc.boolean() }), { maxLength: 30 });

  it('Claude: counters are consistent with the generated calls', () => {
    fc.assert(
      fc.property(claudeLines, (calls) => {
        const text = calls.flatMap((c, i) => [bashUse(`t${i}`), ...(c.answered ? [result(`t${i}`, !c.ok)] : [])]).join('\n');
        const got = shellHealth('anthropic', text);
        return got.attempted === calls.length && got.succeeded === calls.filter((c) => c.ok && c.answered).length && got.failed === got.attempted - got.succeeded;
      }),
    );
  });

  it('Codex: counters are consistent with the generated commands', () => {
    fc.assert(
      fc.property(fc.array(fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }), { maxLength: 30 }), (exits) => {
        const text = exits.map((e, i) => cmd(`c${i}`, e, e !== null)).join('\n');
        const got = shellHealth('openai', text);
        return got.attempted === exits.length && got.succeeded === exits.filter((e) => e === 0).length && got.failed === got.attempted - got.succeeded;
      }),
    );
  });

  it('never throws and keeps 0 <= succeeded <= attempted on arbitrary text', () => {
    fc.assert(
      fc.property(fc.constantFrom('anthropic', 'openai' as const), fc.string(), (p, text) => {
        const got = shellHealth(p as 'anthropic' | 'openai', text);
        return got.succeeded >= 0 && got.succeeded <= got.attempted && got.failed === got.attempted - got.succeeded;
      }),
    );
  });
});

describe('tallyShell', () => {
  it('counts working, all-failed and no-command write stages per provider with examples', async () => {
    const { tallyShell } = await import('../../src/audit/shell.ts');
    const h = (attempted: number, succeeded: number) => ({ attempted, succeeded, failed: attempted - succeeded, malformedLines: 0, firstFailure: attempted > succeeded ? 'socat not installed' : null });
    const t = tallyShell([
      { provider: 'anthropic', label: 'slot-01/s1-implement', health: h(2, 0) },
      { provider: 'anthropic', label: 'slot-02/s1-implement', health: h(0, 0) },
      { provider: 'openai', label: 'slot-03/s1-implement', health: h(5, 3) },
    ]);
    expect(t.anthropic).toEqual({ writeStages: 2, working: 0, allFailed: 1, noCommands: 1, examples: ['slot-01/s1-implement: socat not installed'] });
    expect(t.openai).toMatchObject({ writeStages: 1, working: 1, allFailed: 0, noCommands: 0 });
  });
});
