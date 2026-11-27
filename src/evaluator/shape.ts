/** Pure validators for the job and error representations fixed in task.md. */

const STATUSES = ['queued', 'running', 'completed', 'failed'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isIso = (v: unknown) => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));

/** Problems with a job representation; empty when it matches the contract. */
export function jobProblems(value: unknown, { requireId = true }: { requireId?: boolean } = {}): string[] {
  if (!isObject(value)) return ['job is not an object'];
  const p: string[] = [];
  if (requireId && (typeof value.id !== 'string' || value.id.length === 0)) p.push('id must be a non-empty string');
  if (!STATUSES.includes(value.status as string)) p.push('status must be one of queued, running, completed, failed');
  if (typeof value.input !== 'string') p.push('input must be a string');
  for (const k of ['steps', 'failAttempts', 'attempts'] as const) if (!isInt(value[k])) p.push(`${k} must be an integer`);
  const progress = value.progress;
  if (!isObject(progress)) p.push('progress must be an object');
  else {
    if (!isInt(progress.completed)) p.push('progress.completed must be an integer');
    if (progress.total !== value.steps) p.push('progress.total must equal steps');
  }
  const result = value.result;
  if (value.status === 'completed') {
    if (!isObject(result) || typeof result.output !== 'string') p.push('result must be {"output": string} once completed');
  } else if (result !== null) p.push('result must be null unless completed');
  if (value.status === 'failed') {
    if (typeof value.error !== 'string') p.push('error must be a string once failed');
  } else if (value.error !== null) p.push('error must be null unless failed');
  for (const k of ['createdAt', 'updatedAt'] as const) if (!isIso(value[k])) p.push(`${k} must be an ISO 8601 timestamp`);
  return p;
}

/** Problems with an error body; `fields` is required for invalid_request. */
export function errorProblems(value: unknown, code: string): string[] {
  if (!isObject(value) || !isObject(value.error)) return ['body must be {"error": {...}}'];
  const e = value.error;
  const p: string[] = [];
  if (e.code !== code) p.push(`error.code must be ${JSON.stringify(code)} (got ${JSON.stringify(e.code ?? null)})`);
  if (typeof e.message !== 'string') p.push('error.message must be a string');
  const fieldsOk =
    Array.isArray(e.fields) && e.fields.every((f) => isObject(f) && typeof f.field === 'string' && typeof f.message === 'string');
  if (code === 'invalid_request' ? !fieldsOk : e.fields !== undefined && !fieldsOk) {
    p.push('error.fields must be an array of {field, message}');
  }
  return p;
}

/** Field names listed in an error body's `fields`, ignoring malformed entries. */
export function fieldNames(value: unknown): string[] {
  if (!isObject(value) || !isObject(value.error) || !Array.isArray(value.error.fields)) return [];
  return value.error.fields.flatMap((f) => (isObject(f) && typeof f.field === 'string' ? [f.field] : []));
}

export function isJsonContentType(contentType: string): boolean {
  return /^application\/json\s*(;|$)/i.test(contentType.trim());
}
