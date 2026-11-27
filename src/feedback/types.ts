/**
 * Records of the deterministic build-time feedback loop (methodology section 5). A check run is
 * the runner's execution of its protected build, smoke and contract suites on a copy of the
 * workspace; it is never the independent evaluation and never implies acceptance.
 */
import type { FixedChange } from '../evaluator/workspace.ts';

export const CHECK_RUN_SCHEMA = 'harness-benchmark/check-run@1';
export const SUITES = ['build', 'smoke', 'contract'] as const;
export type SuiteId = (typeof SUITES)[number];

export interface CheckOutcome {
  name: string;
  title: string;
  passed: boolean;
  /** Expected versus observed, on disclosed example data only. */
  detail: string;
}

export interface SuiteOutcome {
  suite: SuiteId;
  /** `not-run` follows a failed build; `timed-out` means the check ceiling was reached. */
  status: 'passed' | 'failed' | 'not-run' | 'timed-out';
  checks: CheckOutcome[];
  /** Tail of the suite command's own output (compiler output for `build`). */
  output: string[];
  /** Tail of the app's stderr captured by the suite. */
  stderr: { server: string[]; worker: string[] };
  durationMs: number;
}

export interface CheckRun {
  schema: typeof CHECK_RUN_SCHEMA;
  /** `infrastructure-failure` is operational: the runner could not operate the checks. */
  status: 'passed' | 'failed' | 'infrastructure-failure';
  reason: string | null;
  startedAt: string;
  durationMs: number;
  ceilingMs: number;
  snapshotHash: string | null;
  /** Edits to protected files in the workspace; recorded, never honoured. */
  fixedFileChanges: FixedChange[];
  suites: SuiteOutcome[];
}
