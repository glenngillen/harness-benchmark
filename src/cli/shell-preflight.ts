/**
 * Proves that each client's shell works inside the stage sandbox, before any campaign runs.
 *
 *   npm run shell-preflight [-- --isolation required|auto] [--provider claude|codex|both]
 *
 * Runs one real workspace-write stage per client through the same adapter, environment, flags and
 * OS isolation (`buildStageIsolation`) as pilot and scored stages, with the cheaper role's model,
 * asking it to run `node --version`. The stage's events are then judged by the freeze gate's own
 * shell rule (`src/audit/shell.ts`): at least one command must succeed. Without it, a Bash tool that
 * cannot start (Claude Code's own sandbox needs socat) would go unnoticed until the records were read;
 * runner/aws/remote/campaign.sh runs this first and refuses to start a campaign when it fails.
 *
 * Uses a small amount of subscription allowance (one short turn per client). Records go to
 * `.runs/preflight/shell-<timestamp>/` (gitignored), never to records/. Prints a JSON summary.
 * Exit 0 when every checked shell works, 1 otherwise, 2 on a usage error.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_CLAUDE_AUTH_HOME, DEFAULT_CLAUDE_BIN, runClaudeStage } from '../adapters/claude.ts';
import { DEFAULT_AUTH_HOME, DEFAULT_CODEX_BIN, runCodexStage } from '../adapters/codex.ts';
import type { StageRequest, StageResult } from '../adapters/types.ts';
import { shellHealth, shellProblem, type ShellHealth } from '../audit/shell.ts';
import { hiddenRoots, publicPath } from '../evaluator/evaluate.ts';
import { usableSandboxTool, type IsolationMode } from '../evaluator/sandbox.ts';
import { BENCHMARK_ROOT } from '../fixtures.ts';
import { buildStageIsolation, stageReadable, stageSandboxPaths } from '../orchestrator/isolation.ts';
import { loadConfig, stagePath } from '../orchestrator/run.ts';
import { createWorkspace } from '../orchestrator/workspace.ts';

const root = BENCHMARK_ROOT;
const { values } = parseArgs({ options: { isolation: { type: 'string', default: 'required' }, provider: { type: 'string', default: 'both' } } });
if (!['required', 'auto'].includes(values.isolation!) || !['claude', 'codex', 'both'].includes(values.provider!)) {
  console.error('usage: shell-preflight [--isolation required|auto] [--provider claude|codex|both]');
  process.exit(2);
}
const isolation = values.isolation as IsolationMode;
const conf = loadConfig(root);
const path = stagePath();
const hidden = hiddenRoots(root);
const readable = stageReadable(root);
const tools = { sandboxExec: usableSandboxTool('sandbox-exec'), bwrap: usableSandboxTool('bwrap') };
const base = join(root, '.runs', 'preflight', `shell-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const PROMPT = 'This is a runner check. Use your shell tool to run exactly this command and nothing else: node --version\nThen reply with its output only.';

const checks = [
  { name: 'claude', role: 'AC' as const },
  { name: 'codex', role: 'CC' as const },
].filter((c) => values.provider === 'both' || values.provider === c.name);

const summary: Record<string, unknown> = { base: publicPath(base, root), isolation };
let ok = true;
for (const c of checks) {
  const role = conf.models.roles[c.role];
  const dir = join(base, c.name);
  const workspaceDir = join(dir, 'workspace');
  const toolHome = join(dir, 'home');
  const recordDir = join(dir, 'record');
  for (const d of [toolHome, recordDir]) mkdirSync(d, { recursive: true });
  let result: StageResult | null = null;
  let health: ShellHealth | null = null;
  let error: string | null = null;
  try {
    // The same Git workspace a real workflow starts from (Codex refuses to run outside a Git repository).
    createWorkspace(join(root, 'fixtures', 'scaffold'), workspaceDir, { path, gitHome: join(dir, 'git-home') });
    const req: StageRequest = {
      stageId: `shell-preflight-${c.name}`,
      role: c.role,
      requestedModel: role.requestedModel,
      effort: role.effort,
      permission: 'workspace-write',
      mode: { kind: 'fresh' },
      prompt: PROMPT,
      workspaceDir,
      toolHome,
      recordDir,
      deadlineAt: Date.now() + 4 * 60_000,
      isolation: buildStageIsolation(isolation, process.platform, tools, stageSandboxPaths({ permission: 'workspace-write', workspaceDir, toolHome, hidden, readable }), (p) => publicPath(p, root)),
    };
    result = role.tool === 'codex'
      ? await runCodexStage(req, { bin: DEFAULT_CODEX_BIN(root), toolVersion: role.toolVersion, authHome: DEFAULT_AUTH_HOME(root), path })
      : await runClaudeStage(req, { bin: DEFAULT_CLAUDE_BIN(root), toolVersion: role.toolVersion, authHome: DEFAULT_CLAUDE_AUTH_HOME(root), path });
    health = shellHealth(result.provider, readFileSync(join(recordDir, 'events.jsonl'), 'utf8'));
  } catch (e) {
    error = (e as Error).message;
  }
  const problem = error ?? (result && result.termination !== 'completed' ? `stage ended ${result.termination}${result.terminationDetail ? ` (${result.terminationDetail})` : ''}` : null) ?? shellProblem(health);
  if (problem) ok = false;
  summary[c.name] = { ok: problem === null, problem, model: role.requestedModel, termination: result?.termination ?? null, isolation: isolationMechanismOf(result), shell: health };
}

function isolationMechanismOf(r: StageResult | null): unknown {
  const s = r?.settings as { isolation?: { mechanism?: unknown } } | undefined;
  return s?.isolation?.mechanism ?? null;
}

summary.ok = ok;
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exit(ok ? 0 : 1);
