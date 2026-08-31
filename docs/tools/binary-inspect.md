# binary_inspect

> Inspect compiled binaries with installed binutils, rizin, and bloaty backends.

## Source
- Entry: `packages/coding-agent/src/tools/binary-inspect.ts`

## Inputs
`action` is `doctor`, `headers`, `sections`, `symbols`, `deps`, `disasm`, `functions`, `strings`, or `size`. Inspection actions accept `path`; symbol-aware actions may accept `symbol`; `size` may compare `baseline`; `min_len` controls string filtering and `top` caps rows.

## Behavior
`doctor` reports available analyzers. Other actions verify the file is workspace-readable, invoke the appropriate backend without a shell, and normalize output into bounded structured rows. Missing tools and unsupported formats are explicit errors rather than empty results.

## Side effects and limits
All actions are read-only. The tool does not execute the inspected binary. File size, output bytes, row count, symbol resolution, and subprocess duration are capped.