/**
 * Independent evaluator entry point. Run as a separate process (see src/evaluator/supervise.ts):
 *
 *   npm run evaluate -- --snapshot <dir> --work <fresh-dir> --out <verdict.json> [--isolation required|auto|off] [--ceiling-ms 120000]
 *
 * Exit status 0 means a verdict was written (whatever its status); 2 is a usage error; 1 means the
 * evaluator crashed, in which case it still tries to write an infrastructure-failure verdict.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_CEILING_MS, evaluateSnapshot, type Verdict } from '../evaluator/evaluate.ts';
import type { IsolationMode } from '../evaluator/sandbox.ts';

function writeAtomic(path: string, verdict: Verdict | Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.partial`;
  writeFileSync(tmp, `${JSON.stringify(verdict, null, 2)}\n`);
  renameSync(tmp, path);
}

const usage = 'usage: evaluate --snapshot <dir> --work <fresh-dir> --out <verdict.json> [--isolation required|auto|off] [--ceiling-ms N]';
let values: Record<string, string | undefined>;
try {
  values = parseArgs({
    options: {
      snapshot: { type: 'string' },
      work: { type: 'string' },
      out: { type: 'string' },
      isolation: { type: 'string', default: 'required' },
      'ceiling-ms': { type: 'string', default: String(DEFAULT_CEILING_MS) },
    },
  }).values as Record<string, string | undefined>;
} catch (e) {
  console.error(`${(e as Error).message}\n${usage}`);
  process.exit(2);
}
const isolation = values.isolation as IsolationMode;
const ceilingMs = Number(values['ceiling-ms']);
if (!values.snapshot || !values.work || !values.out || !['required', 'auto', 'off'].includes(isolation) || !(ceilingMs > 0)) {
  console.error(usage);
  process.exit(2);
}

try {
  const verdict = await evaluateSnapshot({ snapshotDir: values.snapshot, workDir: values.work, isolation, ceilingMs });
  writeAtomic(values.out, verdict);
  const failed = Object.entries(verdict.behaviours).filter(([, b]) => !b.passed).map(([k]) => k);
  console.log(`evaluation ${verdict.status} (${verdict.reason}); ${verdict.passedCases}/${verdict.totalCases} cases${failed.length ? `; failing ${failed.join(', ')}` : ''}`);
  process.exit(0);
} catch (e) {
  console.error(e);
  try {
    writeAtomic(values.out, { schema: 'harness-benchmark/evaluation-crash@1', status: 'infrastructure-failure', reason: `evaluator crashed: ${(e as Error).message}` });
  } catch {
    // nothing more to do; the supervisor records the missing verdict
  }
  process.exit(1);
}
