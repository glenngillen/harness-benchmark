import { createServer, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { openDatabase } from './db.ts';

// Starting point. See TASK.md for the required behaviour.
const db = openDatabase();
void db;
const uiHtml = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const port = Number(process.env.PORT ?? 3000);
createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === '/health' && req.method === 'GET') {
    return send(res, 200, { status: 'ok', worker: 'down' });
  }
  if (pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(uiHtml);
    return;
  }
  send(res, 501, { error: { code: 'not_implemented', message: 'Not implemented yet.' } });
}).listen(port, () => console.log(`server listening on ${port}`));
