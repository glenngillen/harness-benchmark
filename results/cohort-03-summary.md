# Analysis summary: cohort-03

- Status: **complete scored cohort**
- Cohort: cohort-03
- Price snapshot: prices/cost-dev-2026-11-13.csv (sha256 8c522d258236…), cost.dev 2026-11-13
- Bootstrap: percentile, 10000 resamples, seed 20261114 XOR fnv1a32(condition)
- Dollars are API-equivalent estimates from that snapshot, not subscription charges or quota consumption.
- Intervals are conditional on this workload and these configurations.

## Solo

| Condition | Checks | Accepted / scored | Acceptance (95% Wilson) | Total estimated cost | Cost per accepted | Bootstrap 95% | Median active min (IQR) | Operational attempts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex frontier | off | 2 / 10 | 20% (6–51%) | ≥ $7.0755 (lower bound) | ≥ $3.5378 (lower bound) | suppressed (10 workflow cost(s) unavailable or unbounded) | 3.0 (2.9–3.1) | 0 |
| Codex frontier | on | 4 / 10 | 40% (17–69%) | ≥ $7.2250 (lower bound) | ≥ $1.8062 (lower bound) | suppressed (10 workflow cost(s) unavailable or unbounded) | 3.0 (2.9–3.3) | 0 |
| Codex cheaper | off | 9 / 10 | 90% (60–98%) | ≥ $0.1284 (lower bound) | ≥ $0.0143 (lower bound) | suppressed (10 workflow cost(s) unavailable or unbounded) | 3.4 (3.3–3.5) | 0 |
| Codex cheaper | on | 10 / 10 | 100% (72–100%) | ≥ $0.1324 (lower bound) | ≥ $0.0132 (lower bound) | suppressed (10 workflow cost(s) unavailable or unbounded) | 3.6 (3.4–3.7) | 0 |
| Claude frontier | off | 6 / 10 | 60% (31–83%) | $5.6677 | $0.9446 | $0.6237 – $1.9438; 0.0% undefined | 2.4 (2.3–2.5) | 0 |
| Claude frontier | on | 6 / 10 | 60% (31–83%) | $5.4551 | $0.9092 | $0.6126 – $1.8183; 0.0% undefined | 2.4 (2.3–2.6) | 0 |
| Claude cheaper | off | 10 / 10 | 100% (72–100%) | $0.4306 | $0.0431 | $0.0399 – $0.0457; 0.0% undefined | 3.7 (3.5–4.0) | 0 |
| Claude cheaper | on | 9 / 10 | 90% (60–98%) | $0.4262 | $0.0474 | $0.0406 – $0.0628; 0.0% undefined | 3.8 (3.5–4.0) | 0 |

Per-workflow rows: `cohort-03-solo-workflows.csv`; role costs: `cohort-03-solo-roles.csv`.

## Plan → implement

Solo controls are the solo table's conditions (8); their observations are not counted again.

| Condition | Checks | Accepted / scored | Acceptance (95% Wilson) | Total estimated cost | Cost per accepted | Bootstrap 95% | Median active min (IQR) | Operational attempts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex frontier → Codex cheaper | off | 1 / 10 | 10% (2–40%) | ≥ $3.5620 (lower bound) | ≥ $3.5620 (lower bound) | suppressed (10 workflow cost(s) unavailable or unbounded) | 5.6 (5.2–5.7) | 0 |
| Codex frontier → Codex cheaper | on | 2 / 10 | 20% (6–51%) | ≥ $3.4700 (lower bound) | ≥ $1.7350 (lower bound) | suppressed (10 workflow cost(s) unavailable or unbounded) | 5.1 (4.9–5.4) | 0 |
| Codex frontier → Claude cheaper | off | 1 / 10 | 10% (2–40%) | ≥ $3.7868 (lower bound) | ≥ $3.7868 (lower bound) | suppressed (10 workflow cost(s) unavailable or unbounded) | 5.2 (4.8–5.7) | 0 |
| Codex frontier → Claude cheaper | on | 1 / 10 | 10% (2–40%) | ≥ $3.9212 (lower bound) | ≥ $3.9212 (lower bound) | suppressed (10 workflow cost(s) unavailable or unbounded) | 5.9 (5.4–5.9) | 0 |
| Claude frontier → Codex cheaper | off | 5 / 10 | 50% (24–76%) | ≥ $2.3232 (lower bound) | ≥ $0.4646 (lower bound) | suppressed (10 workflow cost(s) unavailable or unbounded) | 4.6 (4.4–4.8) | 0 |
| Claude frontier → Codex cheaper | on | 2 / 10 | 20% (6–51%) | ≥ $2.4041 (lower bound) | ≥ $1.2021 (lower bound) | suppressed (10 workflow cost(s) unavailable or unbounded) | 4.9 (4.3–5.0) | 0 |
| Claude frontier → Claude cheaper | off | 4 / 10 | 40% (17–69%) | $2.5788 | $0.6447 | $0.3504 – $2.6728; 0.7% undefined | 4.1 (4.0–4.7) | 0 |
| Claude frontier → Claude cheaper | on | 2 / 10 | 20% (6–51%) | $2.8651 | $1.4326 | $0.5652 – unbounded; 10.8% undefined | 4.7 (4.4–5.1) | 0 |

Per-workflow rows: `cohort-03-pi-workflows.csv`; role costs: `cohort-03-pi-roles.csv`.

## Implement → review → fix

Solo controls are the solo table's conditions (8); their observations are not counted again.

| Condition | Checks | Accepted / scored | Acceptance (95% Wilson) | Total estimated cost | Cost per accepted | Bootstrap 95% | Median active min (IQR) | Operational attempts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex cheaper → Codex frontier → Codex cheaper | off | 2 / 10 | 20% (6–51%) | ≥ $4.6742 (lower bound) | ≥ $2.3371 (lower bound) | suppressed (10 workflow cost(s) unavailable or unbounded) | 5.8 (5.6–6.4) | 0 |
| Codex cheaper → Codex frontier → Codex cheaper | on | 5 / 10 | 50% (24–76%) | ≥ $4.4087 (lower bound) | ≥ $0.8817 (lower bound) | suppressed (10 workflow cost(s) unavailable or unbounded) | 5.7 (5.4–6.6) | 0 |
| Codex cheaper → Claude frontier → Codex cheaper | off | 6 / 10 | 60% (31–83%) | ≥ $2.0066 (lower bound) | ≥ $0.3344 (lower bound) | suppressed (10 workflow cost(s) unavailable or unbounded) | 5.5 (5.4–5.7) | 0 |
| Codex cheaper → Claude frontier → Codex cheaper | on | 2 / 10 | 20% (6–51%) | ≥ $1.9421 (lower bound) | ≥ $0.9710 (lower bound) | suppressed (10 workflow cost(s) unavailable or unbounded) | 5.8 (5.3–6.2) | 0 |
| Claude cheaper → Codex frontier → Claude cheaper | off | 7 / 10 | 70% (40–89%) | ≥ $5.3278 (lower bound) | ≥ $0.7611 (lower bound) | suppressed (10 workflow cost(s) unavailable or unbounded) | 5.4 (5.0–6.0) | 0 |
| Claude cheaper → Codex frontier → Claude cheaper | on | 8 / 10 | 80% (49–94%) | ≥ $4.8522 (lower bound) | ≥ $0.6065 (lower bound) | suppressed (10 workflow cost(s) unavailable or unbounded) | 6.0 (5.5–6.2) | 0 |
| Claude cheaper → Claude frontier → Claude cheaper | off | 4 / 10 | 40% (17–69%) | ≥ $2.6946 (lower bound) | ≥ $0.6736 (lower bound) | suppressed (1 workflow cost(s) unavailable or unbounded) | 4.9 (4.4–5.3) | 0 |
| Claude cheaper → Claude frontier → Claude cheaper | on | 2 / 10 | 20% (6–51%) | $2.5625 | $1.2812 | $0.5404 – unbounded; 11.3% undefined | 5.0 (4.7–5.7) | 0 |

Per-workflow rows: `cohort-03-irf-workflows.csv`; role costs: `cohort-03-irf-roles.csv`.

## Operational overhead (excluded from denominators)

- Attempts: 0 (none)
- Estimated cost: $0.0000
- Waiting before attempts: 0.00 h; manual handling: 0
- Active time: scored 18.73 h, operational 0.00 h; independent evaluation 1.48 h
