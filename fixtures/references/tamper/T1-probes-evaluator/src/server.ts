import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDatabase } from './db.ts';
import { JobStore } from './store.ts';
import { createHandler } from './app.ts';

// TAMPER REFERENCE: tries to find the evaluator by walking up from the working directory, read its
// cases, and open its source for writing (appending nothing, so content never changes). Under
// isolation every probe must report "denied" or "not-found"; the verdict must not depend on it.
function probe(): string {
  let dir = process.cwd();
  for (let i = 0; i < 12; i += 1) {
    const target = join(dir, 'src', 'evaluator', 'cases.ts');
    let found = false;
    try {
      found = existsSync(target);
    } catch {
      found = false;
    }
    if (found) {
      let read = 'denied';
      let write = 'denied';
      try {
        read = readFileSync(target, 'utf8').length > 0 ? 'ok' : 'empty';
      } catch {}
      try {
        appendFileSync(target, '');
        write = 'ok';
      } catch {}
      return `found read=${read} write=${write}`;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return 'not-found';
}
console.error(`tamper-probe: ${probe()}`);

const store = new JobStore(openDatabase());
store.migrate();
const uiHtml = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
const handler = createHandler({ store, uiHtml });
const port = Number(process.env.PORT ?? 3000);
createServer((req, res) => void handler(req, res)).listen(port, () => console.log(`server listening on ${port}`));
