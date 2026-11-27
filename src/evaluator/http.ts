import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { AppUnreachable } from './expect.ts';
import type { HttpClient, HttpResponse } from './types.ts';

export const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

type RequestFn = (url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => ReturnType<typeof httpRequest>;

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Loopback HTTP client with full control of headers: unlike fetch, it never adds a Content-Type,
 * which the validation cases depend on. Any transport failure is the app's (AppUnreachable).
 */
export function createHttpClient(baseUrl: () => string, request: RequestFn = httpRequest, timeoutMs = REQUEST_TIMEOUT_MS): HttpClient {
  return {
    request: (req) =>
      new Promise<HttpResponse>((resolve, reject) => {
        const body = req.body === undefined ? undefined : Buffer.from(req.body);
        const headers: Record<string, string | number> = { ...(req.headers ?? {}), connection: 'close' };
        if (body) headers['content-length'] = body.length;
        const what = `${req.method} ${req.path}`;
        let done = false;
        const fail = (msg: string) => {
          if (done) return;
          done = true;
          reject(new AppUnreachable(`${what}: ${msg}`));
        };
        const r = request(new URL(req.path, baseUrl()), { method: req.method, headers, timeout: timeoutMs }, (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE_BYTES) {
              res.destroy();
              fail('response larger than 1 MiB');
            } else chunks.push(c);
          });
          res.on('end', () => {
            if (done) return;
            done = true;
            const text = Buffer.concat(chunks).toString('utf8');
            const ct = res.headers['content-type'];
            resolve({ status: res.statusCode ?? 0, contentType: Array.isArray(ct) ? ct.join(', ') : (ct ?? ''), text, json: parseJson(text) });
          });
          res.on('error', (e) => fail(e.message));
        });
        r.on('timeout', () => {
          r.destroy();
          fail(`no response within ${timeoutMs} ms`);
        });
        r.on('error', (e) => fail(e.message));
        r.end(body);
      }),
  };
}
