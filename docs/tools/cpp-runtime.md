# cpp_runtime

> Build and run C/C++ targets under sanitizers, Valgrind tools, heaptrack, perf, or rr.

## Source
- Entry: `packages/coding-agent/src/tools/cpp-runtime.ts`

## Inputs
`action` is `doctor`, `sanitize`, `memcheck`, `dhat`, `massif`, `callgrind`, `heaptrack`, `perf`, `rr_record`, or `rr_replay`. `build` selects `cmake`, `make`, or `none`, its directory, and an optional target. `run` supplies executable, argv, cwd, environment, and timeout. Sanitizer actions accept one or more sanitizer names; `top` bounds summaries.

## Behavior
`doctor` is read-only and reports available PATH tools. Every other action executes target code and therefore requires execution approval. Builds and runs use argv arrays rather than an interpolated shell, stay workspace-scoped, and return capped structured findings or profiles.

## Side effects and limits
Builds may create normal project artifacts; runtime tools may create profiles or rr traces. The tool never installs dependencies. Time, output, environment size, profile summaries, and path access are bounded by shared tool policy.