# Task contract: asynchronous job tracker

This file defines the benchmark task: what every model stage is asked to build, and the observable contract the independent evaluator checks (methodology section 9, behaviours A1–A8). It is fixed before any model output exists.

- **Model-visible brief.** The section between the `BRIEF` markers below is copied byte-for-byte to `fixtures/scaffold/TASK.md`, and a unit test enforces the match. Models see that file and nothing else from this document.
- **Not model-visible.** Everything outside the markers: the starting scaffold, the reference implementations, and how the contract maps to evaluation.

## Fixtures

| Path | Visible to models | Purpose |
| --- | --- | --- |
| `fixtures/scaffold/` | Yes. Copied into each fresh workflow workspace with `node_modules/` preinstalled | Starting state: fixed `package.json`, lockfile, `tsconfig.json`, `.gitignore`, `TASK.md`, and the public build-time checks under `checks/` (`npm run check:smoke`, `npm run check:contract`; methodology section 5); a server that answers `/health` (worker always `down`) and the UI page, and returns 501 elsewhere; an idle worker; an empty UI page. It satisfies none of A1–A8. |
| `fixtures/references/correct/` | No | Known-correct implementation of the brief. Shares the fixed files byte-for-byte with the scaffold. |
| `fixtures/references/broken/<id>/` | No | Overlays on `correct`, each replacing one file to break exactly one behaviour. Listed in `manifest.json` below. Build a runnable copy with `npm run reference:materialise -- <id> <empty-dir>`. |

The evaluator slice proves discrimination: `correct` passes every case, and each broken reference fails its own behaviour.

| Reference | Breaks | Fault |
| --- | --- | --- |
| `A1-worker-never-healthy` | A1 | `/health` always reports the worker `down`. |
| `A2-job-response-missing-id` | A2 | Job representations omit `id`. |
| `A3-wrong-output` | A3 | Completed jobs return the input unchanged. |
| `A4-steps-unbounded` | A4 | `steps` above 20 is accepted. |
| `A5-idempotency-ignores-payload` | A5 | A reused key with a different `input` is replayed instead of returning 409. |
| `A6-no-retry` | A6 | The first transient failure fails the job. |
| `A7-no-crash-recovery` | A7 | Jobs left `running` by a killed worker are never resumed. |
| `A8-ui-hides-errors` | A8 | Validation errors never appear in the UI. |

## Stack and pins

- **Node.js 22.23.4**, pinned in `.node-version` and the `engines` field. The app uses the built-in `node:sqlite`, `node:http`, and a static HTML page, so it has **no runtime dependencies**. The only dev dependencies are `typescript` 6.0.3 and `@types/node` 22.20.5, both exact versions with a committed lockfile. No network access is needed after `npm ci`.
- `node:sqlite` is marked experimental in Node 22 and prints an `ExperimentalWarning`. The start scripts pass `--disable-warning=ExperimentalWarning`.
- The scaffold uses TypeScript's `rewriteRelativeImportExtensions`, so the sources import `./x.ts` and the compiled output imports `./x.js`.
- The site's root `tsconfig.json` includes `**/*` and so would have picked up this nested package. This slice added `examples` to its `exclude` list. `npm run build` at the site root (`astro build`) is checked after the change.
- Only the benchmark package (not the fixtures) sets `legacy-peer-deps=true` in its `.npmrc`. npm 10.9.9 crashes in arborist (`Cannot read properties of null (reading 'edgesOut')`) while resolving vitest's optional peer dependencies.

## Mapping to acceptance behaviours

| ID | Brief section |
| --- | --- |
| A1 | Commands, configuration, `GET /health` |
| A2 | `POST /api/jobs` (201 response), job representation |
| A3 | Processing, `GET /api/jobs/:id`, UI job list |
| A4 | Validation |
| A5 | Idempotency |
| A6 | Transient failures and retries |
| A7 | Durability and restarts |
| A8 | Browser UI |

## Independent evaluator

The evaluator lives in `src/evaluator/` and runs as its own process (`npm run evaluate`, supervised by `src/evaluator/supervise.ts`). Neither its source, its cases, nor its verdicts ever enter a model workspace or build-time feedback.

**Procedure for one frozen snapshot.**

1. Hash the evaluator sources and the protected scaffold. If the hash changes during evaluation, the verdict is `infrastructure-failure`.
2. Copy the snapshot into a fresh workspace. `.git/`, `node_modules/`, `dist/` and `data/` are never copied, and symbolic links and special files are ignored and recorded. A snapshot over 5,000 files or 50 MiB is rejected.
3. **Restore the fixed files.** `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `TASK.md` and `checks/` come from the protected scaffold, and so does `node_modules/`. Changed, missing, or added fixed files are recorded as evidence and never honoured. Only the model's `src/`, `ui/` and other own files are built and run.
4. Run `npm run build`, then `npm run start:server` and `npm run start:worker`, each in its own process group with a fresh environment (`PATH`, `PORT`, `DATABASE_PATH`, and a workspace-local `HOME` and `TMPDIR`; nothing else). They run inside the OS sandbox: `sandbox-exec` on macOS, `bwrap` on Linux. The sandbox hides this worktree, its parent checkout, and the home directory, and permits writes only inside the evaluation workspace. In `required` mode (the CLI default), the evaluator first probes the sandbox; if none works, the result is `infrastructure-failure`.
5. Run the cases in `src/evaluator/cases.ts` in a fixed order over loopback HTTP, a headless Chromium page (Playwright 1.64.1), and process signals, all within the 2-minute ceiling. Every input carries a per-evaluation nonce, which is recorded in the verdict.

**Outcomes.** `passed` requires every case to pass. `failed` covers missing output, an oversized snapshot, a build failure, any failing case, and reaching the ceiling, because these are app-caused. `infrastructure-failure` is operational and never scored. It covers missing protected dependencies, no usable sandbox in `required` mode, a browser launch failure, an evaluator defect, a changed evaluator hash, or a supervisor timeout (ceiling + 45 s) or missing verdict. Per-behaviour pass counts are recorded as a secondary diagnostic. Absolute host paths in the verdict and captured output are replaced with relative paths or placeholders.

**Cases.** 53 cases cover A1–A8 (A1 4, A2 2, A3 4, A4 22, A5 7, A6 2, A7 6, A8 6). Cases are grouped by behaviour, and each case id starts with its behaviour, for example `A6.retried-to-completion`.

| Behaviour | What the cases check (case data is in the evaluator only) |
| --- | --- |
| A1 | Startup and health within 10 s; worker reported `up`; worker reported `down` within 3 s of a SIGKILL; both processes exit within 5 s of SIGTERM |
| A2 | 201 with a complete queued job, exactly one new job, listed first, retrievable by id; defaults applied; input stored exactly |
| A3 | 404 `not_found` for an unknown id; Unicode upper-casing; start within 1 s; observable progress; step duration; completed result shown in the UI |
| A4 | Each rejection rule in the brief, with every offending field named and no job created; boundary values accepted |
| A5 | Replay with explicit defaults and a different key order; 409 on a changed input or steps; defaults equivalence; five concurrent same-key submissions create one job; no-key submissions create two jobs; key replays after a restart |
| A6 | `failAttempts: 2` completes on attempt 3 and is seen back in `queued`; `failAttempts: 3` ends `failed` and stays failed; never a duplicate job |
| A7 | SIGKILL of the worker mid-job, then of the server; restart on the same database; all jobs persist; the in-flight job and a queued job complete; finished jobs are unchanged |
| A8 | Required `data-testid` elements and `role="alert"`; form submission with numeric fields; live updates without reload; newest-first order; a whitespace-only input's rejection shown and cleared after a later success |

`null` for `steps` or `failAttempts` is deliberately untested, because the brief does not say whether it means "omitted".

**Discrimination.** Unit tests (`tests/unit/evaluator-cases.test.ts`) run every case against an in-process simulation on a virtual clock. The simulation passes as correct, and each emulated broken reference fails its own behaviour; collateral failures are listed explicitly. The integration suite (`tests/integration/discrimination.test.ts`, run with `scripts/run-discrimination.sh`) runs the real evaluator against `correct`, all eight broken references, and two tamper references (`fixtures/references/tamper/`):

| Reference | Attempt | Expected |
| --- | --- | --- |
| `T1-probes-evaluator` | On A3's fault, walks up from its working directory to find, read, and open the evaluator's cases for writing | `failed` on A3; under isolation the probe logs `not-found` or `denied`; evaluator hash unchanged |
| `T2-rewrites-fixed-files` | On the correct app, rewrites `package.json` to skip the build and run stub servers | `passed`, because the protected `package.json` is restored; the change is recorded |

**Known limitation.** `sandbox-exec` cannot nest inside another macOS sandbox, so it fails inside a sandboxed agent session (`sandbox_apply: Operation not permitted`). The pilot gate must therefore show that the sandbox works in the environment that actually runs evaluations. The integration suite runs on Linux with `bubblewrap`, in a privileged container (`scripts/run-discrimination.sh`) or on the runner.

---

<!-- BRIEF:START -->
# Job tracker

Build a small asynchronous job tracker: an HTTP API and a browser page for submitting jobs, a separate worker process that processes them, and durable state in SQLite shared by both processes.

The repository already contains a starting point. Keep the existing commands and file layout working. You may add, change, or remove source files under `src/` and `ui/`.

## Fixed files and constraints

- Do not modify `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, this file, or anything under `checks/`.
- Do not add dependencies. Use Node.js 22 built-ins (`node:http`, `node:sqlite`, and so on). Dependencies are already installed, and there is no network access.
- The server and worker must be separate processes that communicate only through the SQLite database.

## Commands and configuration

- `npm run build` compiles `src/` to `dist/`.
- `npm run start:server` starts the HTTP server. `npm run start:worker` starts the worker. Either may start first.
- `PORT`: server port, default `3000`.
- `DATABASE_PATH`: SQLite file path, default `data/jobs.db`. Both processes use the same value. Create the parent directory if it is missing.
- Both processes must start within 10 seconds and shut down cleanly on `SIGTERM`.

## Jobs

A job takes a text `input` and processes it in `steps` steps. When processing finishes, the job's output is `input` converted with JavaScript's `String.prototype.toUpperCase()`.

### Job representation

Every endpoint that returns a job uses this JSON shape:

```json
{
  "id": "string, unique, assigned by the server",
  "status": "queued | running | completed | failed",
  "input": "the submitted input",
  "steps": 5,
  "failAttempts": 0,
  "attempts": 0,
  "progress": { "completed": 0, "total": 5 },
  "result": null,
  "error": null,
  "createdAt": "ISO 8601 timestamp",
  "updatedAt": "ISO 8601 timestamp"
}
```

- `attempts` is the number of processing attempts started so far.
- `progress.total` equals `steps`. `progress.completed` counts the steps finished in the current attempt.
- `result` is `{ "output": "..." }` once the job is `completed`, otherwise `null`.
- `error` is a string once the job is `failed`, otherwise `null`.

## HTTP API

All API responses are JSON with `Content-Type: application/json`. Errors use this shape:

```json
{ "error": { "code": "string", "message": "string", "fields": [{ "field": "string", "message": "string" }] } }
```

`fields` is required for `invalid_request` and optional otherwise.

### `GET /health`

`200 {"status": "ok", "worker": "up" | "down"}`. `worker` is `"up"` only if the worker process has shown it is alive within the last 3 seconds, for example by writing a heartbeat to the database.

### `POST /api/jobs`

Request: `Content-Type: application/json`, with a body like `{"input": "hello", "steps": 3, "failAttempts": 0}`, and an optional `Idempotency-Key` header.

- `201` with the new job, in status `queued`, when a job is created.
- `200` with the existing job for an idempotent replay (see Idempotency).
- `400` with code `invalid_request` for invalid input (see Validation). No job is created.
- `409` with code `idempotency_conflict` (see Idempotency). No job is created.

### `GET /api/jobs`

`200 {"jobs": [ ...jobs ]}`, newest first.

### `GET /api/jobs/:id`

`200` with the job, or `404` with code `not_found`.

### Other routes

An unknown path returns `404` with code `not_found`. A wrong method on a known path returns `405` with code `method_not_allowed`.

## Validation

The body must be a JSON object with only these fields:

| Field | Rule | Default |
| --- | --- | --- |
| `input` | Required string, 1–1000 characters (JavaScript string length), not only whitespace. Stored exactly as sent. | — |
| `steps` | Integer from 1 to 20. | 5 |
| `failAttempts` | Integer from 0 to 5. | 0 |

All of the following are rejected with `400 invalid_request`, with each offending field listed in `fields` (use `"body"` when the body as a whole is the problem):

- unknown fields;
- wrong types, including numeric strings such as `"3"`;
- out-of-range or non-integer numbers;
- malformed JSON;
- a body that is not an object;
- a missing or non-JSON `Content-Type`;
- an `Idempotency-Key` not matching `^[A-Za-z0-9_-]{1,128}$` (field `"Idempotency-Key"`).

## Idempotency

When `Idempotency-Key` is present, the submission is compared with any earlier submission that used the same key. The comparison uses the payload after defaults are applied, so `{"input": "a"}` and `{"input": "a", "steps": 5, "failAttempts": 0}` are the same payload.

- Same key, same payload: return `200` with the original job. No new job.
- Same key, different payload: return `409 idempotency_conflict`. No new job.
- A key never creates more than one job, including across server restarts.
- Submissions without a key always create a new job.

## Processing

- The worker picks up queued jobs, oldest first, one at a time. An idle worker starts a newly queued job within 1 second.
- An attempt sets the job to `running`, increments `attempts`, and resets `progress.completed` to 0.
- Each step takes about 100 ms (between 50 and 500 ms). Update `progress.completed` in the database after each step, so progress is observable while the job runs.
- After the last step, the job becomes `completed` with `result.output` set and `progress.completed` equal to `steps`.

## Transient failures and retries

`failAttempts` simulates an unreliable dependency. Attempt number *n* (counting from 1) fails at its first step, before any progress, if *n* ≤ `failAttempts`.

- A failed attempt is retried after a delay of between 250 ms and 2 seconds, up to **3 attempts in total**. The job returns to `queued` while it waits.
- After the third failed attempt, the job becomes `failed`, with `error` set to `"transient failure"`, `result` set to `null`, and `attempts` set to 3.
- Retries continue the same job. They never create another job or another result.

For example, `failAttempts: 2` completes on attempt 3, and `failAttempts: 3` or more ends `failed`.

## Durability and restarts

All job state lives in SQLite at `DATABASE_PATH`.

- If the server and worker are stopped, gracefully or abruptly with `SIGKILL`, and started again with the same `DATABASE_PATH`, every job and its status are still there.
- A job that was `running` when the worker died is processed again. It completes, or fails per the retry rules, within 10 seconds of the worker restarting, plus its own processing time.
- Completed and failed jobs are never reprocessed.

## Browser UI

`GET /` serves an HTML page that uses the API. The evaluator finds elements by these `data-testid` attributes:

| `data-testid` | Element |
| --- | --- |
| `job-form` | The submission form |
| `job-input` | Text field for `input` |
| `job-steps` | Field for `steps` |
| `job-fail-attempts` | Field for `failAttempts` |
| `job-submit` | Submit button |
| `form-error` | Region with `role="alert"`. When the API rejects a submission, it shows the rejection, including each offending field's name. It is empty otherwise. |
| `job-list` | List of jobs, newest first |
| `job-item` | One element per job inside `job-list`, carrying `data-job-id="<id>"` |
| `job-status` | Inside each `job-item`: the job's `status` text |
| `job-progress` | Inside each `job-item`: `<completed>/<total>`, for example `3/5` |
| `job-result` | Inside each `job-item`: `result.output` once completed, the `error` text once failed, otherwise empty |

The page reflects status and progress changes within 2 seconds without a manual reload. Submitting through the form sends the field values to `POST /api/jobs` as numbers where numeric, so the API's validation applies.
<!-- BRIEF:END -->
