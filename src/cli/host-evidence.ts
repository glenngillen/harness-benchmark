/**
 * Records host evidence on the machine that runs the pilots (the AWS runner calls this from
 * runner/aws/remote/campaign.sh before and after every campaign run). Never calls a model.
 *
 *   npm run host-evidence -- [--phase before-campaign|after-campaign|manual] [--runner <label>] [--out <file>]
 *
 * Runs both subscription preflights (pinned CLI and isolated login) and the OS-sandbox probe, and
 * writes them with OS, kernel, Node.js, sandbox tool version, the user-namespace kernel settings,
 * a SHA-256 of /etc/machine-id and the benchmark revision. Default output:
 * records/<cohort>-pilots/host-evidence/host-<timestamp>.json. `npm run freeze` evaluates these files.
 * Exit 0 when the file was written (whatever it shows); 2 on a usage error.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { BENCHMARK_ROOT } from '../fixtures.ts';
import { buildHostEvidence, type EvidencePhase } from '../freeze/host-evidence.ts';
import { pilotPaths } from '../orchestrator/cohort.ts';
import { probeLocalHost } from '../freeze/probe.ts';
import { captureEnvironment, defaultEnvironmentDeps } from '../orchestrator/environment.ts';

const root = BENCHMARK_ROOT;
const { values } = parseArgs({ options: { phase: { type: 'string', default: 'manual' }, runner: { type: 'string' }, out: { type: 'string' } } });
if (!['before-campaign', 'after-campaign', 'manual'].includes(values.phase!)) {
  console.error('--phase must be before-campaign, after-campaign or manual');
  process.exit(2);
}
const readOrNull = (p: string) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
const firstLine = (s: string | null) => (s === null ? null : (s.split('\n')[0] ?? '').trim() || null);

const models = JSON.parse(readFileSync(join(root, 'config', 'models.json'), 'utf8')) as { roles: Record<string, { toolVersion: string }> };
const cohort = (JSON.parse(readFileSync(join(root, 'config', 'matrix.json'), 'utf8')) as { cohort: string }).cohort;
const checkedAt = new Date();
const stamp = checkedAt.toISOString().replace(/[:.]/g, '-');
const probe = await probeLocalHost(root, { codex: models.roles.CC!.toolVersion, claude: models.roles.AC!.toolVersion }, stamp);
const toolVersion = probe.sandboxTool ? spawnSync(probe.sandboxTool, ['--version'], { encoding: 'utf8', timeout: 10_000 }) : null;
// The same machine-id hash every attempt records in its environment, so the freeze gate can bind
// the pilots to this host.
const environment = captureEnvironment(defaultEnvironmentDeps(root));

const evidence = buildHostEvidence({
  checkedAt,
  phase: values.phase as EvidencePhase,
  runner: values.runner ?? process.env.HARNESS_RUNNER_LABEL ?? null,
  machineIdSha256: environment.hostId,
  environment,
  osRelease: readOrNull('/etc/os-release'),
  codex: { ok: probe.codex.ok, toolVersion: probe.codex.toolVersion, termination: probe.codex.termination, detail: probe.codex.detail },
  claude: { ok: probe.claude.ok, toolVersion: probe.claude.toolVersion, termination: probe.claude.termination, detail: probe.claude.detail },
  sandboxTool: probe.sandboxTool,
  sandboxToolVersion: toolVersion && toolVersion.status === 0 ? firstLine(toolVersion.stdout) : null,
  kernel: {
    maxUserNamespaces: firstLine(readOrNull('/proc/sys/user/max_user_namespaces')),
    apparmorRestrictUnprivilegedUserns: firstLine(readOrNull('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')),
    unprivilegedUsernsClone: firstLine(readOrNull('/proc/sys/kernel/unprivileged_userns_clone')),
  },
});

const out = values.out ?? join(root, pilotPaths(cohort).hostEvidence, `host-${stamp}.json`);
mkdirSync(dirname(out), { recursive: true });
const text = `${JSON.stringify(evidence, null, 2)}\n`;
writeFileSync(out, text);
process.stdout.write(text);
console.error(`wrote ${relative(process.cwd(), out)}`);
