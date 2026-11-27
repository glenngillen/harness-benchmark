import { describe, expect, it } from 'vitest';
import { codexArgs, codexNativeSandbox } from '../../src/adapters/codex.ts';
import { isolatedLaunch, type StageIsolation } from '../../src/adapters/types.ts';
import { buildStageIsolation, stageSandboxPaths, stageSandboxProfile } from '../../src/orchestrator/isolation.ts';

const base = { workspaceDir: '/wt/.runs/ws', toolHome: '/wt/.runs/home', hidden: ['/wt', '/main', '/Users/u'], readable: ['/wt/node_modules', '/opt/node'] };

describe('stage sandbox paths', () => {
  it('implementers may write their workspace and tool home only', () => {
    expect(stageSandboxPaths({ ...base, permission: 'workspace-write' })).toEqual({ hidden: base.hidden, writable: ['/wt/.runs/home', '/wt/.runs/ws'], readable: base.readable });
  });

  it('planners and reviewers get their workspace read-only', () => {
    const p = stageSandboxPaths({ ...base, permission: 'read-only' });
    expect(p.writable).toEqual(['/wt/.runs/home']);
    expect(p.readable).toContain('/wt/.runs/ws');
  });

  it('profile denies writes and hidden reads, re-allows listed paths later, and keeps network', () => {
    const profile = stageSandboxProfile(stageSandboxPaths({ ...base, permission: 'read-only' }));
    const lines = profile.split('\n');
    expect(lines.indexOf('(deny file-write*)')).toBeLessThan(lines.findIndex((l) => l.startsWith('(allow file-write*')));
    expect(lines.find((l) => l.startsWith('(deny file-read*'))).toContain('(subpath "/wt")');
    expect(lines.at(-1)).toContain('(subpath "/wt/.runs/ws")');
    expect(lines.find((l) => l.startsWith('(allow file-write*'))).not.toContain('/wt/.runs/ws');
    expect(profile).not.toContain('network');
  });
});

describe('buildStageIsolation', () => {
  const paths = stageSandboxPaths({ ...base, permission: 'workspace-write' });
  const pub = (p: string) => p.replace('/wt', '<wt>');

  it('wraps with sandbox-exec on macOS and bwrap on Linux', () => {
    const mac = buildStageIsolation('required', 'darwin', { sandboxExec: '/usr/bin/sandbox-exec' }, paths, pub);
    expect(mac.mechanism).toBe('sandbox-exec');
    expect(mac.wrap(['claude', '-p']).slice(0, 2)).toEqual(['/usr/bin/sandbox-exec', '-p']);
    expect(mac.wrap(['claude', '-p']).slice(-2)).toEqual(['claude', '-p']);
    const linux = buildStageIsolation('required', 'linux', { bwrap: '/usr/bin/bwrap' }, paths, pub);
    expect(linux.wrap(['codex'])).toContain('--');
    expect(linux.describe()).toMatchObject({ mechanism: 'bwrap', writable: ['<wt>/.runs/home', '<wt>/.runs/ws'] });
  });

  it('required isolation without a sandbox tool refuses to launch; auto degrades visibly', () => {
    expect(() => buildStageIsolation('required', 'darwin', {}, paths, pub)).toThrow(/no supported stage sandbox/);
    expect(buildStageIsolation('auto', 'darwin', {}, paths, pub).describe()).toMatchObject({ mechanism: 'none', network: 'not isolated' });
  });

  it('isolatedLaunch prefixes the CLI argv', () => {
    const iso: StageIsolation = { mechanism: 'bwrap', wrap: (a) => ['bwrap', '--', ...a], describe: () => ({}) };
    expect(isolatedLaunch({ isolation: iso }, 'codex', ['exec'])).toEqual({ cmd: 'bwrap', args: ['--', 'codex', 'exec'] });
    expect(isolatedLaunch({}, 'codex', ['exec'])).toEqual({ cmd: 'codex', args: ['exec'] });
  });
});

describe('Codex native sandbox under an outer sandbox', () => {
  const seatbelt: StageIsolation = { mechanism: 'sandbox-exec', wrap: (a) => a, describe: () => ({}) };
  const bwrap: StageIsolation = { mechanism: 'bwrap', wrap: (a) => a, describe: () => ({}) };
  const req = { requestedModel: 'gpt-6-luna', effort: 'high', permission: 'read-only' as const, workspaceDir: '/ws' };

  it('defers to the outer Seatbelt sandbox (which cannot nest) and keeps its own elsewhere', () => {
    expect(codexNativeSandbox({ permission: 'read-only', isolation: seatbelt })).toBe('danger-full-access');
    expect(codexNativeSandbox({ permission: 'read-only', isolation: bwrap })).toBe('read-only');
    expect(codexNativeSandbox({ permission: 'workspace-write' })).toBe('workspace-write');
  });

  it('applies to fresh and resumed argv', () => {
    const fresh = codexArgs({ ...req, mode: { kind: 'fresh' }, isolation: seatbelt }, '/cap/last.md');
    expect(fresh[fresh.indexOf('--sandbox') + 1]).toBe('danger-full-access');
    const resume = codexArgs({ ...req, mode: { kind: 'resume', sessionId: '00000000-0000-4000-8000-000000000001' }, isolation: seatbelt }, '/cap/last.md');
    expect(resume).toContain('sandbox_mode="danger-full-access"');
    expect(codexArgs({ ...req, mode: { kind: 'fresh' } }, '/cap/last.md')).toContain('read-only');
  });
});
