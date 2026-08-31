# firmware

> Create, build, simulate, flash, and debug Cortex-M, ESP32, and Arduino firmware projects.

## Source
- Entry: `packages/coding-agent/src/tools/firmware.ts`

## Inputs
`action` is `status`, `new_project`, `build`, `sim_run`, `flash`, or `debug`. Project actions accept `dir`, `name`, and `family`. Runtime actions accept an ELF/image, chip or machine identifier, UART expectations, and timeout. `debug_cmd` selects persistent OpenOCD/GDB operations such as start, halt, continue, step, breakpoint, memory read, and stop.

## Behavior
Use `status` first to report available PATH toolchains and probes. `new_project` creates a real family-specific project, `build` invokes its native build system, and `sim_run` validates UART output against deadlines. Debug owns a bounded persistent session. Missing tools are explicit unavailable results.

## Side effects and safety
`flash` mutates physical hardware and always requires explicit approval immediately before execution. Build/new-project/debug actions write project or debugger artifacts; status is read-only. Paths, UART assertions, process output, memory reads, and timeouts are bounded.