/**
 * Campaign entry point (concurrency one).
 *
 *   npm run schedule                 # regenerate config/schedule.json from config/matrix.json
 *   npm run schedule -- --check      # verify the committed schedule reproduces from the seed
 *   npm run campaign -- --pilots [--isolation required|auto] [--retry-unexercised] [--dry-run]
 *   npm run campaign -- --block 1    [--dry-run]
 *
 * Scored blocks always run with `--isolation required`. Rerun the same command after any
 * interruption or pause: finished slots are skipped and interrupted attempts are replaced (see
 * src/orchestrator/campaign.ts). With `--pilots --retry-unexercised`, a configuration whose finished
 * pilots never exercised every stage gets one fresh attempt per invocation; earlier attempts are kept.
 * The option is rejected for scored blocks: scored failures are never retried. Exit 0: complete. Exit 75: paused (quota, access, or replacements
 * exhausted; the reason is printed). Exit 2: usage error.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BENCHMARK_ROOT } from '../fixtures.ts';
import { runCampaign } from '../orchestrator/campaign.ts';
import { workflowPlan } from '../orchestrator/plan.ts';
import { pilotsLabel } from '../orchestrator/cohort.ts';
import { defaultCampaign, loadConfig } from '../orchestrator/run.ts';
import { generateSchedule, parseConditionId, pilotSlots, renderSchedule, type MatrixConfig } from '../orchestrator/schedule.ts';
import type { IsolationMode } from '../evaluator/sandbox.ts';

const [command, ...rest] = process.argv.slice(2);
const schedulePath = join(BENCHMARK_ROOT, 'config', 'schedule.json');

if (command === 'schedule') {
  const { values } = parseArgs({ args: rest, options: { check: { type: 'boolean', default: false } } });
  const matrix = JSON.parse(readFileSync(join(BENCHMARK_ROOT, 'config', 'matrix.json'), 'utf8')) as MatrixConfig;
  const text = renderSchedule(generateSchedule(matrix));
  if (values.check) {
    const ok = readFileSync(schedulePath, 'utf8') === text;
    console.log(ok ? 'config/schedule.json reproduces from the seed' : 'config/schedule.json does NOT match the seeded schedule');
    process.exit(ok ? 0 : 1);
  }
  writeFileSync(schedulePath, text);
  console.log(`wrote ${schedulePath}`);
  process.exit(0);
}

if (command !== 'run') {
  console.error('usage: campaign schedule [--check] | campaign run (--pilots [--retry-unexercised] | --block N) [--isolation required|auto] [--dry-run]');
  process.exit(2);
}

const { values } = parseArgs({
  args: rest,
  options: { pilots: { type: 'boolean', default: false }, block: { type: 'string' }, isolation: { type: 'string', default: 'required' }, 'retry-unexercised': { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false } },
});
const isolation = values.isolation as IsolationMode;
const conf = loadConfig();
const block = values.block === undefined ? null : Number(values.block);
if (values.pilots === (block !== null) || (block !== null && !(Number.isInteger(block) && block >= 1 && block <= conf.schedule.blocks.length)) || !['required', 'auto'].includes(isolation)) {
  console.error('choose exactly one of --pilots or --block 1..10; --isolation must be required or auto');
  process.exit(2);
}
if (block !== null && values['retry-unexercised']) {
  console.error('--retry-unexercised applies to pilots only; scored failures are never retried');
  process.exit(2);
}
if (block !== null && isolation !== 'required') {
  console.error('scored blocks require --isolation required');
  process.exit(2);
}
const label = values.pilots ? pilotsLabel(conf.matrix.cohort) : conf.matrix.cohort;
const slots = values.pilots ? pilotSlots(conf.matrix) : conf.schedule.blocks[block! - 1]!.slots;

if (values['dry-run']) {
  for (const s of slots) {
    const plan = workflowPlan(parseConditionId(s.conditionId), conf.limits);
    console.log(`${label} block ${s.block} slot ${String(s.slot).padStart(2, '0')} ${s.conditionId.padEnd(18)} ${plan.map((p) => `${p.kind}:${p.role}${p.session.kind === 'resume' ? '(resume)' : ''}/${p.budgetMs / 60_000}m`).join(' -> ')}`);
  }
  process.exit(0);
}

const { cfg, deps } = defaultCampaign({ label, slots, isolation, retryUnexercisedPilots: values['retry-unexercised'] });
const result = await runCampaign(cfg, deps);
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === 'complete' ? 0 : 75);
