import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { bwrapArgs, sandboxExecProfile, sbplString, selectSandbox, usableSandboxTool } from '../../src/evaluator/sandbox.ts';

const paths = { hidden: ['/repo', '/home/me'], writable: ['/repo/.runs/eval-1'], readable: ['/opt/node'] };

describe('sbplString', () => {
  it('quotes and escapes for the sandbox profile language', () => {
    expect(sbplString('/a b/c')).toBe('"/a b/c"');
    expect(sbplString('/we"ird\\path')).toBe('"/we\\"ird\\\\path"');
  });

  describe('properties', () => {
    it('always yields one balanced string literal that round-trips', () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          const q = sbplString(s);
          expect(q.startsWith('"') && q.endsWith('"')).toBe(true);
          expect(JSON.parse(q.replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`))).toBe(s);
        }),
      );
    });
  });
});

describe('sandboxExecProfile', () => {
  const profile = sandboxExecProfile(paths);

  it('denies reads of hidden roots, then re-allows the evaluation workspace and toolchain', () => {
    const denyRead = profile.indexOf('(deny file-read* (subpath "/repo") (subpath "/home/me"))');
    const allowRead = profile.indexOf('(allow file-read* (subpath "/repo/.runs/eval-1") (subpath "/opt/node"))');
    expect(denyRead).toBeGreaterThan(0);
    expect(allowRead).toBeGreaterThan(denyRead);
  });

  it('confines writes to the workspace and devices and limits outbound network to loopback', () => {
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('(allow file-write* (subpath "/dev") (subpath "/repo/.runs/eval-1"))');
    expect(profile).toContain('(deny network-outbound)');
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
  });

  it('keeps parentheses balanced for arbitrary paths', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 3 }), (ps) => {
        const p = sandboxExecProfile({ hidden: ps, writable: ps, readable: ps });
        const stripped = p.replace(/"(?:[^"\\]|\\.)*"/g, '""');
        let depth = 0;
        for (const ch of stripped) {
          if (ch === '(') depth += 1;
          if (ch === ')') depth -= 1;
          expect(depth).toBeGreaterThanOrEqual(0);
        }
        expect(depth).toBe(0);
      }),
    );
  });
});

describe('bwrapArgs', () => {
  it('mounts the host read-only, hides roots behind tmpfs, then binds the workspace and toolchain', () => {
    const args = bwrapArgs(paths);
    expect(args.slice(0, 5)).toEqual(['--die-with-parent', '--ro-bind', '/', '/', '--dev']);
    const hide = args.indexOf('/repo');
    const bind = args.indexOf('/repo/.runs/eval-1');
    expect(args[hide - 1]).toBe('--tmpfs');
    expect(args[bind - 1]).toBe('--bind');
    expect(bind).toBeGreaterThan(hide);
    expect(args.slice(args.indexOf('/opt/node') - 1, args.indexOf('/opt/node') + 2)).toEqual(['--ro-bind', '/opt/node', '/opt/node']);
  });
});

describe('selectSandbox', () => {
  const which = (found: string[]) => (cmd: string) => (found.includes(cmd) ? `/usr/bin/${cmd}` : undefined);

  it('uses sandbox-exec on darwin and bwrap on linux when available', () => {
    expect(selectSandbox('auto', 'darwin', which(['sandbox-exec']), paths).mechanism).toBe('sandbox-exec');
    expect(selectSandbox('auto', 'linux', which(['bwrap']), paths).mechanism).toBe('bwrap');
  });

  it('wraps a command line for the selected mechanism', () => {
    const mac = selectSandbox('required', 'darwin', which(['sandbox-exec']), paths);
    expect(mac.wrap(['npm', 'run', 'build']).slice(0, 2)).toEqual(['/usr/bin/sandbox-exec', '-p']);
    expect(mac.wrap(['npm', 'run', 'build']).slice(-3)).toEqual(['npm', 'run', 'build']);
    const linux = selectSandbox('required', 'linux', which(['bwrap']), paths);
    expect(linux.wrap(['npm']).at(0)).toBe('/usr/bin/bwrap');
    expect(linux.wrap(['npm']).slice(-2)).toEqual(['--', 'npm']);
  });

  it('falls back to no isolation in auto mode, and refuses in required mode', () => {
    const none = selectSandbox('auto', 'linux', which([]), paths);
    expect(none.mechanism).toBe('none');
    expect(none.wrap(['npm'])).toEqual(['npm']);
    expect(() => selectSandbox('required', 'linux', which([]), paths)).toThrow(/no supported sandbox/);
    expect(selectSandbox('off', 'darwin', which(['sandbox-exec']), paths).mechanism).toBe('none');
  });
});

describe('usableSandboxTool', () => {
  const env = { PATH: '/a:/b' };
  it('returns the tool only when found and a probe sandbox succeeds', () => {
    const exists = (p: string) => p === '/b/bwrap';
    expect(usableSandboxTool('bwrap', env, exists, () => 0)).toBe('/b/bwrap');
    expect(usableSandboxTool('bwrap', env, exists, () => 1)).toBeUndefined();
    expect(usableSandboxTool('bwrap', env, () => false, () => 0)).toBeUndefined();
  });

  it('probes sandbox-exec with a trivial profile', () => {
    const calls: string[][] = [];
    usableSandboxTool('sandbox-exec', env, (p) => p === '/usr/bin/sandbox-exec', (c, a) => (calls.push([c, ...a]), 71));
    expect(calls).toEqual([['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)', '/usr/bin/true']]);
  });
});
