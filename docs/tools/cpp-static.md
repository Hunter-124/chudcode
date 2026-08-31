# cpp_static

> Run bounded C/C++ static analyzers that are already installed on the host.

## Source
- Entry: `packages/coding-agent/src/tools/cpp-static.ts`

## Inputs
`action` is `doctor`, `cppcheck`, `tidy`, `analyze`, `iwyu`, or `infer`. Analyzer actions accept workspace `paths`; compile-database consumers accept `compile_commands`; `checks` narrows clang-tidy; `max_findings` caps output.

## Behavior
Use `doctor` first to report which PATH tools are available. Analyzer invocations run without a shell, remain workspace-scoped, and normalize diagnostics into one capped finding schema. A missing analyzer is an explicit unavailable result, never an empty-success claim.

## Side effects and limits
The tool reads source and build metadata. It does not install analyzers or rewrite code. Output, subprocess duration, path count, and finding count use the shared tool limits.