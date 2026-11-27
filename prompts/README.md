# Role and handoff prompts

These templates are frozen with `methodology.md`. The orchestrator fills the `{{…}}` placeholders and sends the result as the stage's single user prompt. Every provider assignment receives byte-identical text for the same role. Only the placeholder values differ.

| File | Used by | Session |
| --- | --- | --- |
| `solo-implement.md` | Solo implementer | Fresh |
| `plan.md` | Plan → implement: frontier planner | Fresh, read-only |
| `plan-implement.md` | Plan → implement: cheaper implementer | Fresh |
| `irf-implement.md` | Implement → review → fix: cheaper implementer | Fresh |
| `review.md` | Implement → review → fix: frontier reviewer | Fresh, read-only |
| `fix.md` | Implement → review → fix: original implementer | Resumed by explicit session id |
| `sensor-repair.md` | Any implementer, check condition `on` only | Resumed by explicit session id |

## Placeholders

| Placeholder | Value |
| --- | --- |
| `{{TASK}}` | Full text of the scaffold's `TASK.md`, which is also present in the workspace |
| `{{STAGE_MINUTES}}` | Stage ceiling from `config/limits.json` |
| `{{CHECKS_NOTE}}` | `checks-on.md` or `checks-off.md` from `fragments/`, chosen by the check condition |
| `{{PLAN}}` | The planner's captured artifact, truncated at 12,000 bytes with a `[truncated]` marker |
| `{{FINDINGS}}` | The reviewer's captured artifact, truncated at 8,000 bytes with a `[truncated]` marker |
| `{{FEEDBACK}}` | Deterministic check feedback, built per `config/feedback.json` |
| `{{REPAIRS_LEFT}}` | Remaining sensor repairs for the workflow (0–2) |

No placeholder ever contains independent evaluator material, other workflows' outputs, or conversation history from another session.
