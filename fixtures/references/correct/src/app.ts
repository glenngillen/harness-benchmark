import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JobStore } from './store.ts';
import { toJobJson } from './jobjson.ts';
import { validateIdempotencyKey, validateSubmission, type FieldError } from './validate.ts';
import { workerIsUp } from './health.ts';

const MAX_BODY_BYTES = 64 * 1024;

export interface AppDeps {
  store: JobStore;
  uiHtml: string;
  now?: () => number;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function invalid(res: ServerResponse, fields: FieldError[]): void {
  send(res, 400, { error: { code: 'invalid_request', message: 'The request is invalid.', fields } });
}

function error(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createHandler({ store, uiHtml, now = Date.now }: AppDeps): Handler {
  async function submit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = validateIdempotencyKey(req.headers['idempotency-key']);
    if (!key.ok) return invalid(res, key.errors);
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      return invalid(res, [{ field: 'body', message: 'Content-Type must be application/json' }]);
    }
    const raw = await readBody(req);
    if (raw === undefined) return invalid(res, [{ field: 'body', message: 'must be at most 64 KiB' }]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return invalid(res, [{ field: 'body', message: 'must be valid JSON' }]);
    }
    const sub = validateSubmission(parsed);
    if (!sub.ok) return invalid(res, sub.errors);
    const result = store.create(sub.value, key.value, now());
    if (result.kind === 'conflict') {
      return error(res, 409, 'idempotency_conflict', 'This Idempotency-Key was used with a different payload.');
    }
    send(res, result.kind === 'created' ? 201 : 200, toJobJson(result.job));
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    if (pathname === '/health' && method === 'GET') {
      return send(res, 200, { status: 'ok', worker: workerIsUp(store.lastHeartbeat(), now()) ? 'up' : 'down' });
    }
    if (pathname === '/' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(uiHtml);
      return;
    }
    if (pathname === '/api/jobs') {
      if (method === 'POST') return submit(req, res);
      if (method === 'GET') return send(res, 200, { jobs: store.list().map(toJobJson) });
      return error(res, 405, 'method_not_allowed', 'Method not allowed.');
    }
    const match = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
    if (match) {
      if (method !== 'GET') return error(res, 405, 'method_not_allowed', 'Method not allowed.');
      const job = store.get(decodeURIComponent(match[1]!));
      return job ? send(res, 200, toJobJson(job)) : error(res, 404, 'not_found', 'No such job.');
    }
    error(res, 404, 'not_found', 'Not found.');
  }

  return (req, res) =>
    route(req, res).catch((err: unknown) => {
      console.error(err);
      if (!res.headersSent) error(res, 500, 'internal', 'Internal error.');
    });
}
