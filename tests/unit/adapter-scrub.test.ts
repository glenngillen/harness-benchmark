import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { REDACTED, scrubSecrets } from '../../src/adapters/scrub.ts';

describe('scrubSecrets', () => {
  it('redacts API keys, bearer tokens, JWTs and key=value secrets', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXBhcnQ';
    const input = [
      'key sk-proj-abcdefghijklmnopqrstuvwx used',
      'anthropic sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUV',
      'Authorization: Bearer abcdefghijklmnop.qrstuvwxyz',
      `token ${jwt}`,
      'OPENAI_API_KEY=supersecretvalue123',
      '"refresh_token": "rt_0123456789abcdef"',
      '"access_token":"at-0123456789abcdef"',
    ].join('\n');
    const out = scrubSecrets(input);
    for (const secret of ['sk-proj-abcdefghijklmnopqrstuvwx', 'sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUV', 'abcdefghijklmnop.qrstuvwxyz', jwt, 'supersecretvalue123', 'rt_0123456789abcdef', 'at-0123456789abcdef']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain(REDACTED);
    expect(out.split('\n')).toHaveLength(7);
  });

  it('leaves ordinary usage JSON and prose untouched', () => {
    const line = '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}';
    expect(scrubSecrets(line)).toBe(line);
    expect(scrubSecrets('The token budget was small; skip the key step.')).toBe('The token budget was small; skip the key step.');
  });

  it('keeps JSON lines parseable after redaction', () => {
    const line = JSON.stringify({ type: 'error', message: 'auth failed for sk-abcdefghijklmnopqrstuvwxyz', access_token: 'zzzzzzzzzzzzzzzzzzzz' });
    expect(() => JSON.parse(scrubSecrets(line))).not.toThrow();
  });

  it('property: is idempotent and never leaks an embedded API key', () => {
    const keyBody = fc.stringMatching(/^[A-Za-z0-9]{24,40}$/);
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), keyBody, fc.string({ maxLength: 200 }), (pre, body, post) => {
        const secret = `sk-${body}`;
        const out = scrubSecrets(`${pre} ${secret} ${post}`);
        expect(out).not.toContain(secret);
        expect(scrubSecrets(out)).toBe(out);
      }),
    );
  });

  it('property: never throws and preserves line count', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 500 }), (s) => {
        expect(scrubSecrets(s).split('\n').length).toBe(s.split('\n').length);
      }),
    );
  });
});
