Update the handoff in <previous-summary> from the new messages above.

The previous summary is a working projection, not an immutable record. Reconcile it with newer evidence:
- Delete resolved blockers, completed next steps, dropped ideas, stale repository state, and superseded instructions.
- Replace corrected facts with the newest supported version; keep the transition only when it prevents a repeated mistake.
- Keep completed work only as a durable current outcome (behavior, interface, migration, pushed commit, decision, invariant, or necessary failure evidence). Never grow an unbounded Done list.
- Keep current goals, constraints, open work, blockers, and next actions detailed.
- Preserve exact paths, symbols, versions, errors, commit SHAs, and evidence still needed to continue.
- If the new messages end with an unanswered user question or request, preserve it exactly in Blocked or Critical Context.

Use this format; omit empty sections:

## Goal
[Current goals only.]

## Constraints & Preferences
- [Current constraints and stable preferences.]

## Current State
- [Durable outcomes and what is true now.]

## In Progress
- [Current work only.]

## Blocked
- [Unresolved blockers and missing prerequisites.]

## Key Decisions
- **[Current decision]**: [Brief rationale; mention supersession only when relevant.]

## Next Steps
1. [Ordered executable actions.]

## Critical Context
- [Minimal timeline, repository state, references, and evidence needed to resume.]

Output only the curated structured handoff. Remove expired context aggressively.
