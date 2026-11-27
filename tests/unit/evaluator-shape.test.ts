import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { errorProblems, fieldNames, isJsonContentType, jobProblems } from '../../src/evaluator/shape.ts';

const job = (over: Record<string, unknown> = {}) => ({
  id: 'j-1',
  status: 'queued',
  input: 'abc',
  steps: 3,
  failAttempts: 0,
  attempts: 0,
  progress: { completed: 0, total: 3 },
  result: null,
  error: null,
  createdAt: '2026-11-14T00:00:00.000Z',
  updatedAt: '2026-11-14T00:00:00.000Z',
  ...over,
});

describe('jobProblems', () => {
  it('accepts a well-formed job in each status', () => {
    expect(jobProblems(job())).toEqual([]);
    expect(jobProblems(job({ status: 'running', attempts: 1, progress: { completed: 2, total: 3 } }))).toEqual([]);
    expect(jobProblems(job({ status: 'completed', attempts: 1, progress: { completed: 3, total: 3 }, result: { output: 'ABC' } }))).toEqual([]);
    expect(jobProblems(job({ status: 'failed', attempts: 3, error: 'transient failure' }))).toEqual([]);
  });

  it('reports each malformed field by name', () => {
    expect(jobProblems(null)).toEqual(['job is not an object']);
    expect(jobProblems(job({ id: undefined }))).toContain('id must be a non-empty string');
    expect(jobProblems(job({ id: '' }))).toContain('id must be a non-empty string');
    expect(jobProblems(job({ status: 'done' }))).toContain('status must be one of queued, running, completed, failed');
    expect(jobProblems(job({ steps: '3' }))).toContain('steps must be an integer');
    expect(jobProblems(job({ progress: { completed: 0, total: 4 } }))).toContain('progress.total must equal steps');
    expect(jobProblems(job({ progress: undefined }))).toContain('progress must be an object');
    expect(jobProblems(job({ result: { output: 'X' } }))).toContain('result must be null unless completed');
    expect(jobProblems(job({ status: 'completed', result: null }))).toContain('result must be {"output": string} once completed');
    expect(jobProblems(job({ status: 'failed', error: null }))).toContain('error must be a string once failed');
    expect(jobProblems(job({ error: 'boom' }))).toContain('error must be null unless failed');
    expect(jobProblems(job({ createdAt: 'yesterday' }))).toContain('createdAt must be an ISO 8601 timestamp');
  });

  it('can skip the id requirement', () => {
    expect(jobProblems(job({ id: undefined }), { requireId: false })).toEqual([]);
  });

  describe('properties', () => {
    it('never throws and always returns strings for arbitrary input', () => {
      fc.assert(
        fc.property(fc.anything(), (value) => {
          const problems = jobProblems(value);
          expect(Array.isArray(problems)).toBe(true);
          for (const p of problems) expect(typeof p).toBe('string');
        }),
      );
    });

    it('accepts every generated valid queued job', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1 }), fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 5 }), (input, steps, failAttempts) => {
          expect(jobProblems(job({ input, steps, failAttempts, progress: { completed: 0, total: steps } }))).toEqual([]);
        }),
      );
    });
  });
});

describe('errorProblems', () => {
  const body = { error: { code: 'invalid_request', message: 'bad', fields: [{ field: 'steps', message: 'too big' }] } };

  it('accepts the documented error shape', () => {
    expect(errorProblems(body, 'invalid_request')).toEqual([]);
    expect(errorProblems({ error: { code: 'not_found', message: 'nope' } }, 'not_found')).toEqual([]);
  });

  it('requires fields for invalid_request and checks the code', () => {
    expect(errorProblems({ error: { code: 'invalid_request', message: 'bad' } }, 'invalid_request')).toContain(
      'error.fields must be an array of {field, message}',
    );
    expect(errorProblems(body, 'not_found')).toContain('error.code must be "not_found" (got "invalid_request")');
    expect(errorProblems({ message: 'x' }, 'not_found')).toEqual(['body must be {"error": {...}}']);
    expect(errorProblems({ error: { code: 'not_found', message: 3 } }, 'not_found')).toContain('error.message must be a string');
  });

  it('never throws for arbitrary input', () => {
    fc.assert(fc.property(fc.anything(), fc.string(), (value, code) => void errorProblems(value, code)));
  });
});

describe('fieldNames', () => {
  it('lists named fields and ignores malformed entries', () => {
    expect(fieldNames({ error: { fields: [{ field: 'input' }, { nope: 1 }, { field: 'steps' }, 'x'] } })).toEqual(['input', 'steps']);
    expect(fieldNames({})).toEqual([]);
  });

  it('never throws for arbitrary input', () => {
    fc.assert(fc.property(fc.anything(), (value) => void fieldNames(value)));
  });
});

describe('isJsonContentType', () => {
  it('accepts application/json with or without parameters', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('Application/JSON; charset=utf-8')).toBe(true);
    expect(isJsonContentType('text/plain')).toBe(false);
    expect(isJsonContentType('')).toBe(false);
  });
});
