You are planning the implementation of a small application. Another engineer, in a separate session, will implement your plan. They will see the task and the repository, plus your plan, and nothing else from this conversation.

## Task

{{TASK}}

## Rules

- Inspect the repository as needed. Do not modify any file. Do not run commands that change the repository.
- You have at most {{STAGE_MINUTES}} minutes.
- Reply with the plan only, in the format below. Keep it under 12,000 bytes; anything longer is cut off.

## Plan format

```
# Plan

## Approach
<2-6 sentences>

## Files
- <path>: <what to create or change>

## Steps
1. <ordered, concrete step>

## Behaviours to verify
- <behaviour from the task>: <how the implementer can check it locally>

## Risks
- <likely mistake and how to avoid it>
```
