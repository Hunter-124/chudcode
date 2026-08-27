# Chudcode GUI — UI element standards

Authority for the ImGui direction. Extracted from the maintained CAD GUI
(`~/Repositories/CAD`, ~152k lines across 253 files under `host/src/ui/`,
including 26 copilot files already wired to Chudcode via the Bun bridge), then
filtered to what a coding-agent client actually needs.

CAD citations are given as `file:line` so each rule can be checked against a
working implementation rather than taken on faith.

---

## 0. Provenance and licensing — read before importing anything

**Do not vendor `KingsleydotDev/ImGui-Menus`.** Verified 2026-08-27:

- The repository has **no license file**; GitHub reports `license: NONE`, which
  means all rights reserved by default.
- It is a 663 MB dump of ~40 `.rar`/`.zip` archives of Windows DX9/DX11
  game-cheat loader menus ("Baikzz Skeet Loader", "pandora.gg", "nemezida",
  "Lethal Loader", …). Its own description credits five other people, so no
  single party could grant a license even if asked.
- The specific archive we were pointed at, `interwebz v2 dx9.rar`, is an
  **unmodified Dear ImGui 1.86 WIP source tree** with the stock DX9 example:
  `main.cpp` contains zero style assignments (`grep -c 'ImGuiCol_|style\.' = 0`)
  and `imgui.ini` is the default demo layout (`Hello, world!`,
  `Another Window`, `Debug##Default`). It ships Dear ImGui's own MIT
  `LICENSE.txt`.

So the look in question is simply **default Dear ImGui dark**. That is MIT and
free to use directly — there is nothing to copy and nothing to license. Import
Dear ImGui from upstream (`ocornut/imgui`) and apply our own theme.

**Rule:** every third-party UI asset must have an identifiable license before it
enters the tree. This repo is shared with three collaborators and vendored into
two commercial products; unlicensed code is not an acceptable risk.

---

## 1. Build integration

Follow CAD, which is proven on Linux/Windows/macOS **and** WASM:

- Dear ImGui via CMake `FetchContent`, pinned: **`v1.91.6-docking`** from
  `ocornut/imgui` (`CMakeLists.txt:105-108,333-339`). Compile ImGui
  core/draw/tables/widgets plus the GLFW + OpenGL3 backends straight into the
  executable.
- GLFW 3.4 fetched for native; Emscripten uses its own GLFW port
  (`CMakeLists.txt:80-90,126-130`).
- GL init order: context → theme → fonts → backends. `#version 330` desktop,
  `#version 300 es` under Emscripten (`app.cpp:2673-2681`).

**Decide up front, because CAD never did:** multi-viewport (detached windows) is
**not** enabled in CAD — no `ImGuiConfigFlags_ViewportsEnable`,
`UpdatePlatformWindows`, or `RenderPlatformWindowsDefault` anywhere. Pick a
policy for Chudcode and write it down here.

## 2. Theme — semantic roles only

Centralize exactly as CAD does in `ui_theme.{h,cpp}`: a `Palette` of **named
semantic roles**, `applyTheme(Theme, float uiScale)` filling the palette,
resetting `ImGuiStyle`, mapping roles onto `ImGuiCol_*`, then DPI-scaling sizes
once via `ScaleAllSizes` (`ui_theme.cpp:376-479`).

**Panels read palette roles. Panels never hardcode a color literal.**

Dark baseline (`ui_theme.cpp:128-241`), the values worth inheriting:

| Role | Value |
| --- | --- |
| `windowBg` | `0.082, 0.090, 0.110, 1` |
| `panelBg` | `0.094, 0.106, 0.129, 1` |
| `headerBg` | `0.110, 0.125, 0.157, 1` |
| `popupBg` | `0.106, 0.118, 0.145, 1` |
| `border` | `0.165, 0.184, 0.227, 0.85` |
| `text` | `0.898, 0.918, 0.945, 1` |
| `textDim` | `0.620, 0.660, 0.720, 1` |
| `textDisabled` | `0.471, 0.502, 0.549, 1` |
| `button` / hover / active | `0.149,0.176,0.220` / `0.184,0.224,0.275` / `0.216,0.259,0.318` |
| `frameBg` / hover / active | `0.129,0.149,0.184` / `0.165,0.192,0.235` / `0.192,0.224,0.271` |
| `codeBg` | `0.055, 0.065, 0.085, 1` |
| `proseBg` / `proseText` | `0.085,0.100,0.130` / `0.780,0.820,0.880` |
| `statusOk` / `warning` / `error` | `0.459,0.859,0.549` / `0.953,0.761,0.420` / `0.961,0.549,0.420` |
| diff `add` / `delete` / `hunk` / `header` | `0.459,0.859,0.549` / `0.961,0.502,0.502` / `0.451,0.741,0.961` / `0.600,0.660,0.740` |
| `glassBg` / border / highlight / shadow | `0.118,0.133,0.167,0.87` / `0.230,0.275,0.365,0.80` / `1,1,1,0.09` / `0,0,0,0.40` |

**Accent is user-owned, not baked into the theme.** Defaults: primary orange
`#F28216`, secondary blue `#0078D7`. `setAccentColors()` derives every variant
and retints the icon atlas (`ui_theme.cpp:37-122,482-492`). Derivation rules:
`Dim = RGB × 0.70`; dark alphas `{soft .22, mid .40, selection .22, hover .40,
overlayBorder .275, chip .30, treeHover .10}`, light `{.18,.35,.18,.35,.40,.22,
.08}`. Check marks, slider grabs, headers, separators, resize grips, tab hover,
docking preview, selected-text background and nav highlight all resolve from
accent roles — never set them per-widget.

**Light is a real second palette**, not an inversion (`ui_theme.cpp:246-371`).

Style metrics (`ui_theme.cpp:396-422`):

```
rounding   window 9  child 9  frame 7  popup 8  scrollbar 10  grab 7  tab 8
padding    window 15x13  frame 12x7  item 10x9  inner 8x6  cell 8x6
scrollbar  size 12  grab min 11
borders    window/child/popup 1   frame 1 light / 0 dark   tab 0
disabled alpha 0.45
```

Dimensions go through a token layer, not magic numbers: `ui::metrics` gives
`px(logical)`, a 4 px grid `U(n)`, hairline-clamped `stroke`, radius-clamped
`rounding` (`metrics.h:23-34`). Chat-relevant tokens already tuned in CAD:
row gap 2, card pad 9×4, turn gap 6, max input lines 6, prose cap 150,
live-stream cap 420, code/diff cap 220 (`metrics.h:65-106`).

## 3. Fonts and icons

- Load from disk at `<assetsDir>/fonts/`, not embedded (`ui_theme.cpp:836-849`).
  CAD uses Rubik Regular/Medium 17.5, Rubik Bold 30, Rubik SemiBold 19,
  JetBrains Mono 15.5, each × DPI scale.
- **Glyph range is deliberately narrow:** `0x0020–0x00FF`, `0x2010–0x2027`,
  `0x2070–0x209F`. Arrows and geometric shapes are *excluded on purpose* to
  prevent notdef boxes (`ui_theme.cpp:790-803`).
- **Therefore: never use Unicode symbols for UI affordances.** Use the icon
  atlas. This is the single most common way to ship a broken-looking build.
- Icons are a hybrid raster atlas + `atlas.json` with an SDF derivation for
  monochrome cells (crisp at arbitrary size, halo support); multicolor cells
  fall back to raster (`icons.h:1-65`). Do **not** adopt CAD's photographic
  ribbon tiles or its `CADSymbols.ttf` merge — both are CAD-specific.

## 4. Widget vocabulary — the part to actually reuse

`host/src/ui/widgets/kit.h` is the shared composite vocabulary. Adopt these
signatures as Chudcode's baseline; domain code **forwards** to them and never
redraws card/header/chip chrome itself (`kit.h:1-27`).

- **Containers:** `cardBegin(id, title?, icon?, open?, tint?)` / `cardEnd()` /
  `cardHeaderRight(w)` — animated collapsible glass child; content on draw
  channel 1, wash painted behind on channel 0 (`kit.cpp:430-565`).
- **Lists:** `sectionHeader(label, icon, trailing, count, first)`,
  `row(id, title, RowStyle)`, `rowBegin/rowEnd`. `RowStyle` carries
  icon/thumbnail, tone, secondary/meta/tooltip, selected/disabled, action width
  (`kit.h:102-134`).
- **Chips/buttons:** `chip`, `valueChip`, `toggleChip`, `primaryButton`,
  `secondaryButton`, `dangerButton`, `iconButton` (**tooltip required**),
  `segmented`, `popoverBegin/End` (`kit.h:136-173`).
- **Status:** semantic `Tone`/`Status`, `statusGlyph`, `inlineStatus`,
  `progressBar`, `spinner`, `emptyState`, `blockedState` (`kit.h:39-54,175-209`).
  **Never render a blank panel** — use `emptyState`/`blockedState`.
- **Text/rhythm:** `dimText`, `keyValueRow`, `elide`, `rule`, `gapRow`,
  `gapSection`, `fmtBytes/Ago/Count/Duration` (`kit.h:211-234`).
- **Density is ambient and stack-scoped:** `Compact` (streaming transcript),
  `Cozy` (docked default), `Roomy` (wizards) (`kit.h:56-80`). Push `Compact`
  only around timeline rendering. Do not invent a fourth rhythm.

**Stock ImGui widgets are fine and expected.** CAD uses
`InputTextMultiline`, `Button`, `Checkbox`, `Selectable`, `BeginChild`,
`Table`, `BeginPopup` directly. There is no app-wide wrapper for everything —
the custom vocabulary is mandatory only for the named semantic composites.

**Draw-list convention:** custom painted geometry pairs (a) an ImGui hit item
such as `InvisibleButton`, (b) the draw-list visual, and (c) cursor restoration
when the hit item is absolutely positioned (`ui_common.cpp:688-725`). For
backgrounds behind controls use `ImDrawListSplitter` channels and **always
merge** (`kit.cpp:468-473,547-551`).

## 5. Layout

CAD has **no panel base class or registration table** — panels are imperative
`drawX(AppState&)` functions invoked in app-frame order (`copilot.h:30-36`).
That is a gap, not a model: **Chudcode should define a panel contract** (panel id,
title, state owner, draw entry, persistence key) instead of copying the ad hoc
call order.

- One scroll child per logical view, with **distinct child IDs** so scroll
  position is preserved per view. CAD documents why reusing a shared `chatlog`
  id was wrong (`panel.cpp:1764-1795`).
- Reserve an asymmetric right gutter for a custom scrollbar
  (`panel.cpp:1775-1797`).
- Flow layout is explicit `SameLine` + forced `NewLine` (`composer.cpp:4331-4336`);
  use tables for tabular forms. `cardHeaderRight()` is the standard
  right-alignment helper and protects header text from overlap.

## 6. Composer and transcript — the omp-critical part

This maps directly onto the three TUI complaints driving the GUI move.

### Selection-correct, artifact-free copy — already solved in CAD

ImGui's multiline input does not wrap, so CAD implements same-length soft
wrapping and **tracks user-entered hard-break offsets separately** so reflow
never erases them (`composer.cpp:17-61,87-114`).

Then, after ImGui's native Ctrl+C/Ctrl+Insert, it reads `ImGuiInputTextState`,
**normalizes only the soft-wrap newlines against tracked hard-break
provenance**, and overwrites the clipboard (`composer.cpp:172-190`, normalizer
API `text_wrap.h:39-44`).

That is precisely the fix for "copies pick up pipe and newline artifacts."
Port this behavior, not a reimplementation.

### Input ownership

- Send on bare Enter or Ctrl+Enter; Shift/Alt+Enter inserts a hard newline.
  Submit is gated on the input's own focus (`composer.cpp:192-202`).
- Slash autocomplete consumes Up/Down/Enter **inside the input callback** so
  navigation never fights send (`composer.cpp:68-114`).
- Image paste is intercepted **before** InputText: if Ctrl/Super+V carries an
  image, save the attachment and claim V via `ImGui::SetKeyOwner`; on failure
  normal text paste still works (`composer.cpp:4550-4577`). This is the
  reference pattern for key ownership.
- Global shortcuts must check both surface focus **and** `!io.WantTextInput`
  (`file_explorer.cpp:661-671`).

### Transcript

- Assistant turns are an **ordered event timeline**, not one prose blob;
  stream events fold into `ActivityItem`s, and completed thinking/ops boxes
  collapse while retaining user-pinned state (`feed.cpp:589-609,786-810`).
- Prose is fence-aware: code fences render through a copyable read-only
  monospace box; other prose uses selectable text (`ui_common.cpp:50-98`).
  Diffs are color-per-line in a horizontally scrolling child.
- Read-only `InputTextMultiline` is the trick that gives click-drag selection
  and native Ctrl+C for assistant text (`ui_common.cpp:441-496`). Right-click
  offers selection-aware Copy / Copy text / Copy all.
- **Long transcripts use manual render windowing, not `ImGuiListClipper`**,
  because rows are variable-height and interaction-sensitive: cache rendered
  height per message and replace off-screen non-interactive rows with
  same-height `Dummy` spacers (`chat_log.cpp:1042-1093`).
- Autoscroll sticks during stream growth unless the user scrolls up, and uses
  `SetScrollHereY(1)` rather than a stale `ScrollMaxY`; render a
  jump-to-latest control after the child (`chat_log.cpp:1095-1188`).

## 7. Hard-won interaction rules — carry these forward verbatim

Each of these exists in CAD because it was a bug:

1. Resolve radio/tab hit zones **before** painting, or you get a one-frame
   stale highlight (`copilot_internal.h:369-381`).
2. Unique child IDs per view, or scroll state leaks between views
   (`panel.cpp:1764-1795`).
3. **Do not dismiss a tabbed overlay on "click outside."** `IsWindowHovered` is
   false while an active item or popup owns interaction, so it flickers
   (`panel.cpp:1739-1749`).
4. Save/restore cursor position around absolutely-positioned overlay
   `InvisibleButton`s (`chat_log.cpp:1156-1169`).
5. A deferred scroll anchor must also break sticky-tail state
   (`chat_log.cpp:1196-1206`).

## 8. Persistence

- ImGui layout in a **versioned** ini (CAD: `imgui_gui_v6.ini`); set
  `IniFilename = nullptr` in headless/screenshot mode (`app.cpp:2620-2631`).
- App state, drafts and transcripts persist separately from the ini. CAD uses
  one JSON file per session plus an `index.json`; drafts save on a 400 ms
  debounce with an atomic durable write (`conversations.cpp:848-884`).
- The loader **recovers** parseable transcripts missing from the index and does
  not prune unverified data (`conversations.cpp:1365-1440`). Match that
  conservatism.

## 9. Known gaps — standardize these here rather than copying CAD

1. **Policy vs. practice.** Both `ui_theme.cpp:5-6` and `kit.h:20-25` forbid
   hardcoded colors, yet the copilot still pushes literal `ImVec4`s for
   attachment fills (`composer.cpp:4317-4329`) and the theme resolves window
   borders inline (`ui_theme.cpp:433-440`). Make tokens mandatory for **every**
   semantic color including transparent wash/edge variants.
2. **Widget consolidation is incomplete.** `kit.h:5-18` records an audit that
   found *eight* independent toolkits with duplicated empty states, section
   headers, chips and progress indicators. Verify a widget is not still
   duplicated before declaring it the Chudcode convention.
3. **The referenced style guide does not exist.** `metrics.h:3-8` cites
   `docs/GUI_STYLE_GUIDE.md` as the design authority; no such file is in the
   checkout. **This document is that file for Chudcode** — keep it current.
4. **No panel lifecycle contract** (see §5).
5. **No multi-viewport decision** (see §1).
6. **Copilot internals are private** (`copilot_internal.h:1-4`). Promote only
   the generic parts — composer input/copy, transcript item model, render
   windowing, scroll policy — into a public GUI module. Do not couple to CAD's
   `AppState`/`ChatMsg`.
