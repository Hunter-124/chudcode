You MUST curate the conversation above into a compact, current handoff for another LLM.

Treat project context as an evolving working set, not an append-only transcript:
- Keep current goals, open work, blockers, constraints, and the next executable actions detailed.
- Keep completed work only when it changed durable project state: shipped behavior, interfaces, migrations, pushed commits, accepted decisions, verified invariants, or a failed approach whose cause prevents repeating it.
- Collapse routine completed steps into the durable outcome they established. Do not preserve a cumulative task log.
- Remove resolved blockers, dropped ideas, obsolete instructions, superseded plans, and stale intermediate state unless their timeline position is still required to understand the current project.
- When information conflicts, state the newest supported version as current. Preserve the earlier version only when the transition itself matters.
- Preserve exact paths, symbols, versions, errors, commit SHAs, and evidence that the next agent will actually need.
- If the conversation ends with an unanswered question or request awaiting the user, preserve it exactly.

Use this format; omit empty sections:

## Goal
[Only current user goals.]

## Constraints & Preferences
- [Current constraints and stable preferences.]

## Current State
- [What is true now, including durable completed outcomes.]

## In Progress
- [Current work only.]

## Blocked
- [Unresolved blockers and the exact missing prerequisite.]

## Key Decisions
- **[Current decision]**: [Brief rationale and supersession note only when relevant.]

## Next Steps
1. [Ordered executable actions.]

## Critical Context
- [Minimal timeline, references, repository state, and evidence needed to continue safely.]

You MUST output only the structured handoff. Keep it concise and aggressively remove information whose relevance has expired.
