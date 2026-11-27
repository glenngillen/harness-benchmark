/**
 * SYNTHETIC host evidence and pilot facts only. Nothing here is an observation from the runner:
 * no file under records/ is read, and no CLI, sandbox or model is invoked.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  HOST_EVIDENCE_SCHEMA,
  buildHostEvidence,
  evaluateHostEvidence,
  osReleasePrettyName,
  parseHostEvidence,
  pilotEnvironment,
  type HostEvidence,
  type HostEvidenceInputs,
  type HostFacts,
  type PilotHostFacts,
} from '../../src/freeze/host-evidence.ts';
import { evaluateGate } from '../../src/freeze/gate.ts';

const REV = '1'.repeat(40);
const HOST = 'a'.repeat(64);
const PINS = { codex: '0.169.0', claude: '2.1.323' };
const NOW = new Date('2026-11-25T00:00:00Z');

const synthetic = (o: Partial<HostEvidence> = {}): HostEvidence => ({
  schema: HOST_EVIDENCE_SCHEMA,
  checkedAt: '2026-11-24T12:00:00Z',
  phase: 'after-campaign',
  runner: 'synthetic/linux-runner',
  hostId: HOST,
  os: { type: 'Linux', platform: 'linux', release: '6.8.0-1018-aws', arch: 'x64', distribution: 'Ubuntu 24.04.3 LTS' },
  node: 'v22.23.4',
  benchmarkRevision: { commit: REV, source: 'bundle' },
  preflight: {
    codex: { ok: true, toolVersion: PINS.codex, termination: null, detail: null },
    claude: { ok: true, toolVersion: PINS.claude, termination: null, detail: null },
  },
  isolation: { sandboxTool: '/usr/bin/bwrap', mechanism: 'bwrap', toolVersion: 'bubblewrap 0.9.0', kernel: { maxUserNamespaces: '63229', apparmorRestrictUnprivilegedUserns: '1', unprivilegedUsernsClone: null } },
  ...o,
});

const pilot = (o: Partial<PilotHostFacts> = {}): PilotHostFacts => ({
  conditionId: 'solo.CF.off',
  attempt: 1,
  startedAt: '2026-11-24T08:00:00Z',
  endedAt: '2026-11-24T09:00:00Z',
  environment: { platform: 'linux', release: '6.8.0-1018-aws', arch: 'x64', node: 'v22.23.4', commit: REV, hostId: HOST },
  ...o,
});

const inputs = (o: Partial<HostEvidenceInputs> = {}): HostEvidenceInputs => ({
  files: [{ path: 'records/cohort-03-pilots/host-evidence/host-1.json', content: synthetic() }],
  now: NOW,
  maxAgeDays: 14,
  pins: PINS,
  pilots: [pilot()],
  ...o,
});
const ids = (r: ReturnType<typeof evaluateHostEvidence>) => r.unmet.map((u) => u.id);

describe('evaluateHostEvidence', () => {
  it('passes the recorded preflights and sandbox tool through when the evidence holds', () => {
    const r = evaluateHostEvidence(inputs());
    expect(r.unmet).toEqual([]);
    expect(r.preflight).toEqual({ codex: { ok: true, termination: null }, claude: { ok: true, termination: null } });
    expect(r.sandboxTool).toBe('/usr/bin/bwrap');
    expect(r.chosen?.path).toBe('records/cohort-03-pilots/host-evidence/host-1.json');
  });

  it('passes a recorded auth-missing preflight through for the gate to report', () => {
    const e = synthetic({ preflight: { codex: { ok: false, toolVersion: PINS.codex, termination: 'auth-missing', detail: 'no login' }, claude: synthetic().preflight.claude } });
    const r = evaluateHostEvidence(inputs({ files: [{ path: 'h.json', content: e }] }));
    expect(r.unmet).toEqual([]);
    expect(r.preflight.codex).toEqual({ ok: false, termination: 'auth-missing' });
  });

  it('fails closed with no evidence', () => {
    const r = evaluateHostEvidence(inputs({ files: [] }));
    expect(ids(r)).toEqual(['host-evidence']);
    expect(r.preflight.codex.ok).toBe(false);
    expect(r.sandboxTool).toBeNull();
  });

  it('reports a malformed file even when a valid one exists, and then refuses the valid one', () => {
    const r = evaluateHostEvidence(inputs({ files: [...inputs().files, { path: 'bad.json', content: { parseError: 'Unexpected token' } }] }));
    expect(ids(r)).toEqual(['host-evidence:invalid']);
    expect(r.preflight.claude.ok).toBe(false);
    expect(r.sandboxTool).toBeNull();
  });

  it('is stale when older than the maximum age', () => {
    const r = evaluateHostEvidence(inputs({ now: new Date('2026-12-20T00:00:00Z') }));
    expect(ids(r)).toEqual(['host-evidence:stale']);
  });

  it('is stale when taken before the latest pilot ended', () => {
    const r = evaluateHostEvidence(inputs({ pilots: [pilot({ endedAt: '2026-11-24T13:00:00Z' })] }));
    expect(ids(r)).toEqual(['host-evidence:stale']);
  });

  it('uses the newest file, so a later after-campaign record covers a later pilot', () => {
    const files = [
      { path: 'a.json', content: synthetic({ checkedAt: '2026-11-24T07:00:00Z', phase: 'before-campaign' }) },
      { path: 'b.json', content: synthetic({ checkedAt: '2026-11-24T14:00:00Z' }) },
    ];
    const r = evaluateHostEvidence(inputs({ files, pilots: [pilot({ endedAt: '2026-11-24T13:00:00Z' })] }));
    expect(r.unmet).toEqual([]);
    expect(r.chosen?.path).toBe('b.json');
  });

  it('is inconsistent when tool versions differ from the pins', () => {
    const r = evaluateHostEvidence(inputs({ pins: { codex: '0.170.0', claude: PINS.claude } }));
    expect(ids(r)).toEqual(['host-evidence:inconsistent']);
    expect(r.unmet[0]!.detail).toMatch(/Codex CLI 0\.169\.0 recorded, pinned 0\.170\.0/);
  });

  it('is inconsistent when a pilot ran on another kernel or without an environment', () => {
    const r = evaluateHostEvidence(inputs({ pilots: [pilot({ environment: { ...pilot().environment!, release: '6.8.0-9999-aws' } }), pilot({ attempt: 2, environment: null })] }));
    expect(ids(r)).toEqual(['host-evidence:inconsistent']);
    expect(r.unmet[0]!.detail).toMatch(/kernel 6\.8\.0-9999-aws/);
    expect(r.unmet[0]!.detail).toMatch(/#2 recorded no environment/);
  });

  it('is inconsistent when a pilot revision has no evidence from the same host', () => {
    const other = '2'.repeat(40);
    const r = evaluateHostEvidence(inputs({ pilots: [pilot({ environment: { ...pilot().environment!, commit: other } })] }));
    expect(r.unmet[0]!.detail).toMatch(/revision 222222222222 has no host evidence/);
    const files = [...inputs().files, { path: 'x.json', content: synthetic({ checkedAt: '2026-11-24T07:00:00Z', benchmarkRevision: { commit: other, source: 'bundle' } }) }];
    expect(evaluateHostEvidence(inputs({ files, pilots: [pilot({ environment: { ...pilot().environment!, commit: other } })] })).unmet).toEqual([]);
  });

  it('does not accept evidence from another host for a pilot revision', () => {
    const other = '2'.repeat(40);
    const files = [...inputs().files, { path: 'x.json', content: synthetic({ checkedAt: '2026-11-24T07:00:00Z', hostId: 'b'.repeat(64), benchmarkRevision: { commit: other, source: 'git' } }) }];
    expect(ids(evaluateHostEvidence(inputs({ files, pilots: [pilot({ environment: { ...pilot().environment!, commit: other } })] })))).toEqual(['host-evidence:inconsistent']);
  });

  it('is inconsistent when dated in the future or without a revision', () => {
    expect(ids(evaluateHostEvidence(inputs({ files: [{ path: 'f.json', content: synthetic({ checkedAt: '2026-11-26T00:00:00Z' }) }] })))).toEqual(['host-evidence:inconsistent']);
    expect(ids(evaluateHostEvidence(inputs({ pilots: [], files: [{ path: 'f.json', content: synthetic({ benchmarkRevision: { commit: null, source: null } }) }] })))).toEqual(['host-evidence:inconsistent']);
  });

  it('rejects a non-positive maximum age', () => {
    expect(ids(evaluateHostEvidence(inputs({ maxAgeDays: 0 })))).toEqual(['host-evidence:stale']);
  });
});

describe('evaluateGate with host evidence', () => {
  it('adds host-evidence conditions to the unmet list and is not ready', () => {
    const host = evaluateHostEvidence(inputs({ files: [] }));
    const gate = evaluateGate({
      conditions: [],
      plans: {},
      attempts: [],
      preflight: host.preflight,
      sandboxTool: host.sandboxTool,
      scheduleReproduces: true,
      usageSemantics: { codex: { status: 'verified', turnCompletedScope: 'per-turn', cachedInputSubsetOfInput: true, reasoningIncludedInOutput: true } },
      priceSnapshot: { present: true },
      safeguards: [],
      repetitions: 10,
      hostEvidence: host.unmet,
    });
    expect(gate.ready).toBe(false);
    expect(gate.unmet.map((u) => u.id).slice(0, 4)).toEqual(['host-evidence', 'subscription-access:codex', 'subscription-access:claude', 'isolation']);
  });
});

describe('inconsistent host identity and sandbox tool (synthetic regressions)', () => {
  const darwin = (o: Partial<HostEvidence> = {}) =>
    synthetic({ hostId: null, os: { type: 'Darwin', platform: 'darwin', release: '25.6.0', arch: 'arm64', distribution: null }, isolation: { ...synthetic().isolation, sandboxTool: '/usr/bin/sandbox-exec', mechanism: 'sandbox-exec' }, ...o });
  const darwinPilot = (commit: string) => pilot({ environment: { platform: 'darwin', release: '25.6.0', arch: 'arm64', node: 'v22.23.4', commit, hostId: null } });

  it('rejects the reviewed reproduction: no host id, /usr/bin/false recorded as bwrap', () => {
    const content = synthetic({ hostId: null, isolation: { ...synthetic().isolation, sandboxTool: '/usr/bin/false', mechanism: 'bwrap' } });
    expect(parseHostEvidence(content).ok).toBe(false);
    const r = evaluateHostEvidence(inputs({ files: [{ path: 'f.json', content }] }));
    expect(ids(r)).toEqual(['host-evidence:invalid', 'host-evidence']);
    expect(r.preflight.codex.ok || r.preflight.claude.ok).toBe(false);
    expect(r.sandboxTool).toBeNull();
  });

  it('rejects a tool path whose basename names the other mechanism', () => {
    const r = parseHostEvidence({ ...synthetic(), isolation: { ...synthetic().isolation, sandboxTool: '/usr/bin/sandbox-exec', mechanism: 'bwrap' } });
    expect(r.ok).toBe(false);
    expect(parseHostEvidence({ ...synthetic(), isolation: { ...synthetic().isolation, sandboxTool: '/opt/bwrap-wrapper', mechanism: 'bwrap' } }).ok).toBe(false);
  });

  it('treats Linux evidence without a host identity as inconsistent and unusable', () => {
    const r = evaluateHostEvidence(inputs({ files: [{ path: 'f.json', content: synthetic({ hostId: null }) }] }));
    expect(ids(r)).toEqual(['host-evidence:inconsistent']);
    expect(r.unmet[0]!.detail).toMatch(/no host identity/);
    expect(r.preflight.codex.ok || r.preflight.claude.ok).toBe(false);
    expect(r.sandboxTool).toBeNull();
  });

  it('treats sandbox-exec on a Linux host as inconsistent', () => {
    const r = evaluateHostEvidence(inputs({ files: [{ path: 'f.json', content: synthetic({ isolation: { ...synthetic().isolation, sandboxTool: '/usr/bin/sandbox-exec', mechanism: 'sandbox-exec' } }) }] }));
    expect(ids(r)).toEqual(['host-evidence:inconsistent']);
    expect(r.sandboxTool).toBeNull();
  });

  it('never treats two files without a host identity as the same host', () => {
    const other = '2'.repeat(40);
    const files = [
      { path: 'a.json', content: darwin({ checkedAt: '2026-11-24T07:00:00Z', benchmarkRevision: { commit: other, source: 'git' } }) },
      { path: 'b.json', content: darwin() },
    ];
    const r = evaluateHostEvidence(inputs({ files, pilots: [darwinPilot(other)] }));
    expect(ids(r)).toEqual(['host-evidence:inconsistent']);
    expect(r.sandboxTool).toBeNull();
    // Without a host identity on either side, not even the chosen file's own revision is covered.
    const own = evaluateHostEvidence(inputs({ files, pilots: [darwinPilot(REV)] }));
    expect(ids(own)).toEqual(['host-evidence:inconsistent']);
    expect(own.unmet[0]!.detail).toMatch(/no host identity/);
  });

  it('the gate rejects a sandbox tool that is neither bwrap nor sandbox-exec', () => {
    const base = {
      conditions: [],
      plans: {},
      attempts: [],
      preflight: { codex: { ok: true, termination: null }, claude: { ok: true, termination: null } },
      scheduleReproduces: true,
      usageSemantics: { codex: { status: 'verified', turnCompletedScope: 'per-turn', cachedInputSubsetOfInput: true, reasoningIncludedInOutput: true } },
      priceSnapshot: { present: true },
      safeguards: [],
      repetitions: 10,
    } as unknown as Parameters<typeof evaluateGate>[0];
    expect(evaluateGate({ ...base, sandboxTool: '/usr/bin/false' }).unmet.map((u) => u.id)).toContain('isolation');
    expect(evaluateGate({ ...base, sandboxTool: '/usr/bin/bwrap' }).unmet.map((u) => u.id)).not.toContain('isolation');
  });

  it('property: a tool whose basename is not the recorded mechanism never parses', () => {
    fc.assert(fc.property(fc.string({ maxLength: 30 }), fc.constantFrom('bwrap' as const, 'sandbox-exec' as const), (tool, mechanism) => {
      fc.pre(tool.split('/').at(-1) !== mechanism);
      expect(parseHostEvidence({ ...synthetic(), isolation: { ...synthetic().isolation, sandboxTool: tool, mechanism } }).ok).toBe(false);
    }));
  });
});

describe('parseHostEvidence', () => {
  it('rejects a tool without a mechanism', () => {
    const r = parseHostEvidence({ ...synthetic(), isolation: { ...synthetic().isolation, mechanism: null } });
    expect(r.ok).toBe(false);
  });
  it('rejects an abbreviated revision', () => {
    expect(parseHostEvidence({ ...synthetic(), benchmarkRevision: { commit: 'abc', source: 'git' } }).ok).toBe(false);
  });
});

describe('buildHostEvidence', () => {
  const facts = (o: Partial<HostFacts> = {}): HostFacts => ({
    checkedAt: new Date('2026-11-24T12:00:00Z'),
    phase: 'after-campaign',
    runner: ' synthetic/linux-runner ',
    machineIdSha256: HOST,
    environment: { os: { type: 'Linux', platform: 'linux', release: '6.8.0-1018-aws', arch: 'x64' }, node: 'v22.23.4', benchmarkRevision: { commit: REV, source: 'bundle' } },
    osRelease: 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\n',
    codex: synthetic().preflight.codex,
    claude: synthetic().preflight.claude,
    sandboxTool: '/usr/bin/bwrap',
    sandboxToolVersion: 'bubblewrap 0.9.0\n',
    kernel: synthetic().isolation.kernel,
    ...o,
  });

  it('assembles a record equal to the synthetic evidence', () => {
    expect(buildHostEvidence(facts())).toEqual(synthetic({ checkedAt: '2026-11-24T12:00:00.000Z' }));
  });

  it('labels a Git revision and drops an unrecognised sandbox tool', () => {
    const e = buildHostEvidence(facts({ environment: { ...facts().environment, benchmarkRevision: { commit: REV } }, sandboxTool: '/usr/bin/firejail' }));
    expect(e.benchmarkRevision).toEqual({ commit: REV, source: 'git' });
    expect(e.isolation).toMatchObject({ sandboxTool: null, mechanism: null });
  });
});

describe('pilot host identity binding (synthetic regressions)', () => {
  // Two synthetic hosts built from the same image: identical OS, kernel, architecture, Node.js and
  // revision. Only the machine-id hash tells them apart.
  const HOST_B = 'b'.repeat(64);
  const onB = (o: Partial<PilotHostFacts> = {}) => pilot({ environment: { ...pilot().environment!, hostId: HOST_B }, ...o });

  it('rejects the reviewed reproduction: evidence from host B for pilots recorded on host A', () => {
    const r = evaluateHostEvidence(inputs({ files: [{ path: 'f.json', content: synthetic({ hostId: HOST_B }) }] }));
    expect(ids(r)).toEqual(['host-evidence:inconsistent']);
    expect(r.unmet[0]!.detail).toMatch(/solo\.CF\.off#1: host aaaaaaaaaaaa/);
    expect(r.preflight.codex.ok || r.preflight.claude.ok).toBe(false);
    expect(r.sandboxTool).toBeNull();
  });

  it('rejects pilots from host B against evidence from host A, and accepts them against host B', () => {
    expect(ids(evaluateHostEvidence(inputs({ pilots: [onB()] })))).toEqual(['host-evidence:inconsistent']);
    expect(evaluateHostEvidence(inputs({ files: [{ path: 'f.json', content: synthetic({ hostId: HOST_B }) }], pilots: [onB()] })).unmet).toEqual([]);
  });

  it('does not let a newer file from host A cover pilots that ran on host B', () => {
    const files = [
      { path: 'b.json', content: synthetic({ checkedAt: '2026-11-24T10:00:00Z', hostId: HOST_B }) },
      { path: 'a.json', content: synthetic({ checkedAt: '2026-11-24T12:00:00Z' }) },
    ];
    const r = evaluateHostEvidence(inputs({ files, pilots: [pilot(), onB({ attempt: 2 })] }));
    expect(r.chosen?.path).toBe('a.json');
    expect(ids(r)).toEqual(['host-evidence:inconsistent']);
    expect(r.unmet[0]!.detail).toMatch(/#2: host bbbbbbbbbbbb/);
  });

  it('fails closed on a pilot without a recorded host identity', () => {
    const r = evaluateHostEvidence(inputs({ pilots: [pilot({ environment: { ...pilot().environment!, hostId: null } })] }));
    expect(ids(r)).toEqual(['host-evidence:inconsistent']);
    expect(r.unmet[0]!.detail).toMatch(/#1: no host identity/);
    expect(r.sandboxTool).toBeNull();
  });

  it('the gate is not ready when the pilots ran on another host', () => {
    const host = evaluateHostEvidence(inputs({ pilots: [onB()] }));
    const gate = evaluateGate({
      conditions: [],
      plans: {},
      attempts: [],
      preflight: host.preflight,
      sandboxTool: host.sandboxTool,
      scheduleReproduces: true,
      usageSemantics: { codex: { status: 'verified', turnCompletedScope: 'per-turn', cachedInputSubsetOfInput: true, reasoningIncludedInOutput: true } },
      priceSnapshot: { present: true },
      safeguards: [],
      repetitions: 10,
      hostEvidence: host.unmet,
    });
    expect(gate.ready).toBe(false);
    expect(gate.unmet.map((u) => u.id)).toEqual(expect.arrayContaining(['host-evidence:inconsistent', 'subscription-access:codex', 'subscription-access:claude', 'isolation']));
  });

  it('property: a pilot whose host identity differs from the evidence never yields usable gate inputs', () => {
    const id = fc.option(fc.stringMatching(/^[0-9a-f]{64}$/));
    fc.assert(fc.property(id, id, (evidenceHost, pilotHost) => {
      fc.pre(evidenceHost === null || pilotHost !== evidenceHost);
      const r = evaluateHostEvidence(inputs({ files: [{ path: 'f.json', content: synthetic({ hostId: evidenceHost }) }], pilots: [pilot({ environment: { ...pilot().environment!, hostId: pilotHost } })] }));
      expect(r.unmet.map((u) => u.id)).toContain('host-evidence:inconsistent');
      expect(r.preflight.codex.ok || r.preflight.claude.ok).toBe(false);
      expect(r.sandboxTool).toBeNull();
    }));
  });
});

describe('osReleasePrettyName and pilotEnvironment', () => {
  it('reads PRETTY_NAME with or without quotes', () => {
    expect(osReleasePrettyName('PRETTY_NAME="Ubuntu 24.04 LTS"')).toBe('Ubuntu 24.04 LTS');
    expect(osReleasePrettyName("PRETTY_NAME='Debian'")).toBe('Debian');
    expect(osReleasePrettyName('NAME=x')).toBeNull();
  });
  it('extracts comparable facts from an attempt environment', () => {
    expect(pilotEnvironment({ os: { platform: 'linux', release: 'r', arch: 'x64' }, node: 'v1', hostId: HOST, benchmarkRevision: { commit: REV } })).toEqual({ platform: 'linux', release: 'r', arch: 'x64', node: 'v1', commit: REV, hostId: HOST });
    // A missing or malformed host identity is carried as null, which the evaluation refuses.
    expect(pilotEnvironment({ os: { platform: 'linux', release: 'r', arch: 'x64' }, node: 'v1', benchmarkRevision: { commit: REV } })?.hostId).toBeNull();
    expect(pilotEnvironment({ os: { platform: 'linux', release: 'r', arch: 'x64' }, node: 'v1', hostId: 'machine-1', benchmarkRevision: { commit: REV } })?.hostId).toBeNull();
    expect(pilotEnvironment(undefined)).toBeNull();
  });
});

describe('properties', () => {
  const hostFacts = fc.record({
    checkedAt: fc.date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2030-01-01T00:00:00Z'), noInvalidDate: true }),
    phase: fc.constantFrom('before-campaign', 'after-campaign', 'manual') as fc.Arbitrary<HostFacts['phase']>,
    runner: fc.option(fc.string({ maxLength: 20 })),
    machineIdSha256: fc.option(fc.string({ maxLength: 64 })),
    environment: fc.record({
      os: fc.record({ type: fc.string({ minLength: 1, maxLength: 8 }), platform: fc.string({ minLength: 1, maxLength: 8 }), release: fc.string({ minLength: 1, maxLength: 12 }), arch: fc.string({ minLength: 1, maxLength: 6 }) }),
      node: fc.string({ minLength: 1, maxLength: 10 }),
      benchmarkRevision: fc.record({ commit: fc.option(fc.stringMatching(/^[0-9a-f]{40}$/)), source: fc.constantFrom(undefined, 'bundle' as const) }),
    }),
    osRelease: fc.option(fc.string({ maxLength: 60 })),
    codex: fc.record({ ok: fc.boolean(), toolVersion: fc.option(fc.string({ maxLength: 8 })), termination: fc.option(fc.string({ maxLength: 8 })), detail: fc.option(fc.string({ maxLength: 8 })) }),
    claude: fc.record({ ok: fc.boolean(), toolVersion: fc.option(fc.string({ maxLength: 8 })), termination: fc.option(fc.string({ maxLength: 8 })), detail: fc.option(fc.string({ maxLength: 8 })) }),
    sandboxTool: fc.option(fc.constantFrom('/usr/bin/bwrap', '/usr/bin/sandbox-exec', '/bin/other')),
    sandboxToolVersion: fc.option(fc.string({ maxLength: 20 })),
    kernel: fc.record({ maxUserNamespaces: fc.option(fc.string({ maxLength: 6 })), apparmorRestrictUnprivilegedUserns: fc.option(fc.string({ maxLength: 2 })), unprivilegedUsernsClone: fc.option(fc.string({ maxLength: 2 })) }),
  }) as fc.Arbitrary<HostFacts>;

  it('every built record parses back to itself', () => {
    fc.assert(fc.property(hostFacts, (f) => {
      const e = buildHostEvidence(f);
      expect(parseHostEvidence(JSON.parse(JSON.stringify(e)))).toEqual({ ok: true, evidence: e });
    }));
  });

  it('parseHostEvidence and osReleasePrettyName never throw', () => {
    fc.assert(fc.property(fc.anything(), fc.string(), (x, s) => {
      expect(() => parseHostEvidence(x)).not.toThrow();
      expect(() => osReleasePrettyName(s)).not.toThrow();
    }));
  });

  it('fails closed: the gate inputs are only ok when no host-evidence condition is unmet', () => {
    const file = fc.oneof(fc.constant(synthetic() as unknown), fc.anything());
    fc.assert(fc.property(fc.array(file, { maxLength: 4 }), fc.integer({ min: -3, max: 30 }), (contents, ageDays) => {
      const r = evaluateHostEvidence(inputs({ files: contents.map((content, n) => ({ path: `f${n}.json`, content })), maxAgeDays: ageDays }));
      if (r.unmet.length > 0) {
        expect(r.preflight.codex.ok || r.preflight.claude.ok).toBe(false);
        expect(r.sandboxTool).toBeNull();
      }
    }));
  });

  it('the chosen file does not depend on listing order', () => {
    const dated = fc.uniqueArray(fc.integer({ min: 0, max: 23 }), { maxLength: 5 }).map((hs) => hs.map((h) => ({ path: `h${h}.json`, content: synthetic({ checkedAt: `2026-11-24T${String(h).padStart(2, '0')}:30:00Z` }) })));
    fc.assert(fc.property(dated, (files) => {
      const a = evaluateHostEvidence(inputs({ files, pilots: [] }));
      const b = evaluateHostEvidence(inputs({ files: [...files].reverse(), pilots: [] }));
      expect(b.chosen?.path ?? null).toBe(a.chosen?.path ?? null);
    }));
  });
});
