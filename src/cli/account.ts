/**
 * Regenerate per-attempt accounting from saved records (no credentials, no model processes).
 *
 *   npm run account -- --label cohort-03      # every attempt under records/cohort-03
 *   npm run account -- --label pilot-01
 *
 * Writes `accounting.json` beside each `attempt.json` and prints one line per attempt.
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BENCHMARK_ROOT } from '../fixtures.ts';
import { accountTree, loadAccountingContext } from '../accounting/tree.ts';
import { auditOverlay } from '../audit/files.ts';

const { values } = parseArgs({ options: { label: { type: 'string' } } });
if (!values.label || !/^[a-z0-9][a-z0-9-]*$/.test(values.label)) {
  console.error('usage: npm run account -- --label <campaign-label>');
  process.exit(2);
}
const recordsRoot = join(BENCHMARK_ROOT, 'records', values.label);
// Quota audit decisions apply here as in the analysis: a reclassified attempt is accounted as operational.
const written = accountTree(recordsRoot, loadAccountingContext(BENCHMARK_ROOT), auditOverlay(BENCHMARK_ROOT, recordsRoot));
for (const { path, record } of written) {
  const c = record.totals.cost;
  const money = c.status === 'exact' ? `$${c.usd!.toFixed(6)}` : c.status === 'bounded' ? `$${c.lowerUsd!.toFixed(6)}–$${c.upperUsd!.toFixed(6)} (bounds)` : c.status === 'lower-bound' ? `≥ $${c.lowerUsd!.toFixed(6)} (lower bound)` : 'unavailable';
  console.log(`${path}\t${record.outcome ?? record.phase}\tmeasurement=${record.measurement}\t${money}`);
}
console.log(`${written.length} attempt(s) accounted`);
