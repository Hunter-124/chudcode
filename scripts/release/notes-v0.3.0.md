# Chudcode v0.3.0

Chudcode v0.3.0 is the first complete standalone companion release for Chudware. It replaces Chudware's private OMP completion bridge with the documented Chudcode RPC service while remaining a fully usable coding agent on its own.

## Stable host integration

- RPC v2 now exposes persistent sessions, typed host tools and URIs, provider/model catalog, API-key and OAuth state, project memory, compaction/retry controls, session export/branch/repair, and the native STT lifecycle.
- The maintained Python package is now `chudcode_rpc` 0.2.0; the stale `omp_rpc` import is gone.
- Host-tool calls, streamed text/thinking, todos, compaction, retries, subagents, extension UI requests, cancellation, steering, and session resume carry stable correlated events.

## Standalone desktop

- The native ImGui client now includes the complete session execution DAG, real attachment thumbnails, nested agent hierarchy, context/usage gauges, a deterministic icon atlas, stable ini persistence, and shared Chudware/Chudcode visual tokens without a runtime UI dependency.
- Linux, macOS, and Windows desktop archives contain compiled `chud`, the compiled desktop server, `chudcode-gui`, web/font/icon assets, checksums, version metadata, and complete third-party notices. No source checkout, Bun executable, or node_modules tree is required after installation.

## Agent correctness and recovery

- Mixed-image shake and snapcompact preserve every image while compacting eligible text.
- Session repair handles missing image blobs and `/session doctor` supports dry-run, atomic repair, and backups.
- Provider refusals have one consumer-facing contract; Cursor effort variants preserve exact wire model ids; task admission is memory-aware; hub topics/blackboard survive restart; disabled credentials are pruned safely; and token/cost components share one billable basis.
- The TUI has unified agent/model assignment visibility, shared mouse routing, typed document/folder attachments, improved status hierarchy, and durable usage animation lifecycle.

## Verification

- `bun run check:ts` passes across all 17 TypeScript workspaces.
- `bun run test:ts` passes all 179 test commands under the supervised release gate.
- Native desktop CTest passes 11/11; Python RPC tests pass 74 tests plus 16 subtests; focused Rust desktop tests pass 30/30.
- Standalone desktop launch was exercised from an unpacked source-free Linux archive, including a real native screenshot capture.
