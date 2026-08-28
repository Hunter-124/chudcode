# Upstream coverage tracker

This is the flat, canonical tracker for the 2026-08-27 fork audits. A stable ID names one normalized request; repeated mentions in the source documents and audit inventories map back to that ID in the completeness appendix. “Public-safe” means the row can be discussed upstream without disclosing private CAD or CloudCastle implementation details. Major features remain Discord-first.

## Classification summary

| Classification | Meaning | Count |
| --- | --- | ---: |
| `existing_issue` | An upstream issue already owns the request; includes rows where only part has landed. | 21 |
| `existing_discussion` | An upstream Ideas discussion now owns a major-feature proposal. | 7 |
| `open_pr` | A public upstream PR is open. | 5 |
| `direct_pr_ready` | A narrow implementation exists in the fork and can be proposed without a new issue. | 3 |
| `fixed_upstream` | Current upstream source or a named commit resolves the request. | 11 |
| `working_as_designed` | Current behavior already supplies the requested capability. | 1 |
| `discord_first` | Major feature or policy change still awaiting an upstream design discussion. | 1 |
| `missing_enhancement` | Public-safe gap with enough evidence for an issue draft. | 0 |
| `evidence_blocked` | Do not file until the named measurement, reproduction, or crash evidence exists. | 2 |
| `duplicate` | Audited wording is already wholly owned by another canonical row or issue. | 2 |
| `retracted` | No supported upstream gap remains; explicitly withdrawn after current-source review. | 4 |
| `self_downgraded` | Hunter explicitly judged the item cosmetic or zero-impact. | 2 |
| `private_only` | Local operations or private downstream product work; never put its internals in a public draft. | 5 |
| **Total** | **Canonical rows** | **64** |

## Flat coverage table

| Stable ID | Category | Normalized request | Source | Classification | Upstream issue / PR / commit | Evidence status | Next action | Public / private safety |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `TUI-001` | Editor | Add discoverable redo while preserving terminal-safe undo/suspend bindings. | `REQUIREMENTS.md:24-26`; `HANDOFF.md:75`; `PR-BODIES.md:36-68` | `open_pr` | [PR #9925](https://github.com/can1357/oh-my-pi/pull/9925) | Current-main rebase; four review rounds addressed; full TUI/Rust results recorded by the audit. | Track merge; do not file another issue. | Public-safe. |
| `TUI-002` | Drafts | Persist prompt text and pasted-image bytes atomically during editing, not only at clean teardown. | `REQUIREMENTS.md:24-28`; `HANDOFF.md:76` | `direct_pr_ready` | None; fork branch `fix/pending-image-reconcile` | SIGKILL/resume was exercised; image reconciliation and atomic autosave exist in the fork. SIGINT semantics are separated into `TUI-003`. | Rebase and submit the narrow fix; state only the proven SIGKILL/crash behavior. | Public-safe if no private session contents are included. |
| `TUI-003` | Drafts | “Ctrl+C loses the draft” as a distinct bug. | Current-conversation audit scope; nearest source `REQUIREMENTS.md:24-28`, `HANDOFF.md:76` | `duplicate` | Covered conditionally by `TUI-002` | Unconfirmed: the recorded exercise used SIGKILL, not SIGINT; graceful shutdown may differ. | Reproduce on current main. If it fails, add evidence to `TUI-002`; otherwise retract this wording. | Public-safe, but do not file an unverified claim. |
| `SESSION-001` | Sessions | Preserve recoverable transcripts when a session header is corrupt. | `REQUIREMENTS.md:29-33`; `HANDOFF.md:11-29`; issue list | `fixed_upstream` | [Issue #9915](https://github.com/can1357/oh-my-pi/issues/9915) | Hunter closed it after current-main review; changelog records the fix. | No action; do not re-file. | Public-safe. |
| `SESSION-002` | Compaction visibility | Record and render before/after token counts so compaction is auditable. | `REQUIREMENTS.md:29-33`; `HANDOFF.md:11-29` | `fixed_upstream` | [Issue #9921](https://github.com/can1357/oh-my-pi/issues/9921) | `tokensAfter` exists and UI renders “Compacted from X to Y”; Hunter closed the stale issue. | No action. | Public-safe. |
| `SESSION-003` | Session recovery | Add a user-invocable session doctor/repair command for transcript diagnosis and recovery. | `HANDOFF.md:101-104`; residual of `REQUIREMENTS.md:29-33` | `existing_issue` | [Issue #10006](https://github.com/can1357/oh-my-pi/issues/10006) | Current source repairs orphaned tool pairs at the wire layer but has no user-facing doctor; `/tree` is the only recovery surface. The evidence-backed draft is now filed upstream. | Track triage and discussion on #10006; keep scope diagnostic/recovery and single-package. | Public-safe. |
| `MEM-001` | Memory | Add memory-aware subagent admission and an upstream policy for idle embed-worker residency. | `REQUIREMENTS.md:34-37`; `CRASH-MITIGATIONS.md:18-35,85-100`; `HANDOFF.md:233-251` | `existing_issue` | [Issue #9908](https://github.com/can1357/oh-my-pi/issues/9908); duplicate [#9916](https://github.com/can1357/oh-my-pi/issues/9916) closed | Measured RSS/swap and count-only semaphore mechanism; maintainer design questions remain. Explicitly not reported as a leak. | Continue on #9908; never revive duplicate #9916. | Public-safe after removing host-identifying process details not needed for the mechanism. |
| `AGENT-001` | Agent/model UI | Show the resolved model and injected role context for each agent; clarify `/agents` versus `/models/roles` precedence. | `REQUIREMENTS.md:41-45`; `HANDOFF.md:94-103`; `ONBOARDING.md:190-201` | `existing_issue` | [Issue #9932](https://github.com/can1357/oh-my-pi/issues/9932); adjacent [#6514](https://github.com/can1357/oh-my-pi/issues/6514) | Current model hub has assignment arrows, not a resolved-per-agent explanation. | Keep #9932 as owner; Discord before implementation. | Public-safe. |
| `TUI-004` | Status line | Stop counting task subagents in both the agent badge and background-job badge. | `REQUIREMENTS.md:46-50`; `HANDOFF.md:78`; `PR-BODIES.md:106-131` | `open_pr` | [PR #9927](https://github.com/can1357/oh-my-pi/pull/9927) | Exact `agentId` dedup replaces heuristics; review feedback and targeted tests addressed. | Track merge. | Public-safe. |
| `TUI-005` | Status line | Redesign the preset around session title, model, effort, context/limit, and move agent count to the subagent surface. | `REQUIREMENTS.md:46-50`; `HANDOFF.md:99-100` | `existing_discussion` | [Ideas discussion #10013](https://github.com/can1357/oh-my-pi/discussions/10013) | `session_name` already renders, so this is primarily layout/accessibility/product policy rather than a missing primitive. The proposal is now upstream after Discord access failed. | Continue design discussion on #10013; do not open a duplicate issue. | Public-safe. |
| `TUI-006` | Status line | Put the existing `usage` segment in shipped presets. | `REQUIREMENTS.md:111-114`; `HANDOFF.md:86,99`; `ONBOARDING.md:210-212` | `fixed_upstream` | [Issue #9929](https://github.com/can1357/oh-my-pi/issues/9929); [PR #9983](https://github.com/can1357/oh-my-pi/pull/9983) | Current Unreleased source/changelog includes usage in `full` and `nerd`; the open-PR snapshot is stale bookkeeping. | Do not duplicate; reconcile/close the stale PR/issue state upstream. | Public-safe. |
| `TUI-007` | Status line | Add an animated, lifecycle-owned usage/limit gauge. | `REQUIREMENTS.md:111-114`; `HANDOFF.md:99`; `ONBOARDING.md:210-212` | `existing_issue` | [Issue #10007](https://github.com/can1357/oh-my-pi/issues/10007); context comment on [#9929](https://github.com/can1357/oh-my-pi/issues/9929#issuecomment-5437026621) | Filed with the known design constraint: repaint through interactive mode/`RenderScheduler`, never a timer inside segment render. | Track triage on #10007; do not duplicate it or expand #9929. | Public-safe. |
| `AGENT-002` | Execution graph | Turn `/tree` into a connected execution DAG with main/subagent lineage, activity, communication, artifacts, and recovery affordances. | `REQUIREMENTS.md:51-56`; `HANDOFF.md:94`; `ONBOARDING.md:190-201` | `existing_discussion` | [Ideas discussion #10010](https://github.com/can1357/oh-my-pi/discussions/10010); adjacent, not duplicate: [#3815](https://github.com/can1357/oh-my-pi/issues/3815), [#9933](https://github.com/can1357/oh-my-pi/issues/9933), [#1627](https://github.com/can1357/oh-my-pi/issues/1627), [#8656](https://github.com/can1357/oh-my-pi/issues/8656) | Parent/lineage data exists; TUI edges and durable communication do not. Existing issues cover smaller/different scopes. | Continue product/design discussion on #10010; sequence after durable comms decisions. | Public-safe; never include private CAD implementation details. |
| `SET-001` | Settings/platform | Do not show an inert macOS-only sleep-prevention control on Linux/Windows. | `REQUIREMENTS.md:57-59`; `HANDOFF.md:58,84`; `ONBOARDING.md:173-188` | `existing_issue` | [Issue #9923](https://github.com/can1357/oh-my-pi/issues/9923) | Still valid on current main; maintainer must choose hide-on-non-macOS versus real cross-platform support. | Resolve the choice on #9923; implementation coverage is `SET-007`. | Public-safe. |
| `SET-002` | Settings/schema | Prevent dangling settings visibility-condition names. | `REQUIREMENTS.md:57-59`; `HANDOFF.md:58` | `fixed_upstream` | [Issue #9923](https://github.com/can1357/oh-my-pi/issues/9923) | Hunter retracted the stale finding after 1:1 schema review; Unreleased adds a schema guard. | Comment/close this sub-finding; no new issue. | Public-safe. |
| `SET-003` | Settings/providers | Remove dead Exa toggles from the settings surface. | `REQUIREMENTS.md:57-59`; #9923 correction thread | `fixed_upstream` | [Issue #9923](https://github.com/can1357/oh-my-pi/issues/9923) | Removed on current upstream; original report explicitly corrected. | Keep marked retracted within #9923; no new work. | Public-safe. |
| `PLAT-001` | Linux integration | Add a Linux-specific clipboard-image backend and credential-helper mechanism. | #9923 “Related” section; AgentGuiPainAudit item 7 | `retracted` | None | Current `arboard` integration already selects X11/Wayland, and the `!<shell command>` config escape hatch already provides a platform-neutral credential-helper path. | No action; do not file. | Public-safe; never publish helper commands containing secrets. |
| `SET-004` | Settings/isolation | Filter `task.isolation.mode` choices by platform. | `REQUIREMENTS.md:57-59`; #9923 correction thread | `self_downgraded` | [Issue #9923](https://github.com/can1357/oh-my-pi/issues/9923) | Hunter concluded documented `auto` makes cross-platform values informative and the concern cosmetic. | No action; do not spend upstream time. | Public-safe. |
| `SET-005` | Settings/navigation | Provide a Basic tier and searchable Advanced catalog. | `REQUIREMENTS.md:57-59`; `ONBOARDING.md:185-188` | `fixed_upstream` | None | Current Unreleased changelog/source has Basic flat navigation, Advanced full catalog, and path-aware search. | No issue or Discord draft. | Public-safe. |
| `TUI-008` | Mouse/input | Add coherent mouse routing/hit testing, overlay event parsing, role-list scrolling, and click-to-caret. | `REQUIREMENTS.md:60-61`; `HANDOFF.md:56`; audit of current source | `existing_issue` | [Issue #9920](https://github.com/can1357/oh-my-pi/issues/9920) | Issue contains concrete dead/drop paths and a broader routing design; evidence is sufficient. | Keep #9920 as the owner; narrow bug fixes may land separately. | Public-safe. |
| `TUI-009` | Selection | Allow users to retain terminal-native text selection when mouse tracking is active. | #9920 body; current-conversation audit scope | `duplicate` | [Issue #9920](https://github.com/can1357/oh-my-pi/issues/9920) | Fully covered as #9920 suggested-direction item 4; not a separate complaint. | Do not file separately. | Public-safe. |
| `PRIV-001` | Private GUI/copy | Preserve hard line breaks while removing soft-wrap copy artifacts in the private ImGui composer. | `IMGUI-UI-STANDARDS.md:182-198`; current-conversation “copy artifacts” audit label | `private_only` | None | Source is a private downstream GUI standard, not an oh-my-pi TUI bug. | Keep in the private GUI workstream; do not upstream CAD code or internals. | Private-only. Public drafts may state only a generic copy invariant. |
| `ATTACH-001` | Attachments | Render pasted-image prompt chips with a real terminal image component. | `REQUIREMENTS.md:62-64`; `HANDOFF.md:97`; `ONBOARDING.md:203-212` | `existing_issue` | [Issue #9931](https://github.com/can1357/oh-my-pi/issues/9931) | Working assistant image path and string-only prompt-chip blocker are both cited. | Continue on #9931; no duplicate issue. | Public-safe. |
| `ATTACH-002` | Attachments | Reconcile image markers so deleting/re-pasting renumbers and un-attaches correctly. | `REQUIREMENTS.md:64-65`; `HANDOFF.md:54`; `PR-BODIES.md:210-235` | `fixed_upstream` | [Issue #9917](https://github.com/can1357/oh-my-pi/issues/9917); commit [`091ab3887e0`](https://github.com/can1357/oh-my-pi/commit/091ab3887e0) | Hunter reproduced only on stale v17.0.8, verified current main, and closed; first shipped in v17.4.2. | No action; do not re-file. | Public-safe. |
| `ATTACH-003` | Attachments | Convert pasted document paths through `markit`; leave folders as paths unless a directory contract is designed. | `REQUIREMENTS.md:65-67`; `HANDOFF.md:98` | `existing_issue` | [Issue #9931](https://github.com/can1357/oh-my-pi/issues/9931) | Document path category and callback are scoped; directory conversion is intentionally not claimed. | Continue on #9931. | Public-safe. |
| `UPDATE-001` | Updates | Add opt-in, verified update staging that applies on next launch. | `REQUIREMENTS.md:71-75`; `HANDOFF.md:80`; `PR-BODIES.md:166-208` | `existing_discussion` | [Ideas discussion #10015](https://github.com/can1357/oh-my-pi/discussions/10015); fork branch `feat/opt-in-auto-update` | Fork implementation is exercised, throttled, digest-verified, fail-closed, and excludes source/link checkouts. The security-sensitive proposal is now upstream. | Continue design review on #10015 before opening a PR. | Public-safe; update integrity/security details must remain exact. |
| `MODEL-002` | Model catalog | Filter/hide catalog models by release date. | `REQUIREMENTS.md:76-77,118-119`; `HANDOFF.md:82` | `existing_issue` | [Issue #9934](https://github.com/can1357/oh-my-pi/issues/9934) | Fork branch adds `releaseDate` and recency predicate; upstream issue/branch also owns Cursor metadata. | Submit the prepared branch against #9934. | Public-safe. |
| `AUTH-001` | Credentials | Prune or revalidate long-disabled credentials and make user logout a real deletion policy. | `REQUIREMENTS.md:78-80`; `HANDOFF.md:55` | `existing_issue` | [Issue #9918](https://github.com/can1357/oh-my-pi/issues/9918) | Tombstone visibility/re-login hints landed, but no TTL sweep, prune, or hard-delete-on-logout policy landed. | Update #9918 with the partial landing; keep the core issue open. | Public-safe; never include credential values or identities. |
| `AGENT-003` | Agent communication | Persist hub messages and add topics/channels, shared blackboard, structured payloads, and cross-process delivery. | `REQUIREMENTS.md:81-88`; `HANDOFF.md:95`; `ONBOARDING.md:190-201` | `existing_discussion` | [Ideas discussion #10009](https://github.com/can1357/oh-my-pi/discussions/10009) | Existing hub already handles DM/broadcast/wait/inbox/roster/threading/wake; the listed durable/many-to-many capabilities are genuinely absent. The proposal is now upstream. | Continue scope/design discussion on #10009; do not rebuild or duplicate hub basics. | Public-safe; examples must not disclose private project messages. |
| `AUTH-002` | OAuth UI | Replace the nonfunctional OAuth “Close Window” control with an honest fallback. | `REQUIREMENTS.md:89-91`; `HANDOFF.md:77`; `PR-BODIES.md:72-102` | `open_pr` | [PR #9926](https://github.com/can1357/oh-my-pi/pull/9926) | Browser mechanism reproduced; all review rounds addressed; targeted tests recorded. | Track merge. | Public-safe. |
| `AUTH-003` | Windows/OAuth | Diagnose crashes immediately before/after Windows OAuth login. | `REQUIREMENTS.md:91-93`; `HANDOFF.md:261-269`; `CRASH-MITIGATIONS.md:101-102` | `evidence_blocked` | None | No stack trace, terminal log, or affected-machine reproduction exists; searched near-matches have different symptoms. | Capture terminal output, timing relative to login success, build/version, and stack/crash log before filing. | Public-safe only after redacting tokens, account identity, and private paths. |
| `AUTH-004` | Windows/OAuth | Avoid silent random-port fallback and token-exchange 403 when port 1455 is occupied. | `HANDOFF.md:266-269` | `fixed_upstream` | Upstream changelog entry cited by the handoff | Previously fixed; retained only as a diagnostic lead for `AUTH-003`. | No issue; verify only if diagnosing a new crash. | Public-safe. |
| `DESK-001` | Computer/Wayland | Ship functional Wayland capture/window enumeration and accurately report foreground/background input capability. | `REQUIREMENTS.md:94-100`; `HANDOFF.md:117-180`; `ONBOARDING.md:262-284` | `existing_issue` | [Issue #9935](https://github.com/can1357/oh-my-pi/issues/9935); adjacent fixed [#7884](https://github.com/can1357/oh-my-pi/issues/7884) | Same host A/B: X11 has capabilities, Wayland lacks them; compile flag and hardcoded capability root-caused. | Continue on #9935; do not conflate #7884’s grant-lifetime bug. | Public-safe after omitting host-specific account/session details. |
| `DESK-002` | Computer/seat isolation | Provide a local nested-X11 `omp-seat` wrapper as a usable non-security isolation workaround. | `HANDOFF.md:117-212`; `REQUIREMENTS.md:94-100` | `private_only` | None | End-to-end local proof reports X11 capture/input/AX/background input and clean teardown. No upstream code is required. | Maintain as local operational tooling; do not file upstream. | Private operational details stay private; only the generic workaround may be discussed. |
| `DESK-003` | Computer/seat isolation | Add explicit per-session display targets so in-process subagents can own separate seats. | `HANDOFF.md:117-180,211-212`; `ONBOARDING.md:173-188` | `existing_discussion` | [Ideas discussion #10014](https://github.com/can1357/oh-my-pi/discussions/10014) | Native/session-core plumbing is absent; nearby issues cover dashboards or focus multiplexing, not display selection. The proposal is now upstream. | Continue interface/design discussion on #10014 before implementation. | Public-safe at the interface level; omit private environment topology. |
| `COST-001` | Cache/cost | Report cache hit rate, token classes, miss attribution, price coverage, savings, retention/TTL, and idle time. | `REQUIREMENTS.md:101-105`; `HANDOFF.md:101-102`; current-conversation audit scope | `fixed_upstream` | Related [Issue #9930](https://github.com/can1357/oh-my-pi/issues/9930) | Current Unreleased `/cache` and status metrics implement the requested honest report. | No new issue; note the landing on #9930. | Public-safe. |
| `COST-002` | Prompt caching | Configure provider-native cache retention consistently (`none`/`short`/`long`). | Current-conversation audit scope | `working_as_designed` | None | Audited providers already thread retention to native TTL parameters; cache reads and reasoning tokens are not double-priced. | No action. | Public-safe. |
| `COST-003` | Cost accuracy | Represent unknown model pricing explicitly and disclose “N of M priced.” | `REQUIREMENTS.md:101-105`; `HANDOFF.md:101-102` | `existing_issue` | [Issue #9930](https://github.com/can1357/oh-my-pi/issues/9930) | `pricingKnown` and price-coverage UI landed; the issue remains open for `COST-004`. | Comment on #9930 with the partial landing; do not open a duplicate. | Public-safe. |
| `COST-004` | Cost accuracy | Put token and dollar totals on the same basis, including cache-read accounting. | #9930 body/comment thread; current-conversation audit scope | `existing_issue` | [Issue #9930](https://github.com/can1357/oh-my-pi/issues/9930) | Audit did not confirm this third claim fixed; it remains the unresolved part of #9930. | Verify current `agent-hub-projection` behavior and update #9930, not a new issue. | Public-safe. |
| `COST-005` | Pricing automation | If model prices are auto-fetched, require source provenance and human confirmation before totals change. | `REQUIREMENTS.md:101-105`; `HANDOFF.md:102` | `discord_first` | Prerequisite/owner context [#9930](https://github.com/can1357/oh-my-pi/issues/9930) | Deliberately not built; wrong scraped data would silently corrupt future totals. Unknown-price representation now exists, but trust/policy remains. | Discuss policy on Discord before any implementation. | Public-safe; never present scraped values as authoritative without provenance. |
| `TUI-010` | Overlays | Add an opt-in one-Esc dismissal preference without breaking the intentional first-Esc search-clear contract. | `REQUIREMENTS.md:106-110`; `HANDOFF.md:83` | `direct_pr_ready` | None; fork branch `feat/opt-in-escape-dismiss` | Upstream test intentionally asserts two-step behavior; fork preserves default and makes preference opt-in. `/ssh` is not an overlay. | Submit the narrow opt-in PR; do not call existing behavior a bug. | Public-safe. |
| `MODEL-003` | Model catalog | Normalize Cursor effort variants and advertise reasoning capability correctly. | `REQUIREMENTS.md:115-119`; `HANDOFF.md:81` | `existing_issue` | [Issue #9934](https://github.com/can1357/oh-my-pi/issues/9934) | Current provider still bakes effort suffixes into IDs and reports `reasoning:false`; exercised fork branch exists. | Submit the prepared branch with `MODEL-002`. | Public-safe. |
| `AGENT-004` | Subagent labels | Sanitize model-emitted title markup at extraction/commit/render boundaries. | `HANDOFF.md:79`; `PR-BODIES.md:135-162` | `direct_pr_ready` | None; fork branch `fix/subagent-label-sanitize` | Real `</title>` leak reproduced; sanitizer preserves legitimate angle-bracket labels; focused tests recorded. | Submit the prepared PR; no issue required. | Public-safe; use synthetic labels, not private task names. |
| `OPS-001` | Temporary files | Clean up `os.tmpdir()` producers, close browser handles, and add bounded startup reaping/tmpfs awareness. | `HANDOFF.md:57`; `CRASH-MITIGATIONS.md:71-77` | `existing_issue` | [Issue #9922](https://github.com/can1357/oh-my-pi/issues/9922) | Eight producers and missing cleanup paths are cited; local weekly prune proves operational impact but is not the upstream fix. | Continue on #9922. | Public-safe after removing unrelated private scratch-directory names. |
| `OPS-002` | Windows portability | Replace hardcoded `/tmp/` paths with `os.tmpdir()`. | #9922 body; `HANDOFF.md:57` | `existing_issue` | [Issue #9922](https://github.com/can1357/oh-my-pi/issues/9922) | Two exact source paths are covered by #9922; no fork branch yet. | Offer a small standalone PR linked to #9922. | Public-safe. |
| `SET-006` | Configuration | Propagate config/model-role changes between running sessions without lost updates. | `HANDOFF.md:59`; requirements settings context | `existing_issue` | [Issue #9928](https://github.com/can1357/oh-my-pi/issues/9928) | Current `Settings` reads from in-memory merged state; no config mtime invalidation/watch exists; write locking already prevents lost updates. | Continue on #9928 using the existing mtime-invalidation precedent. | Public-safe. |
| `SET-007` | Power | Implement sleep prevention on Linux and Windows. | `REQUIREMENTS.md:57-59`; `HANDOFF.md:84`; `ONBOARDING.md:173-188` | `existing_issue` | [Issue #9027](https://github.com/can1357/oh-my-pi/issues/9027); related [#9923](https://github.com/can1357/oh-my-pi/issues/9923) | Fork implementation is live-proven with `systemd-inhibit`; Windows path exists; maintainer hide-vs-implement decision is pending. | Resolve policy on #9923/#9027, then submit the existing branch. | Public-safe. |
| `NOTIFY-001` | Notifications | Add a macOS notification fallback matching Linux desktop notification behavior. | #9923 “Related” aside; current-conversation audit scope | `existing_issue` | [Issue #10008](https://github.com/can1357/oh-my-pi/issues/10008) | Linux has a real fallback; no macOS `osascript` equivalent was found. The macOS-only evidence-backed draft is now filed upstream. | Track triage on #10008; keep Windows coverage on `NOTIFY-002`/#7272. | Public-safe. |
| `NOTIFY-002` | Notifications | Add a Windows toast fallback matching Linux desktop notification behavior. | #9923 “Related” aside; current-conversation audit scope | `existing_issue` | [Issue #7272](https://github.com/can1357/oh-my-pi/issues/7272) | Live duplicate search found the Windows half already explicitly covered upstream. | Continue on #7272; do not include Windows in a new notification issue. | Public-safe. |
| `OPS-003` | Host operations | Keep local `/tmp`, disk-backed scratch, prune timer, and zram mitigations distinct from upstream defects. | `REQUIREMENTS.md:147-150`; `HANDOFF.md:183-191`; `CRASH-MITIGATIONS.md:37-83` | `private_only` | Upstream actionable slice is [#9922](https://github.com/can1357/oh-my-pi/issues/9922) | Local changes are measured/applied; compiler and zram pressure were explicitly not omp defects. | Maintain locally; only upstream `OPS-001`/`OPS-002`. | Private host configuration; do not publish paths, process lists, or machine capacity unless necessary and approved. |
| `PERF-001` | Capability loading | Measure whether ~50 concurrent `node:fs` capability-provider loads contend on libuv before changing I/O. | `HANDOFF.md:233-251` | `evidence_blocked` | None | Fan-out and `node:fs` calls are current; user impact/performance regression is not measured. | Run the named timing benchmark and capture comparative numbers before filing. | Public-safe after measurement; no private provider names or paths. |
| `PERF-002` | Rendering | “Git runs on every render and stalls the status line.” | `HANDOFF.md:235-240` | `retracted` | None | Audit found TTL caches, in-flight dedup, and reftable routing; renders are event-driven. Original suspicion was wrong. | No action. | Public-safe. |
| `PERF-003` | Undo | “Undo `structuredClone` materially hurts editor performance.” | `HANDOFF.md:241-244` | `retracted` | None | Clone covers only bounded composer state and is grouped/capped; concern is negligible outside pathological pastes. | No action. | Public-safe. |
| `PERF-004` | Dead code | Remove a dead footer path that could reintroduce synchronous git resolution if instantiated. | `HANDOFF.md:253-259` | `self_downgraded` | None | Exported but never instantiated; zero current user impact. Hunter chose not to file a thirteenth issue. | Delete opportunistically in an owning refactor; no standalone issue. | Public-safe. |
| `COMP-001` | Snapcompact/shake | Preserve sibling image blocks when `/shake elide` replaces eligible text. | Current conversation (live compaction bug); CostCompactionAudit item 2 | `open_pr` | [PR #9997](https://github.com/can1357/oh-my-pi/pull/9997) | Mutation-proven: unfixed behavior fails and fixed behavior passes; PR is p0/triaged. `/shake images` remains intentionally destructive. | Track review/merge; no duplicate or policy issue. | Public-safe; do not include private prompt/image contents. |
| `COMP-002` | Snapcompact/inline | Compact eligible text in mixed text+image tool results while preserving images and keeping estimator/runtime candidates identical. | Current conversation (live compaction bug); CostCompactionAudit item 2 | `open_pr` | [PR #9998](https://github.com/can1357/oh-my-pi/pull/9998) | Mutation-proven with shared candidate builder and preserved opaque attachments; PR is p0/triaged. | Track review/merge; no duplicate. | Public-safe; do not include private tool payloads. |
| `SET-008` | Numeric settings | Allow finite custom numeric values in addition to presets, including `ask.timeout`. | Current conversation (dynamic numeric input); CostCompactionAudit item 6 | `fixed_upstream` | None | Current Unreleased generic `NumberInputSubmenu` adds `Custom…`, validates finite numbers, and preserves non-preset selection. | No issue. | Public-safe. |
| `MODEL-001` | Settings precedence | Add an explainable global → role → exact-model → temporary session/request override cascade with provenance. | Current conversation (per-role/per-model overrides); CostCompactionAudit item 12 | `existing_discussion` | [Ideas discussion #10011](https://github.com/can1357/oh-my-pi/discussions/10011); related visibility issue [#9932](https://github.com/can1357/oh-my-pi/issues/9932) is not a duplicate | No exact-model/session override mechanism or effective-settings provenance UI exists; this is broader than merely showing resolved agents. The proposal is now upstream. | Continue precedence/provenance design on #10011 before filing or implementation. | Public-safe at the abstract settings/API level. |
| `COMP-003` | Model roles | Add a user-assignable compaction model role for automatic and manual compaction. | Current conversation (compaction role/model); CostCompactionAudit item 13 | `existing_issue` | [Issue #4139](https://github.com/can1357/oh-my-pi/issues/4139) | Live duplicate search found the exact `modelRoles.compaction` request and both automatic/manual modes in the issue and comments. Current source still lacks the role. | Continue on #4139; do not file the prepared duplicate draft. | Public-safe. |
| `COMP-004` | Snapcompact policy | Define the product boundary across overflow compaction, inline system/tool imaging, `/shake`, and bitmap-frame archives: shared policy, defaults, archive budget/eviction, protected content, and audit/restore contract. | Parent assignment’s explicit Snapcompact policy/default group; CostCompactionAudit verified substrate; current conversation | `existing_discussion` | [Ideas discussion #10012](https://github.com/can1357/oh-my-pi/discussions/10012); mechanics under review in [PR #9997](https://github.com/can1357/oh-my-pi/pull/9997) and [PR #9998](https://github.com/can1357/oh-my-pi/pull/9998), neither of which owns policy | The two PRs fix image-preservation mechanics only. The cross-mode contract now has an upstream Ideas owner. | Continue policy/default/archive discussion on #10012; do not expand #9997/#9998 or represent them as policy implementations. | Public-safe at the product-contract level; never disclose private prompt, tool, or archive contents. |
| `TUI-011` | Sessions UI | Add/fix a recent-session picker and per-session actions. | Current-conversation audit checklist | `retracted` | None | No source complaint or broken behavior found; `--resume` picker and Agent Hub revive/abort actions already exist. | Do not file without a concrete new repro. | Public-safe. |
| `TUI-012` | Windows input | Add a separate Windows keybinding mode for clipboard/follow-up terminal conflicts. | Current-conversation audit checklist | `fixed_upstream` | None | Current keybinding docs/code already provide Windows Terminal fallbacks (`Alt+V`, `Ctrl+Q`) for swallowed chords. | No action; file only a specific uncovered chord with reproduction. | Public-safe. |
| `PRIV-002` | Private GUI direction | Apply private ImGui composer/transcript standards without treating them as an upstream terminal-product request. | `IMGUI-UI-STANDARDS.md:13-278` | `private_only` | None | Audit found the GUI direction only in the private downstream standards, not the canonical oh-my-pi requirements. The doc also records token/widget/lifecycle/viewport gaps. | Keep in the private GUI workstream; upstream only generic, independently implemented invariants when relevant. | Private-only; never expose CAD source paths, classes, screenshots, or implementation internals in public drafts. |
| `PRIV-003` | Downstream migration | Keep private downstream vendoring/native-version compatibility and unaudited consumer migration out of upstream issue drafts. | `CAD-CLOUDCASTLE-MIGRATION.md:7-121`; `HANDOFF.md:214-231` | `private_only` | Public OAuth fix is already [PR #9926](https://github.com/can1357/oh-my-pi/pull/9926) | The only public product defect is `AUTH-002`; downstream migration coupling is operational/private and one consumer was explicitly not audited. | Handle privately; upstream only independently reproducible product defects. | Strictly private. Do not name private repositories, deployment topology, pins, or internal bridges in public drafts. |

## Mechanical completeness appendix

### TuiPainAudit

All **21 inventory rows** map to canonical coverage exactly once at the audit-row level:

| Audit row | Canonical coverage |
| ---: | --- |
| 1 | `TUI-001` |
| 2 | `TUI-002` |
| 3 | `TUI-003` |
| 4 | `SESSION-001`, `SESSION-002`, `SESSION-003` (the audit row contained three independently classified claims) |
| 5 | `AGENT-001` |
| 6 | `TUI-004` |
| 7 | `TUI-005` |
| 8 | `TUI-006` |
| 9 | `TUI-007` |
| 10 | `AGENT-002` |
| 11 | `SET-001`, `SET-002`, `SET-003`, `SET-004` (the issue’s four sub-findings) |
| 12 | `SET-005` |
| 13 | `TUI-008` |
| 14 | `TUI-009` |
| 15 | `PRIV-001` (the canonical source is the private GUI standards, not an upstream TUI defect) |
| 16 | `ATTACH-001` |
| 17 | `ATTACH-002` |
| 18 | `ATTACH-003` |
| 19 | `TUI-010` |
| 20 | `TUI-011` |
| 21 | `TUI-012` |

### CostCompactionAudit

The artifact contains **20 named pain-point entries**, which normalize to **25 atomic tracker claims**:

| Audit item | Canonical coverage |
| ---: | --- |
| 1 | `SESSION-001`, `SESSION-002`, `SESSION-003` |
| 2 | `COMP-001`, `COMP-002` |
| 3 | `COST-001` |
| 4 | `COST-002` |
| 5 | `COST-003`, `COST-004` |
| 6 | `SET-008` |
| 7 | `SET-005` |
| 8 | `SET-001`, `SET-007` |
| 9 | `SET-002` |
| 10 | `SET-004` |
| 11 | `AGENT-001` |
| 12 | `MODEL-001` |
| 13 | `COMP-003` |
| 14 | `SET-006` |
| 15 | `MEM-001` (including closed duplicate #9916) |
| 16 | `PERF-001` |
| 17 | `MODEL-002`, `MODEL-003` |
| 18 | `TUI-006` |
| 19 | `AUTH-001` |
| 20 | `DESK-001` |

The audit’s additional session-scope price-auto-fetch request maps to `COST-005`; its summary’s “24 items” count arose from splitting multi-claim entries, while the structured `files` inventory has 20 entries. Both representations are therefore accounted for without inventing a miscellaneous row.

### AgentGuiPainAudit
All **24 inventory items** map to canonical coverage; combined-number and split-result audit items remain explicit:

| Audit item | Canonical coverage |
| ---: | --- |
| 1 | `AGENT-001` |
| 2 | `AGENT-002` |
| 3 | `AGENT-003` |
| 4/5 | `ATTACH-001`, `ATTACH-003` |
| 6 | `ATTACH-002` |
| 7 | `PLAT-001` |
| 8 | `DESK-001` |
| 9 | `DESK-002`, `DESK-003` |
| 10 | `UPDATE-001` |
| 11 | `AUTH-001` |
| 12 | `AUTH-002` |
| 13 | `AUTH-003` |
| 14 | `AUTH-004` |
| 15 | `OPS-001` |
| 16 | `OPS-002` |
| 17 | `SET-006` |
| 18 | `TUI-008` |
| 19 | `SET-001`, `SET-002`, `SET-003`, `SET-004` |
| 20 | `SET-007` |
| 21 | `NOTIFY-001`, `NOTIFY-002` |
| 22 | `OPS-003` |
| 23 | `MEM-001` (including the explicit #9916 duplicate) |
| 24 | `PRIV-002` |

### Canonical source documents and current-conversation additions

| Source inventory | Coverage |
| --- | --- |
| `REQUIREMENTS.md` items 1–3 | `TUI-001`–`TUI-003`, `SESSION-001`–`SESSION-003`, `MEM-001` |
| `REQUIREMENTS.md` items 4–9 | `AGENT-001`, `TUI-004`–`TUI-009`, `AGENT-002`, `SET-001`–`SET-005`, `ATTACH-001`–`ATTACH-003` |
| `REQUIREMENTS.md` items 10–19 | `UPDATE-001`, `MODEL-002`, `AUTH-001`–`AUTH-003`, `AGENT-003`, `DESK-001`–`DESK-003`, `COST-001`, `COST-003`–`COST-005`, `TUI-010`, `TUI-006`–`TUI-007`, `MODEL-003` |
| `HANDOFF.md` additional issue/branch rows | `AGENT-004`, `OPS-001`, `OPS-002`, `SET-006`, `SET-007`, `NOTIFY-001`, `NOTIFY-002`, `PERF-001`–`PERF-004`, `AUTH-004` |
| `ONBOARDING.md` restated priorities, open issues, and traps | Same canonical IDs as the requirement/handoff rows it restates; its distinct evidence is cited on `AGENT-001`, `AGENT-002`, `SET-001`, `SET-005`, `SET-007`, `ATTACH-001`, `DESK-001`, `DESK-003`, `TUI-007`, `MODEL-002`, and `MODEL-003` |
| `PR-BODIES.md` five PR bodies and filed-issue section | `TUI-001`, `AUTH-002`, `TUI-004`, `AGENT-004`, `UPDATE-001`, `SESSION-001`, `MEM-001`, `ATTACH-002` |
| `CRASH-MITIGATIONS.md` | `MEM-001`, `OPS-003`, `AUTH-003` |
| `IMGUI-UI-STANDARDS.md` audited private direction/copy pain | `PRIV-001`, `PRIV-002` |
| `CAD-CLOUDCASTLE-MIGRATION.md` audited downstream boundary | `PRIV-003` |
| Current conversation: Snapcompact images/developer text/options | `COMP-001`, `COMP-002` ([#9997](https://github.com/can1357/oh-my-pi/pull/9997), [#9998](https://github.com/can1357/oh-my-pi/pull/9998)) |
| Current conversation: dynamic numeric input | `SET-008` |
| Current conversation: per-role/per-model override provenance | `MODEL-001` |
| Current conversation: compaction role/model | `COMP-003` |
| Current conversation: Snapcompact cross-mode defaults/policy | `COMP-004` |
| Current conversation audit-only checks | `TUI-003`, `TUI-009`, `TUI-011`, `TUI-012`, `NOTIFY-001`, `NOTIFY-002` |

**Completeness totals:** 64 canonical rows; 21/21 TUI audit rows; 20/20 structured cost/compaction entries (25 atomic claims plus separately stated price-auto-fetch and Snapcompact-policy requests); 24/24 agent/GUI audit items; 19/19 numbered requirements; all five PR bodies and all three “filed instead” issue bodies represented. There is no `misc` bucket.
