import { describe, expect, it } from 'vitest';
import { runSupervised, type ProcessRequest } from '../../src/adapters/process.ts';
import { fakeWorld, tick } from './support/fake-process.ts';

const req = (over: Partial<ProcessRequest> = {}): ProcessRequest => ({
  cmd: 'codex',
  args: ['exec', '-'],
  cwd: '/w',
  env: { PATH: '/bin' },
  stdin: 'the prompt',
  stdoutPath: '/r/events.jsonl',
  stderrPath: '/r/stderr.txt',
  deadlineAt: 1_000_000 + 60_000,
  ...over,
});

describe('runSupervised', () => {
  it('streams stdout/stderr to files, writes the prompt to stdin, and reports the exit', async () => {
    const w = fakeWorld([
      (c) => {
        c.stdout.write('{"type":"a"}\n');
        c.stderr.write('progress\n');
        c.exit(0);
      },
    ]);
    const o = await runSupervised(req(), w.deps);
    expect(o).toMatchObject({ exitCode: 0, signal: null, timedOut: false, spawnError: null, signalsSent: [] });
    expect(w.files.get('/r/events.jsonl')).toBe('{"type":"a"}\n');
    expect(w.files.get('/r/stderr.txt')).toBe('progress\n');
    expect(w.spawned[0]!.stdinText).toBe('the prompt');
    expect(w.spawned[0]!.opts).toMatchObject({ cwd: '/w', env: { PATH: '/bin' }, detached: true });
  });

  it('terminates the whole process group at the deadline, escalating to SIGKILL after the grace period', async () => {
    const w = fakeWorld([(c) => void c.stdout.write('{"type":"thread.started"}\n')], {
      onSignal: (c, sig) => {
        if (sig === 'SIGKILL') c.exit(null, 'SIGKILL');
      },
    });
    const p = runSupervised(req({ graceMs: 2_000 }), w.deps);
    await tick();
    w.advance(60_000);
    expect(w.killed).toEqual([{ pid: -4000, signal: 'SIGTERM' }]);
    w.advance(2_000);
    const o = await p;
    expect(w.killed.map((k) => k.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(o).toMatchObject({ timedOut: true, exitCode: null, signal: 'SIGKILL', signalsSent: ['SIGTERM', 'SIGKILL'] });
    expect(w.files.get('/r/events.jsonl')).toContain('thread.started');
  });

  it('does not escalate when the group exits on SIGTERM', async () => {
    const w = fakeWorld([() => {}], { onSignal: (c, sig) => {
        if (sig === 'SIGTERM') c.exit(143);
      },
    });
    const p = runSupervised(req(), w.deps);
    await tick();
    w.advance(60_000);
    const o = await p;
    w.advance(60_000);
    expect(o).toMatchObject({ timedOut: true, exitCode: 143, signalsSent: ['SIGTERM'] });
    expect(w.killed).toHaveLength(1);
  });

  it('a deadline already in the past terminates immediately', async () => {
    const w = fakeWorld([() => {}], { onSignal: (c) => c.exit(null, 'SIGTERM') });
    const p = runSupervised(req({ deadlineAt: 0 }), w.deps);
    await tick();
    w.advance(0);
    expect((await p).timedOut).toBe(true);
  });

  it('reports a spawn failure without throwing', async () => {
    const w = fakeWorld([], { spawnThrows: new Error('ENOENT') });
    expect(await runSupervised(req(), w.deps)).toMatchObject({ exitCode: null, spawnError: 'ENOENT', timedOut: false });
  });

  it('reports an asynchronous child error', async () => {
    const w = fakeWorld([(c) => c.emitError(new Error('EACCES'))]);
    expect(await runSupervised(req(), w.deps)).toMatchObject({ spawnError: 'EACCES' });
  });
});
