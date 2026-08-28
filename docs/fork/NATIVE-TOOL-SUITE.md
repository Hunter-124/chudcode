# Native vision and low-level tooling

Chudcode ships five discoverable tool families for image understanding and low-level development. They are mounted under `xd://` instead of consuming top-level tool-schema context. Ask the agent to run each family's `doctor` or `status` action before relying on optional host tools.

## `image_analyze`

`image_analyze` delegates classical image operations and local ONNX inference to the optional `chud-vision` sidecar. The sidecar is a short-lived native process: model memory is released when each request ends, so idle Chudcode sessions pay no model RSS.

Actions:

- `describe`: classification, object/face detection, and OCR in one request
- `classify`, `detect`, `ocr`: focused structured analysis
- `redact`: blur faces and remove OCR-detected PII
- `crop`: explicit or detected-content crop
- `locate`: OCR text or image-template coordinates for computer use
- `diff`: changed-pixel regions between two images

`inspect_image` also accepts `preprocess: "redact" | "crop" | "redact+crop"` before delegating to a vision-capable language model. If the sidecar is unavailable, `inspect_image` continues without preprocessing and reports that fact; direct `image_analyze` calls return an installation hint.

Models download only when needed, are SHA-256 verified, and default to `~/.chudcode/models/vision`. Set `vision.autoDownload=false` for fully offline provisioning or `vision.modelDir` to change the model store.

| Capability | Model | License |
| --- | --- | --- |
| Classification | MobileNetV4 Conv Small | Apache-2.0 |
| Object detection | D-FINE-N COCO | Apache-2.0 |
| Face detection | YuNet 2023mar | MIT |
| OCR | PP-OCR mobile detector, recognizer, and dictionary | Apache-2.0 |
| Runtime | ONNX Runtime 1.28.1 | MIT |

The release artifact bundles ONNX Runtime, not model weights. AGPL Ultralytics and FastSAM components are intentionally excluded.

## `cpp_static`

Run `{"action":"doctor"}` first. Available actions wrap host-installed `cppcheck`, `clang-tidy`, CodeChecker/Clang Static Analyzer, include-what-you-use, and Infer. Findings normalize to bounded JSON records with tool, rule, severity, file, line, column, and message. Chudcode invokes GPL tools as separate executables and does not link them into the closed-source binary. CodeQL is intentionally unsupported because its license excludes this use.

Most compiler-backed actions need `compile_commands.json`. Configure CMake projects with:

```sh
cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
```

## `cpp_runtime`

Run `{"action":"doctor"}` first. The tool can build instrumented CMake/Make targets and interpret AddressSanitizer, UndefinedBehaviorSanitizer, ThreadSanitizer, MemorySanitizer, Valgrind Memcheck/DHAT/Massif/Callgrind, heaptrack, perf, and rr results. These actions execute target code and therefore use the same approval boundary as other command execution. Missing host tools return a structured install hint rather than throwing.

## `binary_inspect`

Read-only ELF inspection covers headers, sections, symbols, dependencies, strings, disassembly, function inventories, and Bloaty size comparisons. Binutils provides the baseline; rizin and Bloaty add richer optional actions.

## `firmware`

`{"action":"status"}` reports build, emulation, flashing, and debugging capabilities for Cortex-M, ESP32, and Arduino workflows. The generalized firmware path supports project creation, toolchain-aware builds, QEMU/Renode simulation with UART expectations, probe-rs/esptool/OpenOCD flashing, and OpenOCD plus GDB-MI debugging. Build and simulation execute local code. Flashing changes attached hardware and always requires the strongest explicit approval.

Host tools are discovered from `PATH`; Chudcode does not bundle GPL firmware or analyzer executables.
