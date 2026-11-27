# cost.dev price snapshot (2026-11-13 UTC)

This snapshot is the valuation source for all estimated API-equivalent dollars in the harness benchmark. The user chose [cost.dev/models](https://cost.dev/models), so no provider list price is substituted for it. Ledger entry: `drafts/harness-economics/sources.md` (S14).

These figures are counterfactual API prices. They are not subscription charges, and they do not measure subscription quota.

## Retrieval

| Field | Value |
| --- | --- |
| Retrieved | 2026-11-13T16:26:34Z (2026-11-14 03:26 AEDT) |
| Tool | `curl` (HTTP GET, no authentication, no request body) |
| Page | `https://cost.dev/models` → 301 to `/models/`, a client-rendered shell (`<title>AI Model Cost Comparison Database</title>`, S3 `last-modified` 2026-10-12) with no rows in its HTML |
| Data endpoint | The page's own bundle `/models/assets/index-BvJFdW1M.js` defines `https://api.cost.dev/v1` with `GET /models/meta`, `GET /models`, and `GET /models/{provider:model}`. These are the calls the page makes; no endpoint was guessed. |
| Requests | `GET https://api.cost.dev/v1/models/meta`, `GET https://api.cost.dev/v1/models` (107 items, not committed), and `GET https://api.cost.dev/v1/models/<id>` for the four ids below. All returned HTTP 200. |
| Dataset version | `data_version.git_commit` `17bbcc0a691e0e6c502eb534b6d040cd20249254`; `artifact_hash` `sha256:95a7ea9594352f9366f2d858deae63fb4d89284f3450ba0c63d6241860348a4f`; `generated_at` `2026-11-13T09:21:57.333153738Z`. Every response shares this version. |

## Files

| File | sha256 | Contents |
| --- | --- | --- |
| `raw/cost-dev-20261113T162634Z-openai_gpt-6-astra.json` | `ea85c69c8a67db22019872131e7c7e627d1c449b554a2dd5e0d288a0f9f0bbf6` | Verbatim model detail response |
| `raw/cost-dev-20261113T162634Z-openai_gpt-6-luna.json` | `1621769cc2cfebcf3b68873506c7caa5415cd32ad2e0de7c49ff1e4743970f6c` | Verbatim model detail response |
| `raw/cost-dev-20261113T162634Z-anthropic_claude-opus-5-5.json` | `caf57d640a7bbce02eabd2c551c53b772b9ec0a8cd11892da67d4e25ba16d8ed` | Verbatim model detail response |
| `raw/cost-dev-20261113T162634Z-anthropic_claude-haiku-5-5.json` | `c341499ed640cd56eb04ed910d285c3d78a913acc5c2891694aadde21081377e` | Verbatim model detail response |
| `raw/cost-dev-20261113T162634Z-models-meta.json` | `2da23e2306a8a3d6cbe91023e4edf1525eac843cb87e1742c2acc33f4469318e` | Verbatim metadata response (dimension and benchmark definitions) |
| `cost-dev-2026-11-13.csv` | `8c522d258236c86beaf139b7f9abb56ba27c19d71a40d7dcd95d328fc4c4da33` | One row per dimension and tier range, flattened from each model's `selected_offering` price book. The raw JSON is authoritative; regenerate or verify the CSV against it. |

## Selected rows

Each model uses the price book named in its `selected_offering`: channel `direct`, service mode `realtime`, region `global`, currency USD. Prices are USD per 1,000,000 tokens. Batch, flex, fast, ultrafast, and Bedrock books are kept in the raw files but are not used. Subscription CLI runs are interactive realtime requests, not batch jobs.

| Model id | Price book | Effective / verified by cost.dev | Input | Cached input | Cache write 5m | Cache write 1h | Output | Tier condition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `openai:gpt-6-astra` | `pb_openai_gpt-6-astra_direct_realtime_global_usd_20260903` | 2026-09-03 / 2026-09-04 | 10 | 1 | 12.5 | — | 50 | Prompt over 272,000 input tokens: input 20, cached 2, cache write 25, output 75 |
| `openai:gpt-6-luna` | `pb_openai_gpt-6-luna_direct_realtime_global_usd_20260922` | 2026-09-22 / 2026-09-23 | 0.1 | 0.01 | 0.125 | — | 0.5 | Prompt over 272,000 input tokens: input 0.2, cached 0.02, cache write 0.25, output 0.75 |
| `anthropic:claude-opus-5-5` | `pb_anthropic_claude-opus-5-5_direct_realtime_global_usd_20260922` | 2026-09-22 / 2026-09-23 | 4 | 0.2 | 5 | 8 | 20 | None (flat across 1M context) |
| `anthropic:claude-haiku-5-5` | `pb_anthropic_claude-haiku-5-5_direct_realtime_global_usd_20261007` | 2026-10-07 / 2026-10-08 | 0.1 | 0.01 | 0.125 | 0.2 | 0.5 | Prompt over 100,000 tokens: every dimension ×5 (1, 0.05, 0.625, 1, 2.5 per row) |

`—` means cost.dev publishes no such dimension for that book. It does not mean zero.

## Tier semantics and unresolved mapping

- cost.dev's `estimate_notes` say that both tiered providers apply the long-context rate to the **whole request** once one prompt crosses the threshold. cost.dev's own estimator tiers aggregate tokens, which may understate single large prompts. Pricing in this benchmark must classify each request by its own prompt length. If the CLI usage output cannot attribute tokens to individual requests, the run's tier is undetermined. The estimate is then marked incomplete, or reported as an explicitly labelled lower/upper bound when the counters support one. It is never silently priced at the lower tier.
- The mapping from native counters to these dimensions has not yet been validated against installed-client output. Settle it during the adapter and pilot slices:
  - Codex `turn.completed.usage` exposes `input_tokens`, `cached_input_tokens`, `output_tokens`, and `reasoning_output_tokens` (S11). In the documented sample, `cached_input_tokens` is smaller than `input_tokens`, which suggests a subset, but that is not documented. Whether `reasoning_output_tokens` is included in `output_tokens`, and whether Codex reports cache writes at all, are both unconfirmed. If cache writes are unreported, the `cache_write_5m_tokens` dimension is unknown, not zero.
  - Claude Code reports input, output, cache read, and cache write (S13). The 5-minute and 1-hour cache-write rates differ. If the client does not separate cache writes by TTL, that category needs a recorded assumption or a bound.
  - Claude Code can send auxiliary requests, such as prompt suggestions (S13). These are attributed and priced at the model that served them, or disabled and recorded as disabled.
- A missing row or category leaves the affected estimate unavailable. Nothing is converted to zero.
