# Methodology: does a harness pay for itself?

**Cohort:** `cohort-03`
**Status:** specified 2026-11-14, before any pilot or scored run, and amended for operability only before the freeze (section 15). Frozen for scoring on 2026-11-24 by `records/freeze/cohort-03.json` (section 14).

This document is the experimental contract. The executable settings live in [`config/`](config/) and the fixed role and handoff text in [`prompts/`](prompts/). If prose and config disagree, the config is what runs, and the disagreement is a defect to fix before the freeze. Source identifiers such as S07 refer to the research notes behind the article, which are not published.

Nothing in this document is a result.

## 1. Question

For one small, fixed coding task, measured per **accepted** result:

1. Does adding deterministic build-time checks with bounded repair prompts change acceptance, tokens, elapsed time, and estimated API-equivalent cost, for a frontier model and for a cheaper model?
2. Does a frontier model **planning** for a cheaper implementer beat the cheaper model alone, or the frontier model alone?
3. Does a frontier model **reviewing** a cheaper implementer's work, followed by one fix by that implementer, beat the same baselines?

Each question is answered separately per workflow, with and without the added checks. The two collaboration workflows are never pooled into one "pairing" score.

## 2. Terms

Four kinds of feedback are kept distinct throughout the records and the article.

| Term | What it is | Present in |
| --- | --- | --- |
| **Native loop** | Whatever the coding CLI does on its own inside a stage: reading files, running commands, running the repository's checks if it chooses to, retrying. | Every stage of every condition. Recorded, not controlled. |
| **Added deterministic checks** (the treatment) | The runner runs fixed build, smoke, and contract checks when an implementation stage returns. On failure it sends bounded feedback and resumes the implementer, at most twice per workflow, then gates completion (section 5). | Check condition `on` only. |
| **Model guidance** | A frontier model's plan or review, handed to the cheaper implementer as an artifact. This is orchestration, not a deterministic harness. | Plan → implement and implement → review → fix, in **both** check conditions. A paired workflow with checks `off` is not "harness-free". |
| **Independent acceptance** | A protected black-box evaluator run on a frozen snapshot after the workflow ends. Its verdict is never shown to any model. | Every scored workflow. |

The treatment here is narrower than Naresh Jain's (S01), which bundled guides such as API specifications and a skill with its sensors. This experiment adds **no guides**. Both conditions receive the same task brief, scaffold, and visible check scripts.

## 3. Matrix

Role keys: **CF** Codex frontier, **CC** Codex cheaper, **AF** Claude frontier, **AC** Claude cheaper (section 4).

| Workflow | Assignments | Check conditions | Repetitions | Scored workflows |
| --- | --- | --- | --- | --- |
| Solo (`solo`) | CF; CC; AF; AC | off / on | 10 each | 80 |
| Plan → implement (`pi`) | CF→CC; CF→AC; AF→CC; AF→AC | off / on | 10 each | 80 |
| Implement → review → fix (`irf`) | CC→CF→CC; CC→AF→CC; AC→CF→AC; AC→AF→AC | off / on | 10 each | 80 |

Total: `10 × 2 × (4 + 4 + 4) = 240` scored workflows and `10 × 8 × (1 + 2 + 3) = 480` scheduled principal model stages, before sensor repairs or early termination. Condition identifiers have the form `workflow.assignment.check`, for example `irf.AC-CF-AC.on`. The canonical list of 24 is in [`config/matrix.json`](config/matrix.json).

Solo cohorts are the controls for both collaboration workflows. They are counted once. The cheaper solo cohorts answer "did frontier guidance lift the cheaper implementer?" The frontier solo cohorts answer "would you have done better just using the frontier model?" Same-provider pairs (CF→CC, AF→AC, CC→CF→CC, AC→AF→AC) help separate the effect of an extra stage of model work from the effect of mixing providers. Even so, a mixed pair that beats a same-provider pair does not show that provider diversity caused the difference: the exact models and native tools differ too.

**Not tested** (reported as such): tier-matched pairings, cheap-leads pairings, a combined plan → implement → review → fix workflow, feedback-frequency variants, other providers, and effort levels other than the fixed level per model.

## 4. Models, clients, and fixed effort

| Role | Native tool pin | Requested model | Fixed effort | cost.dev row | Rationale |
| --- | --- | --- | --- | --- | --- |
| CF | Codex CLI 0.169.0 | `gpt-6-astra` | low | `openai:gpt-6-astra` | R-CF |
| CC | Codex CLI 0.169.0 | `gpt-6-luna` | high | `openai:gpt-6-luna` | R-CC |
| AF | Claude Code 2.1.323 | `claude-opus-5-5` | medium | `anthropic:claude-opus-5-5` | R-AF |
| AC | Claude Code 2.1.323 | `claude-haiku-5-5` | medium | `anthropic:claude-haiku-5-5` | R-AC |

Each model keeps one effort level across every role, workflow, and check condition. Effort names are each vendor's own labels. "Medium" for Claude and "low" or "high" for Codex are not comparable units, and the article presents effort as part of each **model/tool configuration**, not as a pure model-tier comparison.

These rationales were fixed before any pilot. Pilots may show that a level cannot be applied at all, for example if the CLI rejects it or a cap silently lowers it. They may not be used to tune effort against outcomes. Any change must happen before the freeze and be logged in section 15.

- **R-CF (Astra, low).**
  1. The frontier role has the tightest budgets: 5 minutes to plan, 5 minutes to review. A low setting keeps a frontier stage likely to finish within that ceiling.
  2. Astra is the most expensive model in the matrix at list price: $10 input and $50 output per MTok, 100× Luna (S14). It also appears in 100 of the 240 workflows (20 solo, 40 planning, 40 review stages), so it draws most heavily on the subscription allowance.
  3. The published experiment that motivated this one ran its Codex models at low effort (S01). Matching that setting keeps the frontier solo arm comparable in configuration, although the model differs (Astra here, Sol there).

  Consequence: CF represents "frontier at low effort", not the best the frontier model can do.

- **R-CC (Luna, high).**
  1. The question is whether a cheaper model becomes the better deal. A developer who picks a model priced at 1/100 of the frontier per token can afford to raise its effort, and plausibly would.
  2. The OpenAI documentation's only illustrative Luna preset is named "Luna High" (S06). That name has not been shown to equal the CLI value `high`, so this is weak supporting evidence only.
  3. Implementation stages have 15–30 minutes, so the extra thinking time fits.

  Consequence: CC represents "cheaper model given more thinking". Results say nothing about Luna at low effort, which S01 covered.

  Together, R-CF and R-CC **narrow the effective tier gap** within Codex. The article must say so wherever Codex frontier and cheaper configurations are compared.

- **R-AF and R-AC (Opus 5.5 and Haiku 5.5, medium).** Medium is the documented native default for both models (S07), and nothing argues for a different level. Using the same level for both keeps the Claude frontier/cheaper contrast as close to a model-only contrast as the native tool allows.

Requested IDs are mutable names; neither vendor publishes a dated snapshot (S06, S07). Every stage records the requested ID, the ID the client reports as resolved, the applied effort, and the run date. A stage served by a different model than requested, including through a fallback model, is excluded from the cohort and recorded as an operational outcome. It is never pooled. Authentication is the user's existing subscription through each CLI's own login. API keys, paid overflow, credit purchases, plan upgrades, and Claude Code `--bare` (which abandons subscription login, S12) are forbidden.

## 5. The treatment: deterministic build-time checks

Settings: [`config/feedback.json`](config/feedback.json).

**Checks.** Three fixed suites: `build` (TypeScript compiles), `smoke` (server and worker start, health responds), and `contract` (disclosed examples of submission, validation, completion, retry, and idempotency). The evaluator uses **different** cases, plus persistence and browser checks that no build-time suite covers.

**Same starting repository.** Identical copies of the suites sit under `checks/` in the starting repository in **both** conditions, read-only to the model. Either condition may run them as an ordinary native self-check. Both prompts disclose the same commands ([`prompts/fragments/`](prompts/fragments/)). What the treatment adds is the runner's trigger, feedback, repair prompts, and gate. The runner executes its own protected copy from outside the workspace, so tampering with the workspace copy cannot change the feedback.

**Trigger.** With checks `on`, the runner runs all three suites every time an implement, fix, or sensor-repair stage returns. A check run has a 120-second ceiling and counts toward the workflow clock.

**Feedback.** For each failing check: suite, check name, and expected versus observed status or field, using disclosed example data only. Also the last 40 lines of server and worker stderr (secrets scrubbed), the repairs remaining, and the stage minutes remaining. The whole message is truncated at 4,000 bytes with a `[truncated]` marker. Evaluator cases, fixtures, verdicts, and source never appear. The repair prompt is [`prompts/sensor-repair.md`](prompts/sensor-repair.md), and it resumes the implementer that produced the failing state.

**Stopping rule and gate.**

- At most **two** sensor-triggered repairs per workflow in total, shared across stages. Repairs consume the budget of the stage that triggered them.
- After an **intermediate** stage (the `irf` implement stage), checks and repairs may run. If checks still fail with no repairs left, the workflow continues to its scheduled review and fix anyway.
- After the **final** scheduled stage, if checks fail and repairs remain, the runner repairs. If checks fail and no repairs remain, the workflow ends as `repair-budget-exhausted`, a scored failure. The snapshot is still evaluated so the records show what the gate cost (section 8).
- A stage ceiling reached during a repair is a stage timeout.
- Passing the checks never implies acceptance.

**Implementation.** The model-visible suites are `checks/core.ts`, `checks/smoke.ts`, `checks/contract.ts` and `checks/cli.ts` in the scaffold. They are TypeScript run by Node's type stripping, so they need no build and are outside the app's `tsconfig.json`. Each suite starts `npm run start:server` and `npm run start:worker` on a free loopback port with a fresh database under `data/checks/`, runs its checks in order (one failure never stops the others), stops both processes, prints the results, and with `--report <file>` writes them as JSON with the last 40 stderr lines of each process. Checks: `build.compile`; `smoke.health` and `smoke.worker-up` (10-second startup windows); `contract.submit-job`, `contract.reject-invalid`, `contract.complete-job`, `contract.retry-transient` and `contract.idempotent-replay`. Their inputs (`Check example`, `complete me`, `retry example`, `idempotent example`, key `check-example-key`) differ from every evaluator input. The runner (`src/feedback/checks.ts`) copies the workspace with the evaluator's snapshot rules, restores the protected fixed files including `checks/`, runs the three suites in the same OS sandbox as the evaluator under one 120-second ceiling, and records any edits to fixed files without honouring them. The loop (`src/feedback/loop.ts`) and feedback builder (`src/feedback/feedback.ts`) apply the rules above; the orchestrator calls the loop after each implement or fix stage and passes the workflow's running repair count between stages.

**Edge cases, fixed before any output exists.**

- If the build fails, `smoke` and `contract` are reported as not run, and the feedback carries the last 40 lines of compiler output.
- A suite that reaches the check ceiling is a failing check result (app-caused), reported as such in feedback. The check ceiling is also clipped to the remaining workflow time; checks that fail at the workflow ceiling end the workflow as `task-timeout`.
- After the final stage, failing checks with repairs left but no stage time left end the workflow as `stage-timeout`, because no repair can run within the stage budget. After an intermediate stage, the workflow continues to review in either case.
- A protected suite that exits without a valid report, or with a report that contradicts its exit code, means the runner could not operate the checks. That is `runner-infrastructure-failure` (operational), never a scored failure.
- Known limitation: the app runs with write access to the check directory, so a deliberately hostile app could try to overwrite a suite's report before the suite writes it. The suite writes its report last, after stopping the app's process groups, and the runner cross-checks the report against the suite's exit code. Records keep every check run for audit.

**Control.** With checks `off`, the runner runs no suites, sends no check output, and issues no repair prompts. Planning, review, and fix stages remain exactly as scheduled.

**Reviewer inputs.** The reviewer receives no runner check output in either condition. It sees the task, the snapshot, and the rubric, and may build, start, or run the checks itself read-only. This keeps the review prompt byte-identical across check conditions.

## 6. Workflows, handoffs, and schedule

**Solo.** One fresh implementer session ([`prompts/solo-implement.md`](prompts/solo-implement.md)).

**Plan → implement.**

1. A fresh, read-only frontier planner inspects the starting repository and returns a plan in a fixed format, at most 12,000 bytes ([`prompts/plan.md`](prompts/plan.md)).
2. A fresh cheaper implementer receives the task, the starting repository, and that plan, and nothing else ([`prompts/plan-implement.md`](prompts/plan-implement.md)).

There is no review stage. An empty or missing plan is `failed-required-handoff`, a scored failure.

**Implement → review → fix.**

1. A fresh cheaper implementer works ([`prompts/irf-implement.md`](prompts/irf-implement.md)).
2. A fresh, read-only frontier reviewer receives the task and an immutable snapshot of the implementation. It returns at most 10 findings in a fixed format, at most 8,000 bytes ([`prompts/review.md`](prompts/review.md)).
3. The **original** implementer session is resumed by explicit session ID for exactly one fix stage ([`prompts/fix.md`](prompts/fix.md)). The fix stage runs even when the review reports `No findings.`

A missing review artifact is `failed-required-handoff`.

**Handoff rules.**

- Handoffs are artifacts only: captured text inserted into a template. No conversation, credential, or tool state crosses between sessions.
- A same-provider reviewer or implementer gets no extra history. Its input is byte-identical to a mixed-provider one apart from which CLI runs it.
- Resuming the "latest" session (`--last`, `--continue`) is forbidden.
- Inputs to each stage are hashed and recorded, so the exact version each role saw can be audited.

**Schedule.** Seed `20261114`, PRNG mulberry32, ten blocks. Each block starts from the canonical condition order in `config/matrix.json` and applies a Fisher–Yates shuffle (i from 23 down to 1, `j = floor(rand() × (i + 1))`), with one PRNG stream continuing across blocks. Each block therefore contains every condition exactly once.

The orchestration slice generates `config/schedule.json` from this rule. It commits the file before pilots, with a unit test proving it reproduces from the seed. Workflows run with concurrency one, in schedule order. Actual start times, order, and interruptions are recorded even where they deviate from the plan. Every workflow starts in a fresh workspace and fresh sessions.

**Orchestration (`src/orchestrator/`).** `npm run campaign -- --pilots` or `--block N` runs the slots in order with concurrency one. `npm run schedule -- --check` verifies `config/schedule.json`.

- **Plan is the only source of stages.** `plan.ts` derives the stage list from the condition id. A ledger refuses any stage out of order or repeated, any repair outside an implementing stage, and any repair beyond the two per workflow. So plan → implement cannot reach a reviewer, and the fix always resumes `s1-implement`.
- **Sessions.** Every principal stage except the fix gets a fresh session and a fresh tool home. The fix and every sensor repair resume their implementer by its recorded session ID, in that session's own tool home and workspace. A missing session ID to resume is `runner-infrastructure-failure`.
- **Immutable inputs.** Planners and reviewers work on a copy of the workspace made when their stage starts, never on the live one. If a read-only stage changes its copy, that is an isolation failure (`runner-infrastructure-failure`). Each stage records its prompt SHA-256 and the workspace content hash before and after. Handoff artifacts are written to `handoffs/` exactly as the next stage receives them.
- **Deadlines.** A stage's deadline is its budget measured from its own start, clipped to the workflow ceiling. A stage that starts after the ceiling, or a model stage killed when the ceiling was the binding limit, is `task-timeout`. A model stage killed at its own budget is `stage-timeout`. Both are scored failures, including for an intermediate implement stage: the workflow does not continue to review after a killed stage.
- **Checkpoints.** Each attempt has `attempt.json`, rewritten atomically, and `transitions.jsonl`, append-only and fsynced. A stage's start is persisted before the CLI launches. The campaign also keeps an append-only `campaign-log.jsonl`. A lock file allows one runner per campaign label.
- **Recovery.** Rerunning the same command is the recovery procedure:
  - finished slots are skipped;
  - an attempt the runner died in becomes operational (`runner-infrastructure-failure`, `runner-interrupted`) and is replaced from a fresh workspace;
  - a scored attempt whose frozen snapshot is not yet evaluated is evaluated without rerunning the workflow.
- **Pauses.** `quota-exhausted`, `auth-missing`, and `model-substituted` pause the campaign (exit 75). The next invocation starts the linked replacement and records the wait in `waitBeforeMs`. Provider outages and runner or evaluator infrastructure failures wait a fixed five-minute backoff in process, recorded in the log, before their replacement. A third operational attempt for one slot pauses the campaign with `replacements-exhausted`.
- **Layout.** Records go in `records/<cohort>-pilots/pilot/` (pilots) or `records/<cohort>/block-NN/` (scored), then `slot-NN-<condition>/attempt-N/`: `attempt.json`, `transitions.jsonl`, `stages/<stage>/`, `checks/NN.json`, `handoffs/`, and `verdict.json`. Workspaces, tool homes, snapshots, and evaluation directories live under the gitignored `.runs/campaign/`.

## 7. Resource ceilings

Settings: [`config/limits.json`](config/limits.json). All times are active wall-clock minutes. Native internal steps, deterministic checks, and handoff processing all consume the same clock.

| Workflow | Stage budgets (minutes) | Workflow ceiling |
| --- | --- | --- |
| Solo | implement 30 | 30 |
| Plan → implement | plan 5; implement + sensor repairs 25 | 30 |
| Implement → review → fix | implement + repairs 15; review 5; fix + repairs 10 | 30 |

- Stage budgets are hard. Unused time does not roll over, so an extra participant cannot quietly acquire a fresh full budget.
- At most two sensor repairs per workflow, one review stage, and one fix stage.
- The independent evaluator has its own 2-minute ceiling, recorded separately and outside the workflow clock.
- **No token ceiling.** Neither client offers a matched per-stage token cap for subscription use, so the time ceilings bound work. Native turn limits stay at their defaults: Claude Code `--max-turns` is unset, and no Codex equivalent is applied.
- The ceilings bound work for **all** configurations equally. They do not make compute equal: a workflow with more stages uses more model calls. Any claim of improvement "at equal cost" needs a separate, explicitly budget-matched analysis, which this design does not include.

## 8. Outcomes, termination, and retries

Each attempt ends in exactly one terminal state.

| Class | Terminal states | Counts as |
| --- | --- | --- |
| Completed | `completed` (final scheduled stage returned within its ceilings; with checks `on`, final checks passed) | Scored; evaluated for acceptance |
| Scored failure | `stage-timeout`, `task-timeout`, `failed-required-handoff`, `repair-budget-exhausted`, `model-error-exit` | Scored and **not accepted**. Any usable final snapshot is still evaluated for descriptive records only |
| Operational | `auth-missing`, `quota-exhausted`, `provider-outage`, `model-substituted`, `runner-infrastructure-failure`, `evaluator-infrastructure-failure` | Not scored. Preserved with its usage and replaced |

**Retry policy.**

- Scored failures are never retried.
- An operational attempt may be replaced at most **twice** per scheduled slot. Each replacement starts from a fresh workspace, after the service or allowance has recovered, and is linked to the attempt it replaces.
- If two replacements cannot fill the slot, the campaign pauses and the block is reported incomplete.
- On quota exhaustion the runner pauses and waits for the allowance to reset. It never switches to API access, the other provider, or another model.
- Pilots only (block 0, opt-in with `--retry-unexercised`): when no finished pilot of a configuration exercised its whole workflow (section 14), the runner starts one fresh attempt per invocation. The new attempt is linked by `pilotRetryOf`, earlier attempts are kept unchanged, and the retry has its own replacement budget. This never applies to a scored block.
- No human edits a scored implementation. Any human intervention makes that attempt operational, with its time and reason recorded.

**Quota-misclassification audit (scored blocks).** The adapters recognise quota exhaustion by matching the clients' error text, and the pilots never hit a quota, so that recognition is unobserved. After each scored block is fetched and before it counts, `npm run audit-block` scans every scored-failure attempt in the block (all stages' `stderr.txt`, event streams, final messages and termination details) for quota, usage-limit or rate-limit evidence, using a pattern list broader than the adapters' and fixed at the freeze. An attempt is reclassified only on such positive evidence in its own records, never on its outcome, configuration or quality. A reclassified attempt becomes operational `quota-exhausted`, is preserved with its usage and the matched evidence, and its slot is refilled under the ordinary replacement rules. Every flag and decision, including flags that are dismissed, goes in the block audit with its reason. A block with unresolved flags is incomplete.

How the audit is applied (`src/audit/`, `npm run audit-block -- --block N`):

- **Patterns.** `config/quota-audit.json` holds both adapters' quota patterns verbatim plus HTTP 429/529, `overloaded`, `credit`, plan-limit, reset and allowance wording. It is digested with `config/` at the freeze.
- **Sources.** Each stage's `stderr.txt` and `last-message.md` line by line, `stage.json`'s final message and termination detail, and the attempt's termination details. In `events.jsonl`, model- and tool-authored content is skipped, because a coding task's own code and test output cannot evidence a provider limit and would bury real flags. That covers Codex agent-message, reasoning, command, file-change, tool, search and to-do items, and Claude assistant, user and init events. The exception is a Claude assistant event the client generates to report an API failure (one carrying `error` or `is_api_error_message: true`, or from the `<synthetic>` model, the shape the Claude adapter records as an API error): it is client text, so it is scanned. Every other event is scanned over its string values and the numeric values of status or code fields. A Claude `rate_limit_event` with any status other than `allowed` is always flagged; `allowed` events are routine telemetry.
- **Flags.** One flag per matched location, listing every rule that matched, with a scrubbed single-line excerpt and a stable id. The audit is written beside the block it audits, as `records/<cohort>/block-NN/audit.json`. Every flag starts `pending`. `--decide <flag> --decision reclassified|dismissed --reason … --by …` records one decision, which is never overwritten. A rescan keeps decisions, and it refuses to run if a decided flag no longer matches or the pattern list changed.
- **Reclassification.** `attempt.json` is never rewritten. The campaign, `npm run account` and `npm run analyse` read the audit as an overlay: the attempt becomes operational `quota-exhausted`, keeps its usage and evaluation, and records the original termination and the flag ids. The slot is refilled under the ordinary replacement rules, and the reclassified attempt counts as one of the slot's operational attempts. To refill, commit the audit, publish that revision, rerun `npm run campaign -- --block N` on the runner, then fetch and audit again. The audit file travels only from the worktree to the runner; fetches never copy a runner copy back.
- **Completeness.** The analysis marks the cohort incomplete while any block's audit is missing, has a pending flag, or has not scanned a scored failure (for example a refill that itself failed).

Operational attempts' incurred usage and estimated cost are reported next to the scored results, so exclusion cannot hide overhead.

## 9. Acceptance (defined before any output exists)

A workflow is **accepted** if and only if both conditions hold:

1. it ended `completed` (section 8), and
2. its frozen final snapshot passes **every** case of the independent evaluator within the 2-minute ceiling.

There is no partial credit in the primary metric. Per-behaviour pass counts are reported as a secondary diagnostic.

The evaluator tests these behaviours black-box, over HTTP and in a browser. The concrete endpoints, payloads, and UI elements are fixed in `task.md` by the scaffold slice, and the evaluator cases by the evaluator slice, both before pilots.

| ID | Behaviour |
| --- | --- |
| A1 | Server and worker start with the documented commands within a fixed startup window and report healthy. |
| A2 | A valid submission creates exactly one job and returns its identifier and initial state. |
| A3 | A submitted job progresses to completion, and its result and state are visible through the API and the UI. |
| A4 | Invalid input is rejected with a client error and creates no job. |
| A5 | Resubmitting the same idempotency key with the same payload returns the same job; the same key with a different payload is a conflict; neither creates a duplicate. |
| A6 | A transient worker failure is retried to completion without a duplicate job or result, and the attempt count is visible. |
| A7 | After the server and worker are stopped and restarted, jobs and their states persist, and in-flight work resumes. |
| A8 | The browser UI supports submission and shows status and validation errors. |

**Evaluator rules.**

- The evaluator, its fixtures, and its verdicts live outside every model-visible workspace, under OS-level isolation (prompt instructions alone are not protection). They run in a separate process against a copy of the snapshot.
- Missing output, or an evaluation failure caused by the app, is a rejection.
- An evaluator infrastructure failure is operational.
- Acceptance thresholds are never changed after outputs exist, including when every attempt passes or every attempt fails.

## 10. Measurement and accounting

**Per stage**, the runner records:

- role, provider, tool and version, requested and resolved model, applied effort, and session ID;
- input hashes and handoff artifact revision;
- start and end times, terminal state, and native settings in effect;
- raw usage output, verbatim and secrets-scrubbed;
- normalised usage in the five cost.dev dimensions, and a completeness flag: `complete`, `partial`, or `missing`.

**Per workflow**, the runner records:

- condition, block, schedule slot, and actual order;
- task, scaffold, checks, evaluator, runner, prompts, config, and price-snapshot hashes;
- the operating-system environment;
- the terminal state, acceptance, per-behaviour evaluator results, and evaluator duration;
- active elapsed time, any quota waiting, and any manual handling, each kept separate;
- replacement links.

**Normalisation rules.**

- Native counters are always kept next to the normalised values.
- Whether each counter is per request, per turn, or cumulative across a resume is established from installed-client output in the adapter slices and pilots, then fixed. Claude Code's `modelUsage` and cost totals are cumulative across a resume (S12). The installed 2.1.323 client documents `model_usage_since_last_result` as the incremental per-model counter to sum within a conversation, because each call appears on at most one result even across resumes and kills. A resumed stage's usage is therefore the sum of its own results' incremental counters. Differences between successive cumulative totals serve only as a cross-check, and cumulative totals are never summed. Codex `turn.completed` semantics are unresolved (S11) and must be settled the same way.
- Cached input that is a subset of an input total is subtracted from that total, so the two categories are mutually exclusive. Reasoning tokens follow each vendor's output-billing semantics and are never counted twice.
- Auxiliary requests (S13) are disabled where the client allows it. Otherwise they are attributed and priced at the model that served them.
- A category the client does not report is **unknown**, never zero. An interrupted stage keeps whatever it captured, flagged `partial`.

**Valuation** uses only [`prices/cost-dev-2026-11-13.csv`](prices/cost-dev-2026-11-13.csv), derived from the committed raw cost.dev responses (direct / realtime / global / USD books, S14).

- `stage cost = Σ over dimensions of tokens × rate / 1,000,000`, using that stage's model row.
- Each request is classified by its own prompt length against the tier condition: Astra and Luna above 272,000 input tokens; Haiku above 100,000 prompt tokens. If usage cannot be attributed to individual requests, the stage's tier is undetermined. The stage is then reported as labelled lower and upper bounds where the counters support them, or as unavailable. It is never silently priced at the lower tier.
- A workflow's cost is the sum of its stage costs. If any stage cost is unknown, the workflow total is unavailable.
- The primary comparison uses exactly one price snapshot. Repricing under another snapshot must not change any measured quantity.
- One model's token count is never repriced as evidence of what another model would have used.

**Implementation** (`src/accounting/`, regenerated from saved records by `npm run account -- --label <campaign>`, which writes `accounting.json` beside each `attempt.json`):

- Counter semantics live in [`config/usage-semantics.json`](config/usage-semantics.json). Where a Codex semantics is still `null` (per-turn or cumulative scope, cached-input subset, reasoning inclusion), the normaliser reports both readings as a lower and upper bound. It does not choose one. Unreported Codex cache writes are unknown. The pilot slice settles these values before the freeze gate.
- Token counts are intervals. Measured counts are exact; counts that depend on an unsettled semantics are bounded; unknown or interrupted counts have no upper bound. Costs are exact integer pico-USD sums, so role and workflow totals equal their stage totals exactly.
- Claude Code cache writes that the client does not split by TTL are priced between the 5-minute and 1-hour rates.
- Usage that cannot be attributed to an observed request is priced at the base tier only in two cases: the price book is flat, or every observed request of that model is base-tier and the unattributed prompt total is itself within the threshold. This covers auxiliary calls, Codex per-turn aggregates and truncated streaming counts. Otherwise it is bounded below by base rates and above by long-context rates.
- A cost is reported as `exact`, `bounded`, `lower-bound` (an unknown category, an unpriced dimension or an interrupted stage), or `unavailable` (no price row, or no stage record). Only `exact` costs carry a single dollar figure.
- Every attempt is accounted, operational ones included, with the attempt's operating environment (OS, CPU, memory, Node.js, benchmark Git revision, and a SHA-256 of `/etc/machine-id` that binds the attempt to the host whose recorded evidence the freeze gate accepts; the raw id is never stored), the evaluator duration, and the price-snapshot and semantics hashes.

**Per condition**, all derived from saved records only:

- **Acceptance rate**: accepted ÷ scored workflows.
- **Total estimated cost**: the sum over **all** scored workflows, including failures.
- **Cost per accepted workflow**: total estimated cost ÷ accepted workflows. With zero accepted, there is no finite value. The result is reported as undefined, never as $0.
- **Per-role and per-category tokens.**
- **Elapsed-time distribution.**
- **Operational overhead**, reported separately.

**Aggregation** (`src/analysis/`, run with `npm run analyse -- --label <campaign>`; no credentials, no model process, nothing under `records/` written):

- Accounting is regenerated in memory from the saved `attempt.json` and `stage.json` files with the one dated snapshot. Aggregation refuses to run, listing every problem, on any of the following: a duplicated attempt; two scored attempts in one slot; a condition that disagrees with `config/schedule.json`; an unknown condition or foreign campaign; a replacement link to a missing or scored attempt; more than one price snapshot or semantics file; an accepted workflow that did not complete; a scored workflow without a verdict; or more scored workflows than the condition's ten.
- Solo, plan → implement, and implement → review → fix are reported separately. The collaboration outputs show the solo conditions as a labelled control group made up of the same observations. They are never counted twice, and no score is pooled across workflows or pairings.
- Each condition reports:
  - accepted ÷ scored, with termination counts;
  - total, accepted-only, and failure cost;
  - role costs and tokens by stage kind and role, sensor repairs included;
  - token-category and elapsed-time distributions;
  - measurement completeness;
  - operational attempts and their cost.
- A condition's cost status is its worst workflow's. With zero accepted, the cost per accepted workflow is `undefined`.
- Records are put into canonical order before any calculation, so results do not depend on read order. Repricing every rate by an integer `k` scales every cost numerator by exactly `k` and changes no measured quantity; this is property-tested.
- Outputs:
  - `results/<label>-analysis.json` and `results/<label>-summary.md`;
  - per-workflow `-conditions.csv`, `-workflows.csv`, and `-roles.csv` tables;
  - `-operational.csv` (the exclusions);
  - for each workflow, four static SVG figures, each with a CSV text equivalent: acceptance with Wilson intervals, cost per accepted workflow with its bootstrap interval, mean tokens by billing category, and every elapsed observation against the ceiling. These are written to the figures directory (`--figures-dir`; `figures/` in this repository).
- Every figure names its cohort, its dataset status, and the price date. Undefined, unavailable, and lower-bound costs are written as words or open-ended marks, never as finite points.
- Figures are written only for the complete scored cohort. `--allow-incomplete` writes interim figures marked "INCOMPLETE … methodology only". Pilot labels produce tables only, unless `--figures-dir` is given.
- Unit tests use synthetic in-memory records (`tests/unit/support/synthetic-records.ts`), which are clearly separate from observations. No synthetic output is committed under `results/` or `figures/`.

Calculated dollars are counterfactual API-equivalent estimates. They are not subscription bills and do not measure quota consumption. Subscription expenditure is reported separately as the user's existing plan charges, unchanged by the experiment.

## 11. Uncertainty

All intervals are conditional on this workload and these configurations. None describes general coding ability.

- **Acceptance:** 95% Wilson score interval for k of n accepted.
- **Elapsed time and token totals:** every observation, plus median, IQR (type-7 quantiles), and range. No intervals.
- **Cost per accepted workflow:** a percentile bootstrap within each condition. Each resample draws 10,000 times, with replacement, from that condition's ten scored workflows; the statistic is Σ cost ÷ Σ accepted.
  - The PRNG is mulberry32, seeded with `20261114 XOR fnv1a32(conditionId)`.
  - Resamples with zero accepted are **kept**. They are ordered as +∞, and their fraction is reported as "undefined". A 2.5% or 97.5% bound that falls in that mass is reported as unbounded. Those resamples are never dropped to make an interval look finite.
  - If missing costs prevent the calculation, the interval is suppressed.
  - Implementation detail: the ten observations are put into a canonical order (cost, then acceptance) before resampling, so the interval does not depend on read order. Bounds use type-7 percentiles over the sorted statistics; a bound whose upper neighbour is +∞ is reported as unbounded. When every workflow cost is `exact` the bootstrap runs on those costs. When some are `bounded` (an undetermined tier or counter semantics) and none is unbounded, the same resampling is reported separately over the lower and upper bounds. A `lower-bound` or `unavailable` cost suppresses the interval.
- No significance tests. No causal claims across native tools. No pooled pairing score.

## 12. Isolation, permissions, cache, and native settings

Settings: [`config/native-settings.json`](config/native-settings.json). The exact flags are confirmed by the adapter slices, and the effective values are recorded in the freeze manifest. A setting a client cannot apply is recorded as a difference, never dropped silently.

- **Workspace.** Each workflow gets a fresh Git repository copied from the frozen scaffold, with dependencies preinstalled. Codex requires a Git repository (S11).
- **Tool home.** Each workflow gets its own tool home inside this worktree. It contains no personal settings, skills, memory, hooks, MCP servers, or instruction files beyond the scaffold's own. Subscription authentication must work there through the supported login mechanism, and credentials are never copied into records or handoffs. If that is not possible, scoring is blocked and the gap is recorded as a dependency. No other directory is read as a workaround.
- **Permissions.** Planner and reviewer are read-only and write only their captured artifact. Implementer, fix, and repair stages may write inside their own workspace and run local commands. No stage can read the evaluator, other workflows, or the host's home directory. This is enforced at the OS level, not by prompt.
- **Network.** The task does not need it. Network is denied where the tool's sandbox or the OS isolation supports it, and the effective policy is recorded per tool.
- **Cache.** No pre-warming. Provider-side prompt caching cannot be controlled, so it is observed and not assumed. No run is labelled cold.
- **Disabled.** Fallback models, auto-update, Claude Code prompt suggestions (or, if they cannot be disabled, they are attributed), and any effort cap (`maxEffortLevel` must be absent; S08).

**Stage isolation (`src/orchestrator/isolation.ts`).** The orchestrator launches every coding-CLI stage inside an OS sandbox: `sandbox-exec` on macOS, `bwrap` on Linux.

- **Hidden:** this worktree (including the evaluator, references, records, other workflows, and auth homes), the main checkout, and the home directory.
- **Readable:** the benchmark's pinned CLI packages and the Node.js install.
- **Writable:** the stage's tool home, plus its workspace for implementing stages. A planner's or reviewer's workspace copy is readable but not writable.
- **Network:** outbound stays open, because the CLI must reach its provider.
- **Scored blocks** require this isolation (`--isolation required`). Pilots may use `auto`, which records `none` if no sandbox tool works.
- **Codex on macOS.** Seatbelt cannot be applied inside another Seatbelt sandbox, so under the outer `sandbox-exec` Codex's native sandbox is set to `danger-full-access`. The outer sandbox then enforces the stage permission. Codex's own network denial for model commands therefore does not apply on macOS, and model commands share the CLI's network access. Under `bwrap`, or with no outer sandbox, Codex keeps its native `read-only` or `workspace-write` mode. Each stage records both values (`sandbox_mode`, `stage_permission`, `outer_isolation`). Pilots must show that both CLIs run, authenticate, and write only where permitted under the outer sandbox.

**Codex adapter (`src/adapters/codex.ts`).** These are the confirmed mechanisms. Pilots still have to show they work against the live service.

- **Pin.** The CLI is the package's own exact devDependency `@openai/codex@0.169.0`, run from `node_modules/.bin/codex`. The host's global `codex` (0.167.2 on 2026-11-14) is never used. Before each stage, `codex --version` must print exactly `codex-cli 0.169.0`. Otherwise the stage is `runner-infrastructure-failure` (`version-mismatch`) and no model is called.
- **Invocation.** A fresh stage runs `codex exec --json --ignore-user-config --ignore-rules -m <model> -c model_reasoning_effort="<effort>" -c approval_policy="never" -c sandbox_workspace_write.network_access=false -o <capture> --sandbox <read-only|workspace-write> -C <workspace> -`. A resume runs `codex exec resume … -c sandbox_mode="<mode>" <session UUID> -`, because 0.169.0's `exec resume` has no `--sandbox` or `-C`, so the process cwd is the workspace. The prompt goes on stdin. A resume needs a UUID, and `--last`, `--all`, `--ephemeral`, approval bypasses, `--oss`, and `--worktree` never appear. Codex has no fallback-model option to disable.
- **Isolation.** The environment is built from scratch. `CODEX_HOME`, `HOME`, and `TMPDIR` point into a per-session tool home inside the worktree, PATH is passed explicitly (it must contain `node`, because the npm launcher is a Node script), and nothing else is inherited, including `OPENAI_API_KEY` and `CODEX_API_KEY`. A fresh session gets a fresh tool home. A fix or sensor repair reuses the home of the session it resumes, because the rollout lives there. Codex's own sandbox limits the commands it runs. OS-level isolation from the evaluator is applied by the orchestrator slice.
- **Authentication.** The subscription login lives in a dedicated isolated auth home, `.runs/auth/codex` (gitignored). A human creates it once with `CODEX_HOME="$PWD/.runs/auth/codex" npx codex login`. Each stage home gets a mode-0600 copy of `auth.json`, and a token refreshed during the stage is written back atomically. `codex login status` must report ChatGPT login. A missing login is `auth-missing`, and an API-key login is refused as `auth-missing` (`api-key-auth`), with the copy removed. No other directory is read as a fallback. `npm run codex:preflight` checks the pin and the login without calling a model.
- **Usage capture.** The adapter keeps two raw sources per invocation. The first is the stage's own `turn.completed.usage` objects, verbatim. The second is the session rollout's cumulative `token_count` totals before and after the invocation, recorded as supplementary counters. Whether `turn.completed` is per turn or session-cumulative on resume remains unverified (section 10). The pilot settles it by comparing the two sources on a resumed stage. Missing usage is recorded as `missing`, and an interrupted stage keeps what it emitted, flagged `partial`.
- **Resolved model and effort.** These come from a model field in the JSON events when one is present, and otherwise from the rollout's `turn_context`. When neither exists, the model is recorded as unavailable and not assumed. A served model different from the one requested is `model-substituted`.
- **Failure classes.** Error text from `turn.failed` and `error` events, plus stderr after a failure, is classified as `quota-exhausted` (usage or rate limits, including 429), `auth-missing` (login or token failure, or no model access, qualified `model-access`), or `provider-outage` (5xx, overload, disconnects). These causes override the exit status. A timeout is `stage-timeout`. An unrecognised non-zero exit or `turn.failed` is `model-error-exit`.
- **Records.** Each stage writes `prompt.md`, `events.jsonl`, `stderr.txt`, `last-message.md`, and `stage.json` into its record directory, with secrets scrubbed (`src/adapters/scrub.ts`). Unscrubbed capture stays in the gitignored tool home. Termination signals the CLI's whole process group: SIGTERM, then SIGKILL after a grace period.

**Claude Code adapter (`src/adapters/claude.ts`).** These mechanisms were confirmed against the installed 2.1.323 CLI on 2026-11-14 without calling a model. The real CLI was run with a dummy token, which produced a 401. Pilots still have to show the mechanisms work against the live service.

- **Pin.** The CLI is the package's own exact devDependency `@anthropic-ai/claude-code@2.1.323`, run from `node_modules/.bin/claude`. The host's global `claude` (2.1.322 on 2026-11-14) is never used. Before each stage, `claude --version` must print `2.1.323 (Claude Code)`. Otherwise the stage is `runner-infrastructure-failure` (`version-mismatch`) and no model is called.
- **Invocation.** `claude -p --output-format stream-json --verbose --model <model> --effort <effort> --setting-sources "" --prompt-suggestions false --disable-slash-commands --permission-prompts none --permission-mode default --tools <set> --allowedTools <set> --disallowedTools mcp__*`, then either `--session-id <UUID>` or `--resume <UUID>`. The prompt goes on stdin. The adapter generates the fresh session ID, so even a stage killed before its first event has a known session. Stream-json is used rather than `json` for two reasons: a killed stage keeps what it already emitted, and only stream-json results carry `model_usage_since_last_result`. These flags never appear: `--bare`, `--continue`, `--fork-session`, `--fallback-model`, `--no-session-persistence`, and permission bypasses.
- **Toolsets.** Planner and reviewer stages get `Read,Grep,Glob`. Implementer, fix, and repair stages add `Edit,Write,Bash`. Subagents (`Task`), web, scheduling, worktree, and workflow tools are excluded, which keeps each stage on its requested model. On this host, enterprise-managed MCP servers exist (`/Library/Application Support/ClaudeCode/managed-mcp.json`). `--strict-mcp-config` is refused when that file exists, and an explicit `--tools` list does not remove those servers' tools. They are removed by `--disallowedTools mcp__*`. The servers may still start, but the model cannot call them.
- **Permission mode.** Every stage uses `default`. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, which keeps the credential out of commands the model runs, forces `default` anyway: 2.1.323 overrides `acceptEdits` and prints a warning. The stage's `--allowedTools` list pre-approves its tools, and `--permission-prompts none` denies anything else instead of waiting. Pilots confirm that edits and commands are not denied (`permission_denials` is recorded).
- **Isolation.** The environment is built from scratch. `CLAUDE_CONFIG_DIR`, `HOME`, and `TMPDIR` point into a per-session tool home inside the worktree. The environment also sets `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`. Nothing else is inherited, including API keys, auth tokens, base URLs, and third-party provider variables. In an isolated config directory without a token, `claude auth status` reports `loggedIn: false`, so the personal keychain login is not used as a fallback. A fix reuses the home and workspace of the session it resumes, because the transcript lives there. The adapter rejects a stage as `runner-infrastructure-failure` if its init event exposes a tool outside the launched set, or reports a permission mode other than the launched one. Managed policy cannot be overridden. Each stage records its path, SHA-256, and top-level key names, never its contents. On 2026-11-14 the only top-level key was `permissions`. A `maxEffortLevel` anywhere in it stops the stage before launch (`effort-cap-present`).
- **Authentication.** The subscription token comes from `claude setup-token`, a human step done once. It is stored alone in `.runs/auth/claude/oauth-token` (gitignored, mode 0600) through `npm run claude:store-token`, which reads stdin and refuses API keys. The token reaches the CLI only as `CLAUDE_CODE_OAUTH_TOKEN` in the child environment. `claude auth status --json` must report `authMethod: "oauth_token"` with no `apiKeySource`. An init event whose `apiKeySource` is not `none` is refused as `auth-missing` (`api-key-auth`). `npm run claude:preflight` checks the pin, managed policy, and token without calling a model.
- **Usage capture.** Three raw sources are kept verbatim, all counters and no text:
  - per-request `assistant.message.usage`, de-duplicated by message ID, because stream-json repeats a message's usage on each content block. These carry each request's prompt length for the Haiku 100K tier and its 5-minute and 1-hour cache-write split;
  - each result's `model_usage_since_last_result`, the incremental per-model account. An absent field is recorded as absent, not `{}`;
  - each result's cumulative `modelUsage`, with the previous stage's last totals for the same session saved in the tool home and recorded as before/after.

  Any model other than the requested one in these counters is listed as auxiliary, and is attributed rather than hidden. Native `total_cost_usd` is kept as raw data but never used for valuation. A killed process loses calls counted after its last result (per the client's own field description), so an interrupted stage falls back to its per-request usage, flagged `partial`.
- **Resolved model and effort.** The resolved model comes from the principal (non-subagent, non-`<synthetic>`) assistant messages, and otherwise from the init event. Any principal or init model other than the one requested is `model-substituted`. Applied effort is not exposed in stream-json and is recorded as `null`.
- **Failure classes.** These apply only when the stage failed: non-zero exit, timeout, no result, or `is_error`. The HTTP status from the result, the API error message, or the retry notices classifies first: 401/403 is `auth-missing`, 429 is `quota-exhausted`, 404 is `auth-missing` (`model-access`), and 5xx/529 is `provider-outage`. If no status is present, error text and stderr are classified instead. Retries that end in success do not classify a successful stage. A timeout is `stage-timeout`. An unrecognised `is_error` result or non-zero exit is `model-error-exit`.
- **Records.** Records follow the same layout as Codex. Before writing, the literal token is removed, along with credential shapes, and workspace and tool-home paths are replaced with `<workspace>` and `<tool-home>`.

## 13. Subscription time estimate

This estimate is for scheduling only. It is not an entitlement or a calendar promise.

**Pilot-based estimate (replaces the provisional table below).** The freeze gate takes each configuration's most recent exercised pilot, recorded on the AWS runner on 2026-11-24. Those 24 pilots had 1.74 h of active workflow time and 0.14 h of independent evaluation. Multiplied by ten repetitions, that gives about **17.4 h of active workflow time and 1.4 h of evaluation for the 240 scored workflows**, run one at a time. Single pilot workflows took 2.3 to 6.4 minutes of active time. Each figure is a single observation per configuration, so it says nothing about run-to-run variability. The estimate excludes replacements, quota waits, refills after a quota audit, and manual handling. The freeze manifest records the per-configuration observations.

The provisional estimate, written before any pilot existed, is kept for the record:

| Item | Basis | Hours |
| --- | --- | --- |
| Scored workflows, expected | 240 × 10–20 min (hypothetical average), concurrency one | 40–80 |
| Scored workflows, ceiling | 240 × 30 min | 120 |
| Independent evaluation, ceiling | 240 × 2 min | 8 |
| Pilots, ceiling | 24 × 30 min + 24 × 2 min | 12.8 |

Operational replacements, manual handling, and quota waiting come on top of these figures and are recorded separately. Actual per-provider stage times determine the observed subscription workload.

## 14. Freeze gate

Scoring of block 01 may not start until all of the following hold:

1. All 24 configurations have completed one unscored pilot, kept under `records/<cohort>-pilots/` and never pooled with scored data.
2. Subscription access, resolved model IDs, applied effort, usage-counter semantics, the counter-to-dimension mapping, isolation, quota pausing, recovery, and the paid-overflow guard are each demonstrated and recorded.
3. `config/schedule.json` is committed and reproduces from the seed.
4. A freeze manifest `records/freeze/<cohort>.json` records the SHA-256 of the scaffold, check suites, evaluator, runner source, `prompts/`, `config/`, this document, and the price snapshot. It also records OS and CLI versions, effective native settings, isolation evidence, observed pilot durations, and the pilot-based time estimate.
5. The manifest is committed. That commit is the cohort's frozen revision.

`npm run freeze` checks these conditions without calling a model and prints a readiness report (exit 0 ready, 3 not ready). It judges subscription access and isolation from the host evidence that the pilot host recorded, not from the machine running the command. That evidence is the output of `npm run host-evidence`, which the AWS runner (`runner/aws/`) records before and after every campaign run, in `records/<cohort>-pilots/host-evidence/`. Each file holds both CLI preflights against the isolated auth homes, the OS-sandbox probe, OS, kernel, Node.js, CLI and sandbox-tool versions, user-namespace kernel settings, a hashed machine id, the revision, and a timestamp. The gate fails closed when that evidence is missing or malformed. It is stale when older than 14 days or taken before the latest pilot ended. It is inconsistent when it is dated in the future, its CLI versions differ from the pins, it records no revision, or a pilot ran on a different OS, kernel, architecture or Node.js, or at a revision without evidence from the same host. Unusable evidence also counts as failed access and isolation. `npm run freeze -- --evidence local` instead probes the machine it runs on, for a reader whose own Linux host runs the pilots. The command also re-derives the schedule from the seed, reads the Codex counter semantics, and computes SHA-256 tree digests of the scaffold, check suites, references, evaluator, runner, `prompts/`, `config/`, this document, `task.md`, the lockfile, and `prices/`. `npm run freeze -- --write` writes `records/freeze/<cohort>.json` only when every condition holds, and refuses to overwrite an existing manifest. Digests in a not-ready report are provisional.

The gate asks three separate questions of the pilot records in `records/<cohort>-pilots/`:

- **Coverage.** Each configuration has a retained, finished, non-operational pilot. Scored failures count, because failed pilots are kept.
- **Exercise.** Some pilot of each configuration ran every stage `workflowPlan` names, with the planned role. Each fresh stage must have its own session, and the fix must resume the implementer's recorded session. Planner and reviewer handoffs must be `ok`, with a hash and file. Each read-only snapshot must keep the same hash before and after. Every stage, including sensor repairs, needs `complete` usage, a recorded resolved model, and a `sandbox-exec` or `bwrap` isolation mechanism in its `stage.json`. An early failure covers a configuration but does not exercise it.
- **Estimate.** Each configuration's most recent exercised pilot has a positive observed active time and a measured evaluation time. A missing or invalid duration blocks the freeze, and so does an evaluation that did not run or whose duration was not recorded. None is treated as zero. The estimate multiplies those single observations by the ten repetitions and records them in the manifest. It excludes replacements, quota waits, and manual handling.

The paid-overflow guard, quota pausing, and recovery cannot be proved from attempt fields. Each needs an entry in `records/<cohort>-pilots/safeguards.json`. An entry must have a statement of what was demonstrated and at least one cited file under the benchmark root that exists. It must be either kind `record` or kind `human-attestation`, and an attestation also needs `attestedBy` and an ISO `attestedAt` date. A missing or incomplete entry blocks the freeze.

**After the first scored workflow starts, nothing in the manifest changes for the cohort.** Any change to the task, checks, evaluator, runner behaviour, prompts, settings, models, CLI versions, or price snapshot needs a new cohort label with its own pilots and manifest; records of different cohorts are never pooled or overwritten. A missing price row may leave dollars unresolved without blocking scoring. Missing subscription access, isolation, or usage accounting blocks scoring.

## 15. Amendments before freeze

| Date | Section | Change | Reason (must not reference scored outcomes) |
| --- | --- | --- | --- |
| 2026-11-14 | 5 | Added the check implementation and edge-case rules: the check names and disclosed inputs, `not-run` suites after a failed build, the clipping of the check ceiling to the workflow clock, `stage-timeout` when a final-stage repair has no stage time left, and suite-runner failures as operational. The scaffold's fixed `package.json` gains `check:smoke` and `check:contract`, and the scaffold gains `checks/`. | The suites did not exist yet, and the stopping rule left these cases unstated. Written before any model output exists. |
| 2026-11-14 | 12 | Added the Codex adapter mechanisms: an npm-pinned CLI with a version gate, the exact flags (including `-c sandbox_mode` on resume, which has no `--sandbox`), the from-scratch environment, the isolated auth home with copy and write-back, API-key refusal, two-source usage capture, and failure classification. | Settles how the methodology's existing requirements are applied to the installed 0.169.0 CLI. Written before any model output exists. |
| 2026-11-14 | 10, 12 | Added the Claude Code adapter mechanisms. They include `default` permission mode with explicit allowed tools (forced by the credential-scrubbing setting), `--disallowedTools mcp__*` for host-managed MCP servers, setup-token authentication, and three-source usage capture. Resumed-stage usage is now the sum of `model_usage_since_last_result` rather than a difference of cumulative totals. | Settles how existing requirements apply to the installed 2.1.323 CLI and its documented counter semantics. Written before any model output exists. |
| 2026-11-14 | 9 | The evaluator builds and runs the snapshot against the protected copies of the fixed files (`package.json`, the lockfile, `tsconfig.json`, `.gitignore`, `TASK.md`, `checks/`) and records any changes to them instead of honouring them. It also rejects snapshots over 5,000 files or 50 MiB as app-caused. Evaluator details are in `task.md`. | Makes the rule "tampering cannot change a verdict" enforceable. Written before any model output exists. |
| 2026-11-14 | 6, 7, 8, 12 | Added the orchestration rules: plan-derived stages with a ledger, read-only stages on a workspace copy, deadline clipping and the `stage-timeout`/`task-timeout` distinction, atomic checkpoints, recovery by rerun, pause and backoff rules, and the record layout. Added OS-level stage isolation, with Codex's native sandbox set to `danger-full-access` under the outer macOS sandbox because Seatbelt cannot nest. Generated `config/schedule.json`. | The orchestrator did not exist, and these cases were unstated. Written before any model output exists. |
| 2026-11-14 | 10 | Added the accounting implementation: `config/usage-semantics.json`; interval token counts; Codex unsettled semantics reported as both-reading bounds; unsplit Claude cache writes priced between the 5m and 1h rates; the conservative tier rule for unattributed usage; four cost statuses; per-attempt `accounting.json` with the environment. Campaign attempts now record their operating environment. | Makes the existing "unknown, never zero" and per-request tier rules executable on the adapters' saved counters. Written before any model output exists. |
| 2026-11-15 | 8, 14 | Added the pilot-only `--retry-unexercised` option. Without it, an early finished pilot failure left its configuration permanently unexercised, because a rerun skips finished slots. The retry rule is the gate's exercise test, and scored blocks reject the option. | Makes the documented pilot recovery executable. Concerns pilots only, written before any pilot or scored output exists. |
| 2026-11-15 | 14 | Added `npm run freeze` (`src/freeze/gate.ts`, `src/cli/freeze.ts`) to check the gate and write the manifest only when it holds. No contract value changed. | Makes the gate mechanical before any pilot exists. Written before any model output exists. |
| 2026-11-19 | 10, 14 | Pilots and scored blocks run on an EC2 Linux runner with `bwrap` isolation (`runner/aws/`). The freeze gate now judges host evidence recorded on that runner (`src/freeze/host-evidence.ts`, `npm run host-evidence`) rather than probing the machine running `npm run freeze`, and fails closed on missing, malformed, stale or inconsistent evidence. Attempt environments take the revision from the verified bundle manifest when there is no Git checkout (`benchmarkRevision.source: "bundle"`). | Implements Glenn's 2026-11-19 execution-host decision; the agent loop's sandbox cannot apply a nested OS sandbox. Written before any pilot or scored output exists. |
| 2026-11-21 | 10 | Settled the Codex counter semantics from the 2026-11-20 pilot run in `config/usage-semantics.json`. `turn.completed` usage is session-cumulative on resume: in all four resumed Codex stages it equals the rollout total after the turn, and the total before equals the same session's earlier stage. Cached input is a subset of input and reasoning is included in output: in all 24 Codex stages the client's `total_tokens` is input plus output. Cache writes are never reported (always 0), and their billing is not verified. | The pilot slice exists to settle these values (section 14). The evidence is the counters and rollout totals, not any outcome; no scored output exists. |
| 2026-11-21 | 14 | Quota pausing is evidenced by a pilot access pause on 2026-11-20 (`auth-missing` at slot 01, campaign exit 75, replacement after recovery; restated in `records/cohort-03-pilots/README.md`) rather than by an observed quota exhaustion, which did not occur. Glenn accepted this on 2026-11-21, on condition of the audit below. | Exhausting a subscription allowance on purpose would be slow and uncertain and would spend allowance. The pause, wait and replacement path is shared; only the recognition of quota text is unobserved. |
| 2026-11-21 | 8 | Added the per-block quota-misclassification audit (`npm run audit-block`, `src/audit/`, `config/quota-audit.json`) with evidence-only reclassification and slot refill, as detailed in section 8. Reclassification is an overlay read by the campaign, accounting and analysis; `attempt.json` is never rewritten. Audits travel only from the worktree to the runner (`runner/aws/remote/bootstrap.sh` takes the bundle's copy, and fetches skip them). On the 2026-11-20 pilot run the audit scanned 0 scored failures (there were none) and flagged nothing. A check-only diagnostic over all 25 finished pilot attempts also flagged nothing. | Guards the scored comparison against quota interruptions scored as model failures, given the unobserved recognition above. The event-stream exclusions were set from what each event type can contain, not from any outcome. Decided before any scored output exists. |
| 2026-11-21 | 8, 14 | The audit now scans Claude assistant events that the client generates to report an API failure (`error` or `is_api_error_message: true` set, or the `<synthetic>` model), instead of skipping them with model-authored assistant content. Review found that quota text confined to such an event, with no final message and termination `model-error-exit`, raised no flag. A synthetic regression test covers it. Rescanning those pilots still flagged nothing (none of their event streams contains such an event). | Closes a gap in the quota-misclassification safeguard. Based on the event shape the adapter already handles, not on any outcome. Decided before any scored output exists. |
| 2026-11-21 | 13 | Replaced the provisional time estimate with the pilot-based one (about 16.7 h active and 1.3 h evaluation for 240 workflows). | Section 14 requires a pilot-based estimate before scoring. It uses durations only, not outcomes. |
| 2026-11-22 | 8 | The audit scanner kept only the first 20 matches per source, so later quota evidence could be dropped from a `complete` audit. It now keeps every match as a flag, an audit recording discarded matches is incomplete, and `maxFlagsPerSource` became `consoleFlagsPerAttempt` (CLI output only). No pattern and no audit scope changed. | The audit runs after recording and changes no execution. The defect was found by code review on synthetic input, not from any outcome. |
| 2026-11-22 | 12, 14 | Claude Code's Bash tool did not work on the runner: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (set so model commands never see the subscription token) makes Claude Code's own Bash sandbox mandatory, and on Linux that sandbox needs `socat`, which the runner lacked. Now the runner installs `socat`, and under `bwrap` Claude Code's `TMPDIR` is the stage sandbox's private `/tmp` (its bridge sockets need a path under 108 bytes, which the tool home's temp directory exceeded); `npm run shell-preflight` runs one real workspace-write stage per client inside the stage sandbox before every campaign and refuses to start one (exit 78) unless a command succeeds; the freeze gate's exercise test requires each planned fresh implement stage to have run at least one command successfully (`src/audit/shell.ts`; fix and repair stages are not judged, because a failing build there is not a broken shell); `npm run shell-health` reports it live in the runner status. Matrix, models, efforts, limits, prompts, task, evaluator and seed are unchanged, so the schedule is identical. | A broken tool in one provider's configurations would confound every cross-provider and checks comparison. The defect was found in tool results, not outcomes, and the fix restores the documented permission (implementing stages may run local commands). |
| 2026-11-24 | 5, 9, 14 | The scaffold and the correct reference opened SQLite with `PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`. Switching to WAL takes a brief exclusive lock, and with no busy timeout yet set, whichever of the server and worker lost the race at startup crashed at once with "database is locked". Found by the manual evaluator discrimination run on 2026-11-24 (the correct reference crashed the same way). Both files now set `busy_timeout` first (`tests/unit/fixture-db-open.test.ts` reproduces the race with a lock held from another thread). The evaluator's hidden repository root is now the nearest directory with `.git` (or the benchmark itself), never "two levels up", and hiding the filesystem root is refused; this changes which path is hidden, not any case. The T1 tampering expectation now matches its base reference (A3, A6, A7). Matrix, models, efforts, limits, prompts, task, checks and seed are unchanged, so the schedule is identical. Before the pilots, the discrimination suite must pass cleanly (`scripts/run-discrimination.sh`). | A harness defect that crashes some workflows at random, and that the checks then report as model failures, would confound every acceptance and checks comparison. The defect was found in a reference fixture's startup output, not in any scored outcome. |

## 16. Construction and maintenance effort ledger

This ledger records the effort of building and maintaining the harness, kept separate from model runtime. The article reports it on its own. Any break-even scenario built on it must label its assumed labour value, maintenance, and future workload volume.

| Date | Slice | Activity | Agent time | Human time | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-11-14 | Evidence | Source ledger, cost.dev snapshot | Not measured | Not measured | Automated loop iteration; no timer was running |
| 2026-11-14 | Methodology | This contract, `config/`, `prompts/` | Not measured | Not measured | Automated loop iteration; no timer was running |
| 2026-11-14 | Task fixture | `task.md`, scaffold, correct and eight broken references, unit tests | ~13 min (03:38–03:51 AEDT wall clock) | Not measured | Measured from shell timestamps at start and before commit; includes diagnosing an unrelated site-build failure |

| 2026-11-14 | Feedback loop | `checks/` suites, `src/feedback/` runner, loop and feedback builder, unit and manual integration tests | ~8 min (10:27–10:35 AEDT wall clock, from first file written) | Not measured | Reading the existing code beforehand is not included. The local sandbox blocks loopback `listen`, so the suites were exercised against the in-process simulation; real-process runs are in the manual integration suite, which had not run yet |

| 2026-11-14 | Codex adapter | `src/adapters/` (process supervisor, scrubber, Codex adapter), `codex:preflight`, mocked unit tests | ~8 min (10:36–10:44 AEDT wall clock, from first probe) | Not measured | No model was invoked. A real preflight of the pinned CLI ran in an isolated home and returned `auth-missing` (no login yet) |

| 2026-11-14 | Claude adapter | `src/adapters/claude.ts`, `claude:preflight`, `claude:store-token`, mocked unit tests | ~12 min (10:46–10:58 AEDT wall clock, from first probe) | Not measured | No model was invoked. The real pinned CLI ran with a dummy token (401 → `auth-missing`), which exposed the managed-MCP and forced-permission-mode behaviour fixed in this slice. The real preflight returned `auth-missing` (no token yet) |

| 2026-11-14 | Accounting | `src/accounting/` (prices, normaliser, valuation, per-attempt record, tree), `config/usage-semantics.json`, `npm run account`, environment capture, unit and property tests | ~11 min (16:53–17:04 AEDT wall clock, from first file written) | Not measured | Reading the existing code beforehand is not included. No model was invoked. Exercised only on synthetic records; real counter semantics wait for the pilots |
| 2026-11-15 | Pilot gate | `npm run freeze`, gate unit and property tests, first readiness report | ~8 min (01:33–01:41 AEDT wall clock, from first preflight) | Not measured | No model was invoked. Pilots did not run: both isolated logins are absent and this agent session cannot apply a nested `sandbox-exec` sandbox |
| 2026-11-19 | AWS runner kit and recorded host evidence | `runner/aws/` (Terraform, bootstrap, publish/start/status/fetch), `src/runner/`, `npm run host-evidence`, recorded-evidence freeze gate, unit and property tests | ~13 min (19:22–19:35 AEDT wall clock, from first file written) | Not measured | Reading the existing code beforehand is not included. No model was invoked and nothing touched AWS: Terraform was format-checked only; `validate` needs `init`, which was not run |

| 2026-11-21 | Quota audit and freeze | `src/audit/`, `config/quota-audit.json`, `npm run audit-block`, campaign/accounting/analysis overlay, runner audit sync, unit and property tests, pilot smoke audit, freeze manifest | ~12 min to the full unit suite passing (12:04–12:16 AEDT wall clock, from first file written) | Not measured | Reading the existing code beforehand is not included. No model was invoked and nothing touched AWS |

From the scaffold slice onwards, each slice records the start and end wall-clock time of its iteration as measured agent time, and any human review time reported to it. Unmeasured entries stay "Not measured" rather than being estimated after the fact.
