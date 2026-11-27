import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { openDatabase } from './db.ts';
import { JobStore } from './store.ts';
import { createHandler } from './app.ts';

const store = new JobStore(openDatabase());
store.migrate();
const uiHtml = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
const handler = createHandler({ store, uiHtml });
const port = Number(process.env.PORT ?? 3000);
createServer((req, res) => void handler(req, res)).listen(port, () => console.log(`server listening on ${port}`));
