# Upstream Discord discussion drafts

These are the exact discussion starters prepared for upstream maintainers, not implementation claims. Counts are Unicode code-point counts of the exact text inside each `text` block, with each newline counted as one character; every message is below Discord's 2,000-character limit.

## Publication fallback status

The Discord invite failed for the browser account. No credential extraction was attempted. Upstream's public Ideas Discussions were therefore used as the suggestion box, preserving the drafts below:

| ID | Status | Public discussion |
| --- | --- | --- |
| D2 | Published in Ideas | [#10009](https://github.com/Hunter-124/chudcode/discussions/10009) |
| D3 | Published in Ideas | [#10010](https://github.com/Hunter-124/chudcode/discussions/10010) |
| D4 | Published in Ideas | [#10011](https://github.com/Hunter-124/chudcode/discussions/10011) |
| D5 | Published in Ideas | [#10012](https://github.com/Hunter-124/chudcode/discussions/10012) |
| D1 | Published in Ideas | [#10013](https://github.com/Hunter-124/chudcode/discussions/10013) |
| D6 | Published in Ideas | [#10014](https://github.com/Hunter-124/chudcode/discussions/10014) |
| D7 | Published in Ideas | [#10015](https://github.com/Hunter-124/chudcode/discussions/10015) |

## Recommended order and independence

| Order | ID | Topic | Characters | Can post independently? |
| ---: | --- | --- | ---: | --- |
| 1 | D2 | Durable agent communication | 1,298 | Yes; recommended first because D3 needs its persistence decision. |
| 2 | D3 | `/tree` execution DAG and recovery boundary | 1,598 | No: post after, or in the same discussion as, D2. |
| 3 | D4 | Model/role settings and provenance | 1,332 | Yes. |
| 4 | D5 | Snapcompact archive policy and defaults | 1,415 | Yes. |
| 5 | D1 | Terminal-first and accessible GUI/client direction | 1,529 | Yes; intentionally broad, so post after the more concrete requests. |
| 6 | D6 | Per-session desktop/display targets | 1,344 | Yes. |
| 7 | D7 | Opt-in staged automatic updates | 1,200 | Yes. |

D2 and D3 are the only ordered pair. The other messages should be separate threads so a decision on one does not imply approval of the others.

## D1 — Terminal-first plus an accessible GUI/client surface

**Character count: 1,529**

```text
Product direction: terminal-first plus an accessible GUI/client surface

After heavy daily use, several problems cluster at the client layer rather than agent logic: unreliable mouse selection/routing, copied border/newline artifacts, symbol-only status that is difficult to discover or read accessibly, crowded settings/status surfaces, and prompt attachments rendered as labels instead of previews. Upstream already has the terminal client, mouse tracking in [#9920](https://github.com/Hunter-124/chudcode/issues/9920), image-capable TUI rendering and attachment discussion in [#9931](https://github.com/Hunter-124/chudcode/issues/9931), a `session_name` segment, usage in the `full`/`nerd` presets, and a Basic/Advanced settings tier. The tier and usage discoverability have landed, so I am not asking to rebuild them.

Would upstream welcome an optional GUI/web client over the same session/event model while keeping the terminal first-class, or should non-terminal clients remain out of scope? If welcome, what is the smallest first slice: accessible transcript/composer selection and copy, settings/status parity, or attachment previews? Which client boundary is intended to be stable? What accessibility baseline should be required (keyboard-only operation, screen-reader names, focus order, contrast, reduced motion)? For the terminal status bar specifically, should an optional preset show session title, resolved model, effort, and context used/limit, with agent counts owned by the subagent view rather than the default bar?
```

## D2 — Durable agent communication

**Character count: 1,298**

```text
Product direction: durable agent communication without replacing `hub`

In long multi-agent runs, the current point-to-point flow is useful while the process is alive, but messages expire with the in-process bus. After a restart there is no durable conversation record; agents cannot subscribe to a topic, coordinate through shared state, exchange typed requests/replies, or address agents in another process. Upstream already has `hub`/IRC primitives for DM, broadcast, wait, inbox, roster, reply threading, and waking parked agents. The proposal is to extend that foundation, not build a second messenger.

Could maintainers choose the intended data model before implementation? Specifically: should messages be append-only session records, topic/channel logs, or both; how should channel membership and cross-process agent identity work; should structured payloads use a versioned envelope while preserving a prose body; and should a blackboard be a separate versioned key/value surface with compare-and-swap rather than mutable chat messages? What retention, size, redaction, and garbage-collection rules are acceptable? Should persistence be project-scoped, session-scoped, or explicitly selectable? A direction here would also define what a future execution DAG can safely show after restart.
```

## D3 — `/tree` execution DAG and recovery boundary

**Character count: 1,598**

```text
Product direction: turn `/tree` into an execution DAG and recovery surface

During heavy delegated runs, `/tree` does not make branching execution easy to follow: the main session, subagents, handoffs, messages, and artifacts are inspected through separate surfaces, and after a stall there is no obvious safe resume point. Upstream already records useful lineage (`parentId`, `SessionHeader.parentSession`, `AgentRef.parentId`) and exposes `history://` and `artifact://`. Related work covers a smaller live subagent preview ([#3815](https://github.com/Hunter-124/chudcode/issues/3815)), branch deletion ([#9933](https://github.com/Hunter-124/chudcode/issues/9933) / [PR #8301](https://github.com/Hunter-124/chudcode/pull/8301)), multi-session monitoring ([#1627](https://github.com/Hunter-124/chudcode/issues/1627)), and multiple live threads ([#8656](https://github.com/Hunter-124/chudcode/issues/8656)), but none defines this combined DAG.

Before implementation, what should a DAG node represent: session, agent run, turn, or tool span? Which edges are first-class: parent/child, delegation, message, artifact production, and resume? Should the UI show summarized activity/status rather than private chain-of-thought? Is v1 a read-only connected view, or may it resume, cancel, archive, or repair nodes? For recovery, should transcript diagnosis/repair remain a separate `doctor` command, with the DAG only linking to it, or should validated repair actions live in `/tree`? A restart-durable activity overlay depends on a decision for persisted agent communication, so I recommend settling that message first.
```

## D4 — Model/role settings with effective-value provenance

**Character count: 1,332**

```text
Product direction: model/role settings with effective-value provenance

In heavy use, `/agents` and `/models/roles` leave it unclear which model actually serves an agent, what role context was injected, and why a setting has its final value. Issue [#9932](https://github.com/Hunter-124/chudcode/issues/9932) tracks the visibility/UI problem; [#6514](https://github.com/Hunter-124/chudcode/issues/6514) shows that explicit orchestrator model selections can interact subtly with role resolution. Upstream already has role assignments and an `auto → provider/model` preview, but not a single effective-value explanation.

Could maintainers decide whether the right first step is an explain-only view or a new override system? For visibility, should each agent show resolved provider/model, role, injected context sources, and the provenance of each decision without merging the two screens? If overrides are wanted, is the intended precedence `global base → role → exact model → temporary session/request`, and are session overrides ephemeral by default? How should project settings participate? Should the UI expose both the winning value and shadowed sources? Should compaction become a user-assignable role in this same system, or remain a model-catalog hint? I am seeking the policy and UI boundary first, not claiming an implementation.
```

## D5 — Snapcompact archive policy and defaults

**Character count: 1,415**

```text
Product direction: Snapcompact archive policy and defaults

Under sustained use, Snapcompact is hard to reason about as one product: overflow compaction, experimental inline system-prompt/tool-result imaging, `/shake`, and archived bitmap frames have different triggers and preservation rules. Upstream already persists Snapcompact data with compaction summaries, uses a bounded middle-out frame eviction policy, offers experimental inline settings that default off, and can select Snapcompact in the context-overflow fallback strategies. Open PRs [#9997](https://github.com/Hunter-124/chudcode/pull/9997) and [#9998](https://github.com/Hunter-124/chudcode/pull/9998) address image-preservation bugs; they deliberately do not decide the product policy.

Could maintainers define whether overflow compaction and inline imaging should share one named policy or remain separate features? Which modes, if any, should be enabled by default? Should the archive budget and eviction order stay fixed or become configurable, and which content classes must never be discarded or rasterized? What audit record should users see: trigger, source span, tokens before/after, retained attachments, archive frames, and restore/export availability? If defaults change, what migration should preserve existing sessions and explicit user choices? This is a request for policy before code, especially around data retention and recoverability.
```

## D6 — Per-session desktop/display targets

**Character count: 1,344**

```text
Product direction: explicit per-session desktop/display targets

When several agents use desktop automation, process-wide display environment variables force them onto one seat, so agents can interfere with each other or with the user. Upstream already has per-session computer supervision and a `display` option for choosing a monitor; that option is not a display-server selector. Issue [#9935](https://github.com/Hunter-124/chudcode/issues/9935) tracks separate Wayland capture/input gaps, while [#1627](https://github.com/Hunter-124/chudcode/issues/1627) and [#8656](https://github.com/Hunter-124/chudcode/issues/8656) concern monitoring or session multiplexing rather than seat isolation.

Would upstream accept an explicit per-session desktop target such as `display_server`, carried through session options to backend connection, instead of mutating process-global environment? Should this be X11-specific initially or a backend-neutral target that can later name Wayland/Windows/macOS sessions? Who should own creation versus connection, teardown, stale-seat cleanup, and child-process reaping? Should isolated seats be described strictly as interaction isolation—not a security sandbox—and what capability disclosure should users see? I am asking for the public contract and lifecycle boundary before any native or multi-package implementation.
```

## D7 — Opt-in staged automatic updates

**Character count: 1,200**

```text
Product direction: opt-in staged automatic updates

In frequent use, the startup notifier reports a new version but still requires a separate manual update, even though upstream already has a self-update command. Related issues discuss wrapper/binary path ambiguity ([#1184](https://github.com/Hunter-124/chudcode/issues/1184)) and in-session update UX ([#2712](https://github.com/Hunter-124/chudcode/issues/2712)). The product decision is security-sensitive, so I am asking before proposing code.

Would maintainers accept `off | notify | auto` startup policy with `notify` preserving today’s default? Should `auto` only stage a verified update for the next launch—never hot-swap a running session? Which install types may participate: release binaries, package-manager installs delegated to that manager, and/or source checkouts? What integrity source is required for release assets, and must failure always fall back to notification/manual update? Should checks be throttled, and if so at what scope? Finally, what rollback or startup-failure behavior is required after a staged update? A decision on these boundaries would keep update convenience from silently changing trust or installation semantics.
```

## Discord-first audit-row coverage

Every row that any mandatory audit classified as `discord_first` is mapped below. Duplicate rows from separate audits intentionally point to the same message rather than duplicating the pain point.

| Audit row | Tracker row | Message | Mapping note |
| --- | --- | --- | --- |
| `TuiPainAudit` P1-4 — `/agents` vs `/models/roles` | MODEL-001 | D4 | Includes the narrower resolved-model view and the broader override/provenance decision. |
| `TuiPainAudit` P1-5b — status-bar redesign | TUI-005 | D1 | Asks only for terminal preset/product ownership; does not reopen the fixed duplicate-count bug or usage-preset work. |
| `TuiPainAudit` P1-6 — `/tree` DAG | AGENT-002 | D3 | D2 is the persistence prerequisite. |
| `TuiPainAudit` P1-7b — Basic/Advanced settings | SET-005 | D1 | Preserves the later retraction: the tier landed upstream, so D1 cites it as substrate and explicitly does not request it again. |
| `CostCompactionAudit` pain point 11 — resolved model/precedence | MODEL-001 | D4 | Same product decision as TUI P1-4; preserves #9932 and #6514. |
| `CostCompactionAudit` pain point 12 — global→role→model→session overrides with provenance | MODEL-001 | D4 | D4 asks maintainers to choose explain-only versus a new cascade before code. |
| `AgentGuiPainAudit` row 2 — `/tree` DAG | AGENT-002 | D3 | Same DAG request; adjacent issues/PR remain linked. |
| `AgentGuiPainAudit` row 3 — durable comms/topics/blackboard/cross-process | AGENT-003 | D2 | Extends, rather than replaces, existing `hub`/IRC. |
| `AgentGuiPainAudit` row 9, Option B — per-session `display_server` | DESK-003 | D6 | Option A was private operational tooling and is not exposed here. |
| `AgentGuiPainAudit` row 10 — auto-update | UPDATE-001 | D7 | No held branch or pre-implemented behavior is claimed; D7 asks for policy first. |

## Required cross-cutting groups that are not Discord-first audit rows

- **Snapcompact archive/policy/default redesign:** D5 maps to COMP-004, the direct-assignment `discord_first` row for the cross-mode policy/default/archive/audit contract. The mandatory audits found no pre-existing canonical-doc row or open policy issue. COMP-001/[PR #9997](https://github.com/Hunter-124/chudcode/pull/9997) and COMP-002/[PR #9998](https://github.com/Hunter-124/chudcode/pull/9998) are image-preservation fixes, not policy proposals; D5 says so rather than implying they implement a redesign.
- **Broader session repair:** SESSION-003 is a GitHub-appropriate `doctor`/repair enhancement, not Discord-first by itself. D3 asks only whether maintainers want it coupled to the new DAG. If the answer is no, keep SESSION-003 as its own issue draft and do not post a separate Discord message.
- **GUI direction:** PRIV-003 was classified private-only because the audited GUI implementation evidence belongs to a separate private product. D1 discloses none of that material and makes no upstream implementation claim; it is a neutral upstream scope/accessibility question. TUI-008/[#9920](https://github.com/Hunter-124/chudcode/issues/9920) and attachment issue [#9931](https://github.com/Hunter-124/chudcode/issues/9931) are linked only as public substrate.
- **Compaction role:** the audit considered a user-assignable compaction role additive and likely GitHub-appropriate. D4 asks whether maintainers instead want it designed as part of MODEL-001; it does not claim that role exists.
