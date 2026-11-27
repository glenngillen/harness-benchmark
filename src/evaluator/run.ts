import { CaseFailure, CeilingReached, InfrastructureError } from './expect.ts';
import type { CaseContext, EvalCase } from './cases.ts';
import type { CaseResult, UiBrowser, UiPage } from './types.ts';

export interface CaseRun {
  results: CaseResult[];
  /** Set when the evaluator itself failed; the verdict is then operational, not a rejection. */
  infrastructure: string | null;
  ceilingReached: boolean;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Runs every case in order. App-caused failures (CaseFailure, including unreachable app and the
 * ceiling) reject the case and continue. An InfrastructureError, or any unexpected exception
 * (an evaluator defect), stops the run and marks the evaluation operational.
 */
export async function runCases(cases: readonly EvalCase[], ctx: CaseContext): Promise<CaseRun> {
  const results: CaseResult[] = [];
  let infrastructure: string | null = null;
  let ceilingReached = false;
  for (const c of cases) {
    const base = { id: c.id, behaviour: c.behaviour, title: c.title };
    if (infrastructure !== null || ceilingReached) {
      results.push({ ...base, passed: false, durationMs: 0, detail: infrastructure !== null ? 'not run: evaluator infrastructure failure' : 'not run: evaluation ceiling reached' });
      continue;
    }
    const t0 = ctx.clock.now();
    if (t0 >= ctx.deadline.at) {
      ceilingReached = true;
      results.push({ ...base, passed: false, durationMs: 0, detail: 'not run: evaluation ceiling reached' });
      continue;
    }
    try {
      await c.run(ctx);
      results.push({ ...base, passed: true, durationMs: ctx.clock.now() - t0, detail: '' });
    } catch (err) {
      const durationMs = ctx.clock.now() - t0;
      if (err instanceof CeilingReached) ceilingReached = true;
      if (err instanceof CaseFailure) {
        results.push({ ...base, passed: false, durationMs, detail: err.message });
      } else {
        infrastructure = err instanceof InfrastructureError ? err.message : `evaluator defect: ${err instanceof Error ? `${err.name}: ${err.message}` : message(err)}`;
        results.push({ ...base, passed: false, durationMs, detail: `infrastructure: ${infrastructure}` });
      }
    }
  }
  return { results, infrastructure, ceilingReached };
}

export interface ContextOptions {
  http: CaseContext['http'];
  app: CaseContext['app'];
  clock: CaseContext['clock'];
  browser: UiBrowser;
  data: CaseContext['data'];
  /** Absolute clock time at which the evaluation ceiling is reached. */
  deadlineAt: number;
}

/** Builds the case context; the browser page is opened on first use against the current server. */
export function createCaseContext(o: ContextOptions): CaseContext {
  let page: Promise<UiPage> | undefined;
  return {
    http: o.http,
    app: o.app,
    clock: o.clock,
    deadline: { clock: o.clock, at: o.deadlineAt },
    data: o.data,
    state: {},
    page: () => (page ??= o.browser.open(o.app.baseUrl())),
  };
}
