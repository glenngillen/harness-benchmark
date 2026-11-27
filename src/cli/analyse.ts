/**
 * Credential-free analysis of saved records: tables, a summary and figures.
 *
 *   npm run analyse -- --label cohort-03                    # scored cohort (needs all 240 workflows)
 *   npm run analyse -- --label cohort-03 --allow-incomplete # interim, figures marked methodology-only
 *   npm run analyse -- --label pilot-01                     # pilots: tables only, no schedule checks
 *
 * Reads records/<label>/ (accounting regenerated in memory with the dated price snapshot) and the
 * frozen config. Writes results/<label>-*.{json,csv,md}; for a complete scored cohort, also
 * figures/<wf>-<figure>.{svg,csv} into the draft article directory (or --figures-dir).
 * Starts no model process and needs no credentials.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BENCHMARK_ROOT } from '../fixtures.ts';
import { aggregate, AnalysisValidationError, type Dataset } from '../analysis/aggregate.ts';
import { allFigures } from '../analysis/figures.ts';
import { loadAnalysisConfig, readAuditStatuses, readCampaign } from '../analysis/load.ts';
import { conditionsCsv, operationalCsv, rolesCsv, summaryMarkdown, workflowsCsv } from '../analysis/tables.ts';

const { values } = parseArgs({
  options: {
    label: { type: 'string' },
    'results-dir': { type: 'string' },
    'figures-dir': { type: 'string' },
    'allow-incomplete': { type: 'boolean', default: false },
  },
});
const label = values.label;
if (!label || !/^[a-z0-9][a-z0-9-]*$/.test(label)) {
  console.error('usage: npm run analyse -- --label <campaign-label> [--allow-incomplete] [--results-dir DIR] [--figures-dir DIR]');
  process.exit(2);
}
const cfg = loadAnalysisConfig(BENCHMARK_ROOT);
// Any cohort-NN label is a scored cohort. A new cohort keeps the matrix, schedule and roles (only the
// label differs; methodology section 14), so each cohort is analysed under its own label.
const dataset: Dataset = /^cohort-\d{2}$/.test(label) ? 'observed' : 'pilot';
if (dataset === 'observed') {
  cfg.matrix = { ...cfg.matrix, cohort: label };
  cfg.schedule = { ...cfg.schedule, cohort: label };
}
const records = readCampaign(BENCHMARK_ROOT, label);
if (records.length === 0) {
  console.error(`no attempt records under records/${label}; nothing to analyse`);
  process.exit(1);
}

let analysis;
try {
  analysis = aggregate(records, { label, dataset, matrix: cfg.matrix, schedule: dataset === 'observed' ? cfg.schedule : null, roles: cfg.roles, bootstrap: cfg.bootstrap, ...(dataset === 'observed' ? { audits: readAuditStatuses(BENCHMARK_ROOT, label) } : {}) });
} catch (e) {
  if (e instanceof AnalysisValidationError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}

const resultsDir = resolve(BENCHMARK_ROOT, values['results-dir'] ?? 'results');
mkdirSync(resultsDir, { recursive: true });
const out: string[] = [];
const write = (dir: string, name: string, body: string) => {
  writeFileSync(join(dir, name), body);
  out.push(relative(process.cwd(), join(dir, name)));
};
write(resultsDir, `${label}-analysis.json`, `${JSON.stringify(analysis, null, 2)}\n`);
write(resultsDir, `${label}-summary.md`, summaryMarkdown(analysis, cfg.snapshotDate));
write(resultsDir, `${label}-operational.csv`, operationalCsv(analysis));
for (const wf of Object.keys(analysis.workflows)) {
  write(resultsDir, `${label}-${wf}-conditions.csv`, conditionsCsv(analysis, wf));
  write(resultsDir, `${label}-${wf}-workflows.csv`, workflowsCsv(analysis, wf));
  write(resultsDir, `${label}-${wf}-roles.csv`, rolesCsv(analysis, wf));
}

const complete = dataset === 'observed' && analysis.completeness.complete;
const figuresWanted = complete || values['allow-incomplete'] || values['figures-dir'] !== undefined;
if (figuresWanted) {
  const figuresDir = resolve(BENCHMARK_ROOT, values['figures-dir'] ?? '../../drafts/harness-economics/figures');
  mkdirSync(figuresDir, { recursive: true });
  for (const f of allFigures(analysis, { snapshotDate: cfg.snapshotDate, ceilingMinutes: cfg.ceilingMinutes })) {
    write(figuresDir, `${f.name}.svg`, f.svg);
    write(figuresDir, `${f.name}.csv`, f.csv);
  }
}

for (const p of out) console.log(p);
console.log(`${analysis.completeness.scoredSlots}/${analysis.completeness.scheduledSlots} scored workflows; ${analysis.operational.attempts} operational attempt(s); dataset=${dataset}`);
const auditGaps = analysis.completeness.audit?.blocks.filter((b) => b.status !== 'complete') ?? [];
if (auditGaps.length) console.log(`quota audit incomplete: ${auditGaps.map((b) => `block ${b.block} ${b.status}${b.pendingFlags ? ` (${b.pendingFlags} pending flag(s))` : ''}${b.unscanned.length ? ` (${b.unscanned.length} unscanned)` : ''}${b.stalePatterns ? ' (pattern list changed since the audit)' : ''}`).join('; ')}`);
if (!complete && dataset === 'observed') console.log(`INCOMPLETE campaign: ${figuresWanted ? 'figures are labelled methodology-only' : 'figures not written (pass --allow-incomplete for methodology-only figures)'}`);
