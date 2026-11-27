import type { JobRow } from './store.ts';

export interface JobJson {
  id: string;
  status: JobRow['status'];
  input: string;
  steps: number;
  failAttempts: number;
  attempts: number;
  progress: { completed: number; total: number };
  result: { output: string } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toJobJson(row: JobRow): JobJson {
  return {
    id: row.id,
    status: row.status,
    input: row.input,
    steps: row.steps,
    failAttempts: row.failAttempts,
    attempts: row.attempts,
    progress: { completed: row.progress, total: row.steps },
    result: row.output === null ? null : { output: row.output },
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
