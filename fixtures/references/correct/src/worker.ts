import { setTimeout as sleep } from 'node:timers/promises';
import { openDatabase } from './db.ts';
import { JobStore } from './store.ts';
import { recoverInterrupted } from './recovery.ts';
import { tick } from './runner.ts';

const IDLE_POLL_MS = 100;
const db = openDatabase();
const store = new JobStore(db);
store.migrate();
let stopping = false;

async function main(): Promise<void> {
  const recovered = recoverInterrupted(db, Date.now());
  console.log(`worker started; recovered ${recovered} interrupted job(s)`);
  const deps = { store, now: Date.now, sleep };
  while (!stopping) {
    if (!(await tick(deps))) await sleep(IDLE_POLL_MS);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}
main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
