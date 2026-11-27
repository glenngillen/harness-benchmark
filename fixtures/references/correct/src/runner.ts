import type { JobStore, JobRow } from './store.ts';
import { computeOutput, shouldFailAttempt, STEP_MS } from './work.ts';

export interface RunnerDeps {
  store: JobStore;
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
}

class TransientFailure extends Error {}

/** Runs one claimed job to completion or to a recorded failed attempt. */
export async function runJob({ store, now, sleep }: RunnerDeps, job: JobRow): Promise<void> {
  try {
    for (let step = 0; step < job.steps; step += 1) {
      if (step === 0 && shouldFailAttempt(job.attempts, job.failAttempts)) {
        throw new TransientFailure('transient failure');
      }
      await sleep(STEP_MS);
      store.heartbeat(now());
      store.progress(job.id, step + 1, now());
    }
    store.complete(job.id, computeOutput(job.input), now());
  } catch (err) {
    store.failAttempt(job.id, now(), err instanceof TransientFailure ? err.message : String(err));
  }
}

/** One worker loop iteration: heartbeat, then claim and run at most one job. Returns whether a job ran. */
export async function tick(deps: RunnerDeps): Promise<boolean> {
  deps.store.heartbeat(deps.now());
  const job = deps.store.claimNext(deps.now());
  if (!job) return false;
  await runJob(deps, job);
  return true;
}
