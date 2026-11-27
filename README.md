# Harness benchmark

The standalone example behind the article *Does a harness pay for itself? Frontier vs cheap models, with and without one* on glenngillen.com. It holds a fixed coding task, a hidden evaluator, a runner that drives Codex CLI and Claude Code through three workflows with and without added deterministic checks, the recorded runs, a dated price snapshot and the analysis.

You can inspect and regenerate every published number from saved records with no credentials and no model calls. That takes a few seconds. Running fresh model workflows needs Linux with `bubblewrap`, a ChatGPT plan with Codex access and a Claude subscription, and (as the experiment did it) an AWS account for the runner kit. Those steps are documented here, but only the credential-free steps were re-executed for this guide (see "What was checked" below).

None of Glenn's private harness is used, copied or required.

## What's here

| Path | What it is |
| --- | --- |
| `task.md`, `fixtures/scaffold/` | The task brief and starting repository every model receives |
| `src/evaluator/`, `fixtures/references/` | The hidden evaluator (53 cases over HTTP and in a browser) and the reference implementations it is tested against: one correct, eight broken, two tampering |
| `fixtures/scaffold/checks/`, `src/feedback/` | The deterministic build-time checks (build, smoke, contract) and the feedback loop that runs them |
| `prompts/`, `config/` | Role prompts and the frozen matrix, models, efforts, limits, schedule and usage semantics |
| `methodology.md` | The full protocol: definitions, matrix, limits, accounting, statistics, amendments, effort ledger |
| `records/cohort-03/` | The 240 scored workflows the article reports (recorded 2026-11-24 and 25 UTC), with each block's quota audit |
| `records/cohort-03-pilots/` | The unscored pilots that preceded them; not part of any denominator |
| `records/freeze/cohort-03.json` | The freeze manifest fixing the configuration before scoring |
| `prices/` | The cost.dev snapshot of 2026-11-13 used for every dollar figure |
| `results/` | Generated tables, summaries and diagnostics |
| `figures/` | The 12 figures `analyse` draws (four per workflow), each an SVG with a CSV of the same data |
| `post/` | Post-hoc tooling outside the frozen runner: rejection diagnostics and the freeze digest check |
| `runner/aws/` | The AWS runner kit used for every recorded run |
| `scripts/run-discrimination.sh` | Runs the evaluator discrimination suite in a throwaway Linux container (needs Docker) |

Every dollar figure is an **estimated API-equivalent cost** from the 2026-11-13 snapshot, not a subscription charge. Codex 0.169.0 does not report cache-write tokens, so any figure that includes a Codex stage is a lower bound (`≥`).

## Prerequisites

For the saved-data analysis (validated 2026-11-24 on macOS, Darwin 25.6, arm64):

- **Node.js 22.23.4** (`.node-version`). The scripts use `--experimental-strip-types`, so older Node 22 releases may not run them.
- **npm 10.9.9.** `.npmrc` sets `legacy-peer-deps=true` because npm 10.9.9 crashes resolving vitest's optional peers without it.
- `git` and `tar`, to make a fresh copy.
- About 90 MB of disk for the records, plus `node_modules`.

For fresh model runs, in addition:

- Linux with unprivileged user namespaces and `bubblewrap`, plus `socat` (Claude Code's own Bash sandbox needs it). The recorded runs used Ubuntu 24.04 on an AWS `t3.medium`, set up by `runner/aws/remote/bootstrap.sh`.
- The pinned CLIs, installed by `npm ci`: Codex CLI 0.169.0 and Claude Code 2.1.323.
- A ChatGPT plan with Codex access and a Claude subscription, **neither able to buy paid overflow**. The runner never switches to API keys or buys credits.
- For the runner kit: an AWS account, Terraform ≥ 1.6, AWS CLI v2 and the Session Manager plugin (`runner/aws/README.md`).

## 1. Set up in a fresh directory

From a clone of this repository, copy it into a new, empty directory so nothing you run touches the committed files:

```sh
dest=../harness-benchmark-copy-$(date +%Y%m%dT%H%M%S)   # any new directory
mkdir -p "$dest"
git archive HEAD | tar -x -C "$dest"
cd "$dest"
node --version        # v22.23.4
npm ci
npm run typecheck
npm test              # unit suite: pure, no network, no child processes
```

Each step takes seconds; measured timings are under "What was checked".

## 2. Regenerate the published results without credentials

```sh
npm run analyse   -- --label cohort-03
npm run diagnose  -- --label cohort-03
npm run shell-health
npm run schedule  -- --check
```

| Command | Writes | What you should see |
| --- | --- | --- |
| `analyse` | `results/cohort-03-{summary.md,analysis.json,operational.csv}`, `results/cohort-03-{solo,pi,irf}-{conditions,workflows,roles}.csv`, and 12 figures, each an SVG plus a CSV, into `figures/` (or `--figures-dir DIR`) | `240/240 scored workflows; 0 operational attempt(s); dataset=observed` |
| `diagnose` | `results/cohort-03-{rejections.csv,diagnostics.md,walkthrough.json}` | `accepted 110, build-failed 0, did-not-start 0, inflight-attempt-count-only 125, other 5` |
| `shell-health` | stdout only | `Claude 120/120 working`, `Codex 120/120 working` |
| `schedule --check` | nothing | `config/schedule.json reproduces from the seed` |

`analyse` plus `diagnose` take about a second.

To check that your copy reproduces the committed outputs, compare it with your clone: `diff -r <clone>/results results && diff -r <clone>/figures figures`. Every file should be byte-identical.

`npm run account -- --label cohort-03` re-derives per-attempt accounting and writes an `accounting.json` beside each `attempt.json` (do it in your copy, not your clone). It took 2 s.

### Reproduce a cost per accepted result by hand

Take any condition in `results/cohort-03-solo-workflows.csv` (or `-pi-`, `-irf-`). Sum `cost_usd` over its ten rows, including the rejected ones, and divide by the number with `accepted` = `true`. If any row's `cost_status` is `lower-bound`, use `cost_lower_usd` and write the result as `≥`. If it is `bounded`, compute with `cost_lower_usd` and `cost_upper_usd` separately. If none were accepted there is no finite cost per accepted result. The prices behind each row are in `prices/cost-dev-2026-11-13.csv`; `methodology.md` section 10 explains the token categories and tiers.

### Inspect one recorded workflow

`records/cohort-03/block-01/slot-01-pi.AF-AC.on/attempt-1/` is the article's walkthrough:

- `attempt.json`: condition, timings, termination, acceptance, per-stage models and session ids, environment and benchmark revision.
- `transitions.jsonl`: every state change in order, including handoffs, check runs and the feedback-loop decision.
- `handoffs/plan.md`: the frontier model's plan, exactly as handed to the implementer.
- `stages/<stage>/`: the prompt sent, the native event stream (`events.jsonl`), the final message and stderr.
- `checks/01.json`: the deterministic check run.
- `verdict.json`: the evaluator's 53 case results.

## 3. Run fresh workflows (subscriptions required)

Fresh runs go into a **new cohort in a Git checkout**. Cohort-03 is finished: its records are the published evidence, and the runner skips every slot that already has a result, so pointing it at cohort-03 would run nothing and could mix your results with mine. Don't use the step 1 copy either: it has no `.git`, and the runner only ever installs committed revisions (`bin/publish` archives a commit, `bin/blocks` runs the commit that wrote the freeze manifest).

### Start a new cohort

In a clone of this repository (not the step 1 copy):

```sh
git switch -c cohort-04
sed -i.bak 's/"cohort": "cohort-03"/"cohort": "cohort-04"/' config/*.json && rm config/*.json.bak
npm ci
npm run schedule              # rewrites config/schedule.json for the new label (same seed)
npm run schedule -- --check   # config/schedule.json reproduces from the seed
npm test
npm run freeze                # exit 3: nothing for cohort-04 exists yet, which is expected
git commit -am "Start cohort-04"
```

Use any unused `cohort-NN` label. Every `config/*.json` that has a `cohort` field must carry the new one (`config/quota-audit.json` has none). Record why you started the cohort in `methodology.md` sections 14 and 15. New records go to `records/cohort-04/`, pilots and host evidence to `records/cohort-04-pilots/`, and the manifest to `records/freeze/cohort-04.json`, beside cohort-03's, which stay untouched. `npm run freeze` only ever judges the cohort named in `config/`, so cohort-03's pilots and safeguards never count towards yours.

Before the freeze you need your own `records/cohort-04-pilots/safeguards.json`, with the paid-overflow guard attested by you for your accounts, and the quota-pausing and recovery entries pointing at your own records (`methodology.md` section 14 lists what each needs; `records/cohort-03-pilots/safeguards.json` is a worked example, not evidence for your cohort).

### Run it

The recorded runs used the AWS runner kit. Follow `runner/aws/README.md`; in outline, from the root of that checkout, committing as you go so the runner installs what you mean:

```sh
terraform -chdir=runner/aws/terraform init
terraform -chdir=runner/aws/terraform apply
runner/aws/bin/login                 # installs the committed HEAD on the runner, creates both isolated logins, offers to start pilots
runner/aws/bin/start --pilots        # unscored: one workflow per configuration (24)
runner/aws/bin/start --pilots --retry-unexercised   # only if a pilot ended before exercising every stage
runner/aws/bin/status
runner/aws/bin/fetch                 # copies allowed record files into records/cohort-04-pilots/
# add records/cohort-04-pilots/safeguards.json, then commit the pilot records
npm run freeze -- --write            # only when the gate passes
git add records/freeze/cohort-04.json && git commit -m "Freeze cohort-04"
runner/aws/bin/blocks start          # the ten scored blocks, unattended, at the commit that wrote the manifest
runner/aws/bin/fetch
git add records/cohort-04 && git commit -m "cohort-04 records"
runner/aws/bin/teardown              # after the records are committed
npm run analyse  -- --label cohort-04
npm run diagnose -- --label cohort-04
```

Only the new-cohort setup above was re-run for this guide (label switch, schedule, tests and the freeze report on 2026-11-28); the AWS steps were not repeated.

What a run costs in time: the 25 pilot attempts (one per configuration, plus one rerun of a configuration whose first pilot ran out its stage time before reaching review) took 1.99 h of active time (median 4.6 minutes per workflow, longest 15.0) plus a median of 21 s of evaluation each, between 10:35 and 14:17 UTC on 2026-11-24. The 240 scored workflows took 18.73 h active plus 1.48 h of evaluation and ran from 14:53 UTC on 2026-11-24 to 11:14 UTC on 2026-11-25, with no quota pause. Your subscription's limits decide whether you can do the same; neither figure is an entitlement.

Before every campaign, `runner/aws/remote/campaign.sh` runs `npm run shell-preflight`: one short real stage per client that must run `node --version` successfully. If it fails, the campaign doesn't start (exit 78) and the details are in `.runs/runner/shell-preflight.json`. `runner/aws/bin/diagnose` collects them.

### Quota pauses

A campaign exits `75` when it pauses for quota, lost access or exhausted operational replacements; `runner/aws/bin/status` shows the reason. Wait for the allowance to recover and run the same `start` command again. The unattended `bin/blocks` driver does this itself for quota and provider-outage pauses: it waits 30 minutes and relaunches the same block, up to 48 times, and stops on any other pause. Waiting time is recorded separately and never counted as active time.

### Interrupted runs

Rerun the same command. Finished slots are skipped. An interrupted attempt is kept and replaced by a fresh attempt in a fresh workspace, linked by `replaces`; at most two operational replacements per slot, after which the campaign pauses and the cohort is reported incomplete. Scored quality failures are never retried.

### Resetting without deleting anything

Never delete or overwrite `records/`. To start over:

- **A fresh copy** for analysis or experiments: repeat step 1 into a new directory.
- **Another set of runs**: start another new cohort as above (`cohort-05`, …) in a Git checkout.
- Every model stage and evaluation already runs in its own fresh workspace under `.runs/` (gitignored).

## 4. Adapt it to your own task

1. Replace `task.md` and `fixtures/scaffold/` with one representative task from your codebase.
2. Rewrite the evaluator cases in `src/evaluator/cases.ts` as black-box checks the models can't see, and add broken references under `fixtures/references/` that each fail a different case. Run the discrimination suite (`scripts/run-discrimination.sh` with Docker, or `npm run test:integration` on Linux with `bubblewrap`) to prove the evaluator tells them apart.
3. Decide what the build-time checks in `fixtures/scaffold/checks/` should cover, including the failures you actually see in review.
4. Start a new cohort in a Git checkout (section 3), pin your models and efforts in `config/models.json`, run the pilots, and don't score anything until `npm run freeze` passes, including the shell condition.
5. Run the solo matrix first, then compare cost per accepted result and read every rejection with `npm run diagnose`.

## Tests

| Suite | Command | Where it runs |
| --- | --- | --- |
| Unit (pure, mocked I/O) | `npm test` | Anywhere; also before every commit |
| Evaluator discrimination (integration and browser) | `scripts/run-discrimination.sh` | Manually, anywhere Docker runs. Output in `.runs/discrimination/<timestamp>/` |
| The same, without Docker | `npm run fixtures:install && npx playwright install --with-deps chromium && npm run test:integration` | Manually, on Linux with `bubblewrap` |

Before the cohort-03 pilots, the discrimination suite passed 19 of 19 on the code that was then frozen: the correct reference was accepted, and every broken and tampering reference was rejected.

## Troubleshooting

- **`npm ci` fails with "Cannot read properties of null (reading 'edgesOut')".** You're missing `.npmrc` (`legacy-peer-deps=true`); copy the whole directory, not just `package.json`.
- **`node: bad option: --experimental-strip-types`.** Use Node 22.23.4.
- **Chromium won't launch** (`Executable doesn't exist`, or the browser closes at once inside a sandboxed agent or container). Run `npx playwright install chromium`; inside a restrictive sandbox, run the browser suites on an ordinary machine instead.
- **`shell-health` prints a `WARNING`.** An agent couldn't run commands. Stop the campaign (`runner/aws/bin/blocks stop`) and run `runner/aws/bin/diagnose` before scoring anything.

## Where this repository came from

The benchmark was built and run in a private repository and copied here for readers.

- **Revisions.** `benchmarkRevision.commit` in every attempt record, and the commits in the freeze manifest and host evidence, are commits in that private repository. Its history isn't published.
- **Edited for publication.** Some comments and documentation were edited to remove development history, so the freeze manifest's digests no longer match every file. The evaluator, scaffold, check suites, reference implementations, lockfile and price snapshot are byte-identical to the digests in `records/freeze/cohort-03.json`. The runner source, `config/`, `prompts/README.md`, `methodology.md` and `task.md` differ, in comments, prose and descriptive config fields only. The only code changes remove a special-case pilot directory name for an unpublished cohort (no cohort-03 path used it) and a constant that existed only for it, and shorten one error message. No protocol value, prompt, task brief or check changed. The safeguard statements in `records/cohort-03-pilots/safeguards.json`, and the manifest's copy of them, were reworded the same way and now cite `records/cohort-03-pilots/README.md`.
- **Source IDs.** Identifiers such as S07 in `methodology.md` refer to the research notes behind the article, which aren't published.

## What was checked

On 2026-11-27 this repository was cloned into a fresh directory and checked there:

- `npm ci` (warm npm cache), `npm run typecheck` and `npm test` passed: 46 test files, 764 tests.
- `analyse` and `diagnose` regenerated every file in `results/` and `figures/` byte for byte (`git status` clean afterwards). They printed the outputs in the step 2 table.
- `schedule --check` and `shell-health` printed the outputs in the step 2 table.

Step 3 wasn't re-run for this guide, because it needs AWS access and subscription logins. Its commands are the ones used for the recorded pilots and blocks, and its timings come from those records. The discrimination suite was last run on 2026-11-24, on the frozen code.

Timings vary with the machine. On an idle Apple M4 (2026-11-24), `npm ci` took 4 s, typecheck 2 s and the unit suite 4 s. On a loaded one (2026-11-27), they took 14 s, 9 s and 12 s. A cold npm cache also downloads both coding CLIs and Playwright, so expect longer.

## Licence

MIT. See `LICENSE`.
