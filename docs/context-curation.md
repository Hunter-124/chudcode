# Context curation in Chudcode

## Decision

Chudcode keeps Mnemo as its local durable-memory engine. It does not add Letta, Graphiti/Zep, Mem0, or LangGraph as another backend.

The 2026 source audit found no external engine with a measurable benefit that justifies replacing Mnemo's in-process TypeScript/SQLite design:

- Graphiti has the strongest external temporal model, but requires Neo4j, FalkorDB, or Neptune and its embedded Kuzu backend is deprecated. Mnemo already has equivalent `valid_from`/`valid_until`, `superseded_by`, conflicts, and as-of queries.
- Letta's old embeddable server is archived and unsupported; maintained `letta-code` is a competing full coding-agent harness, not a memory library.
- Mem0 OSS switched to additive-only automatic extraction in April 2026, so it no longer automatically updates or removes contradictions. Its useful append-only mutation-history pattern was adopted directly without its Qdrant/SQLAlchemy/server dependencies.
- LangGraph Store is a persistence primitive. Its documentation leaves update, deduplication, supersession, and temporal semantics to the application.

Mnemo remains MIT-licensed, local by default, and already owns the right integration seam: `MemoryBackend.preCompactionContext()`.

## Project context model

A project is represented as one evolving, bounded digest rather than an append-only task transcript.

`packages/coding-agent/src/mnemo/project-digest.ts` builds that digest from the canonical todo phases and active plan reference:

- pending, in-progress, and blocked work remains explicit;
- completed and abandoned work leaves the active set;
- only the five most recent terminal transitions remain for short-term causal continuity;
- older terminal items collapse into a count;
- the digest is capped at 12,000 characters and reports omitted open work rather than silently pretending it was complete;
- control characters are removed and XML is escaped before system-context injection.

The digest is stored as exactly one Mnemo working-memory row per project:

- `source = coding-agent-project-digest`;
- `memory_type = project_digest`;
- deterministic `project_key` metadata derived from the normalized project path;
- bank-scoped, `veracity = tool`, `importance = 0.9`;
- updated in place, never appended repeatedly.

Every successful mutating `todo` operation refreshes it. `beforeAgentStartPrompt()` refreshes it before the first turn, and `preCompactionContext()` refreshes it at the point where transcript content is about to shrink. Mnemo injects the digest as explicitly untrusted background data, followed by ordinary recalled memories.

The automatic mutation gate is intentionally narrow: Chudcode updates only a row whose source, memory type, and project key all match its own managed digest contract. A conflicting user-authored row produces `review_required` and remains untouched.

## Durable mutation history

Mnemo now creates `memory_history`, an append-only audit table for `update` and soft `invalidate` events.

Each event records:

- a stable unique event ID;
- memory ID and working/episodic store;
- event type and optional replacement ID;
- old/new importance;
- actor, session, and timestamp;
- SHA-256 of full old/new content;
- only the first 512 characters of each content version, bounding ledger growth.

`Mnemo.history(id)` and `BeamMemory.history(id)` return newest-first events. `memory://<id>` reports the event count and renders the latest 20 events with hashes and previews. Export/import includes the ledger and deduplicates by event ID.

Hard `forget` remains a privacy boundary: it deletes the working row and every linked mutation-history/validation row. The append-only ledger does not defeat an explicit permanent deletion.

## Repository artifact audit

Run the dry-run audit from a project root:

```bash
chudcode context
chudcode context --json
chudcode context --root /path/to/project
```

It scans Git-visible documentation/plan artifacts only: `docs/`, root plan/decision/todo/roadmap/meeting/notes files, and `.chudcode/context/generated/`. Files larger than 2 MiB and unsupported extensions are ignored.

The confidence policy is fixed:

| Evidence | Action | Confidence | Automatic with `--apply` |
|---|---:|---:|---:|
| Terminal Chudcode-managed artifact under `.chudcode/context/generated/`, marker body hash matches, zero references | remove | 100% | yes |
| Explicit `superseded`, `archived`, or `obsolete` status and zero references | archive suggestion | 95% | no |
| Exact duplicate bytes and zero references | deduplicate suggestion | 90% | no |
| Managed hash mismatch or any discovered reference | review | 0% | no |
| Everything else | keep | 100% | no mutation |

`--apply` deletes only the first row in that table. It rereads the file immediately before unlinking and rechecks the terminal marker and body hash. User-authored docs, referenced artifacts, archive suggestions, and duplicates are never automatically deleted.

Managed generated artifacts use this marker:

```text
<!-- chudcode-managed-artifact:v1 sha256:<sha256-of-content-after-removing-this-marker> terminal:true|false -->
```

The marker is not a blanket deletion grant. Location, terminal state, exact hash, and zero-reference evidence must all agree.

## Transcript compaction policy

The full and incremental compaction prompts now treat context as a current projection:

- current goals, constraints, open work, blockers, and next steps remain detailed;
- routine completed steps collapse into the durable outcome they established;
- resolved blockers, dropped ideas, obsolete instructions, and stale intermediate state are removed;
- completed work survives only when it changed project state or prevents a repeated mistake;
- corrected facts replace old ones unless the transition itself matters.

This keeps token-budget compaction distinct from durable memory: compaction decides what the next model needs now; Mnemo decides what survives across sessions.

## Verification

Focused contracts:

```bash
bun test \
  packages/coding-agent/test/context-artifact-audit.test.ts \
  packages/coding-agent/test/mnemo-project-digest.test.ts \
  packages/coding-agent/test/tools/todo.test.ts \
  packages/coding-agent/test/memory-tools.test.ts \
  packages/coding-agent/test/internal-urls/memory-protocol.test.ts \
  packages/coding-agent/test/cli-command-metadata.test.ts

bun test \
  packages/mnemo/test/beam-store.test.ts \
  packages/mnemo/test/memory-facade.test.ts

bun test \
  packages/agent/test/compaction-boundary.test.ts \
  packages/agent/test/compaction-file-ops.test.ts \
  packages/agent/test/compaction-summary-cap.test.ts

bun run --cwd=packages/coding-agent check:types
bun run --cwd=packages/mnemo check
bun run --cwd=packages/agent check:types
```

Behavior smoke:

```bash
bun packages/coding-agent/src/cli.ts context --root /path/to/project
```

The initial Chudcode repository smoke scanned 167 artifacts, removed nothing, and surfaced one 90%-confidence duplicate suggestion for human review. That is the intended fail-closed behavior.

## Follow-up boundaries

The next valuable work is UI, not another engine:

- show the current digest and `review_required` conflicts in the session/project UI;
- add a deliberate review action for 95% archive suggestions;
- expose mutation history in the memory inspector;
- measure digest token savings and stale-context regressions before tuning the 12,000-character/five-transition defaults.

Do not add automatic deletion for ordinary repository docs. Expand the managed marker contract only with a new version and equivalent hash/reference tests.
