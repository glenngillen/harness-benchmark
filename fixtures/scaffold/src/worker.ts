import { setTimeout as sleep } from 'node:timers/promises';
import { openDatabase } from './db.ts';

// Starting point. See TASK.md for the required behaviour.
const db = openDatabase();
void db;
let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

console.log('worker started');
while (!stopping) {
  await sleep(100);
}
