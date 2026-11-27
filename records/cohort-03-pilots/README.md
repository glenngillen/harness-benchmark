# Unscored pilots (cohort-03)

One unscored pilot per configuration (24) before the cohort-03 freeze, run on the AWS runner on 2026-11-24 at concurrency one. Pilots show that each configuration works end to end; they are never scored and never feed the analysis. The freeze manifest (`records/freeze/cohort-03.json`) records the gate's judgement of these files.

| File | What it holds |
| --- | --- |
| `pilot/slot-NN-<condition>/attempt-N/` | One attempt per configuration, in the same format as the scored records |
| `campaign-log.jsonl` | Campaign events for both pilot invocations |
| `host-evidence/` | Runner host probes (OS, Node, client versions, sandbox) before and after the pilots |
| `readiness-*.json` | `npm run freeze` readiness checks judged from the recorded evidence |
| `safeguards.json` | Evidence for the safeguards the attempt records can't prove mechanically (below) |

## The retried pilot

Slot 24 (`irf.AC-AF-AC.on`) has two attempts. In attempt 1 the fix stage reached its stage time limit, so the review stage never ran and the freeze gate's exercise test failed. Attempt 2 is a re-pilot started with `--retry-unexercised` (`pilotRetryOf: 1`, `replaces: null`); attempt 1 is kept unchanged. Nothing in the prompts, task or evaluator changed between the two. To retry an unexercised pilot yourself:

```sh
npm run campaign -- --pilots --isolation required --retry-unexercised
```

The runner applies the gate's exercise test (`pilotLeftUnexercised` in `src/freeze/pilot-attempt.ts`) to each finished pilot slot and starts at most one fresh attempt per slot per invocation. It never retries a scored failure, and it refuses `--block`.

## Safeguard evidence

The pause and replacement paths were exercised by a pilot run on 2026-11-20, on the same AWS runner and the same runner code (`src/orchestrator/campaign.ts` and `src/orchestrator/run.ts` were unchanged by the cohort-03 freeze). Those records aren't part of this repository, so the lines that show it are quoted below. `safeguards.json` points here.

### paid-overflow-guard (human attestation)

Neither the ChatGPT account used for Codex nor the Claude subscription could buy paid overflow, and none was used. No extra Codex usage can be bought on the ChatGPT plan, and the Claude subscription's extra (pay-as-you-go) usage was not enabled. Glenn Gillen first confirmed this on 2026-11-21, when the subscription logins were made on the runner. He re-confirmed it on 2026-11-25, after the cohort-03 pilots and before the freeze. The runner can't inspect either account, so this rests on that attestation. Both adapters refuse API-key credentials, so only the subscription logins were used.

### quota-pausing (record)

No quota exhaustion or access failure occurred in the cohort-03 pilots: `campaign-log.jsonl` here has no `campaign-paused` event.

The pause path was exercised once, in the 2026-11-20 pilot run. The first pilot attempt (slot 01, `solo.CF.off`, attempt 1) started before the Codex login existed. Its single stage ended at once, with the workspace unchanged:

```json
{"at":"2026-11-20T16:12:20.267Z","type":"stage-ended","stage":"s1-implement","termination":"auth-missing","detail":"isolated auth home has no login","sessionId":null,"resolvedModel":null,"workspaceHashAfter":"f68fb18cf56ebc70d3ed81e8bad4740a11e6cf3e071fe2f3497c6629b34ce2fc","usageCompleteness":"missing"}
```

The attempt was recorded as `termination: "auth-missing"`, `outcome: "operational"`, `accepted: null`, so it wasn't scored. Instead the campaign paused, exiting with code 75 (`src/cli/campaign.ts`):

```json
{"at":"2026-11-20T16:12:20.278Z","type":"attempt-ended","slot":1,"attempt":1,"termination":"auth-missing","phase":"finished"}
{"at":"2026-11-20T16:12:20.283Z","type":"campaign-paused","block":0,"slot":1,"conditionId":"solo.CF.off","reason":"auth-missing","attempt":1}
```

Scored failures get a separate check: a per-block quota audit (`npm run audit-block`; `audit.json` in each block directory) looks for quota and access errors in every scored failure.

### recovery (record)

No cohort-03 pilot needed an operational replacement; slot 24's second attempt is a re-pilot, not a replacement.

The replacement path was exercised in the same pilot run. After the login was made, the next invocation started attempt 2 of slot 01 from a fresh workspace (the same scaffold hash). It recorded `replaces: 1` and the 909,019 ms spent waiting for access, then completed and was evaluated:

```json
{"at":"2026-11-20T16:27:29.299Z","type":"attempt-started","slot":1,"conditionId":"solo.CF.off","attempt":2,"replaces":1,"waitBeforeMs":909019,"waitReason":"auth-missing"}
{"at":"2026-11-20T16:30:07.877Z","type":"attempt-ended","slot":1,"attempt":2,"termination":"completed","phase":"awaiting-evaluation"}
{"at":"2026-11-20T16:30:28.384Z","type":"evaluation-ended","slot":1,"attempt":2,"status":"passed","accepted":true}
```

That campaign then finished all 24 slots.
