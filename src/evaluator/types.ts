/**
 * Ports used by the independent evaluator. The real implementations spawn the
 * app, speak HTTP over loopback, and drive Chromium; unit tests substitute an
 * in-process simulation on a virtual clock.
 */

export const BEHAVIOURS = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'] as const;
export type Behaviour = (typeof BEHAVIOURS)[number];

export interface Clock {
  /** Milliseconds; only differences are meaningful. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface HttpRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  /** Sent verbatim. No Content-Type is added unless given in `headers`. */
  body?: string;
}

export interface HttpResponse {
  status: number;
  contentType: string;
  text: string;
  /** Parsed body, or undefined when the body is not valid JSON. */
  json: unknown;
}

export interface HttpClient {
  /** Throws AppUnreachable when the app cannot be reached or does not answer in time. */
  request(req: HttpRequest): Promise<HttpResponse>;
}

export type AppProcess = 'server' | 'worker';
export type StopSignal = 'SIGTERM' | 'SIGKILL';

export interface AppControl {
  /** Starts the server and worker with the documented commands, on a fresh port. Does not wait for readiness. */
  start(): Promise<void>;
  /** Signals the whole process group of one process. A no-op when it has already exited. */
  signal(proc: AppProcess, signal: StopSignal): Promise<void>;
  /** Resolves true once the process group leader has exited, false on timeout. */
  waitForExit(proc: AppProcess, timeoutMs: number): Promise<boolean>;
  /** Base URL of the most recently started server, for example http://127.0.0.1:41234. */
  baseUrl(): string;
}

export interface UiJobItem {
  id: string | null;
  status: string;
  progress: string;
  result: string;
}

export interface UiPage {
  /** Which of the given data-testid values have no matching element. */
  missingTestIds(ids: readonly string[]): Promise<string[]>;
  attribute(testId: string, name: string): Promise<string | null>;
  setField(testId: string, value: string): Promise<void>;
  click(testId: string): Promise<void>;
  /** Trimmed text content of the first matching element. */
  text(testId: string): Promise<string>;
  /** Items inside job-list, in document order. */
  jobItems(): Promise<UiJobItem[]>;
}

export interface UiBrowser {
  /** Throws InfrastructureError when the browser cannot be launched. */
  open(url: string): Promise<UiPage>;
  close(): Promise<void>;
}

export interface CaseResult {
  id: string;
  behaviour: Behaviour;
  title: string;
  passed: boolean;
  /** Expected versus observed, or why the case did not run. Never contains secrets. */
  detail: string;
  durationMs: number;
}

export type EvaluationStatus = 'passed' | 'failed' | 'infrastructure-failure';
