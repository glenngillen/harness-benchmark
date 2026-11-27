/**
 * Live shell health of a campaign's write stages, for `runner/aws/bin/status` and
 * `bin/blocks status`. Never calls a model.
 *
 *   npm run shell-health [-- --label <records label>]   # default: the cohort's pilots and blocks
 *
 * For each provider, counts fresh implement stages that ran at least one shell command
 * successfully, that tried and had every command fail, and that ran none (src/audit/shell.ts, the
 * freeze gate's rule). Prints a WARNING line when any implement stage had every command fail, so a broken shell (for example a missing socat) shows within the first slots,
 * not after the campaign. Exit 0 always (it is a report); 2 on a usage error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { isFreshImplementStage, shellHealth, tallyShell, type ShellHealth, type ShellProvider } from '../audit/shell.ts';
import { BENCHMARK_ROOT, listFiles } from '../fixtures.ts';
import { pilotsLabel } from '../orchestrator/cohort.ts';
import { loadConfig } from '../orchestrator/run.ts';

const root = BENCHMARK_ROOT;
const { values } = parseArgs({ options: { label: { type: 'string', multiple: true } } });
const cohort = loadConfig(root).matrix.cohort;
const labels = values.label ?? [pilotsLabel(cohort), cohort];

for (const label of labels) {
  const dir = join(root, 'records', label);
  const stages: { provider: ShellProvider; label: string; health: ShellHealth }[] = [];
  if (existsSync(dir)) {
    for (const rel of listFiles(dir).filter((p) => p.endsWith('/stage.json') && p.includes('/stages/'))) {
      let st: { provider?: unknown; stageId?: unknown };
      try {
        st = JSON.parse(readFileSync(join(dir, rel), 'utf8')) as typeof st;
      } catch {
        continue;
      }
      const id = typeof st.stageId === 'string' ? st.stageId : rel;
      if (!isFreshImplementStage(rel.split('/').at(-2) ?? '')) continue;
      if (st.provider !== 'anthropic' && st.provider !== 'openai') continue;
      const events = join(dir, rel.replace(/stage\.json$/, 'events.jsonl'));
      if (!existsSync(events)) continue;
      stages.push({ provider: st.provider, label: `${relative(dir, join(dir, rel)).split('/stages/')[0]}/${id}`, health: shellHealth(st.provider, readFileSync(events, 'utf8')) });
    }
  }
  const t = tallyShell(stages);
  console.log(`shell health, records/${label}: implement stages with a working shell / all commands failed / no commands`);
  for (const [p, name] of [['anthropic', 'Claude'], ['openai', 'Codex']] as const) {
    const e = t[p];
    console.log(`  ${name.padEnd(6)} ${e.working}/${e.writeStages} working, ${e.allFailed} all failed, ${e.noCommands} none`);
    if (e.allFailed > 0) {
      console.log(`  WARNING: ${name} implement stages had every shell command fail. Stop and investigate (runner/aws/bin/blocks stop):`);
      for (const x of e.examples) console.log(`    ${x}`);
    }
  }
}
