# Chudcode UI Foundation — the design-system contract

This file is the **version-controlled authority** for every visual, motion,
layout, input and asset decision in the Chudcode GUI. It supersedes
`docs/fork/IMGUI-UI-STANDARDS.md` where the two disagree.

**Provenance note.** Citations of the form `CAD:path:line` (e.g.
`CAD:host/src/ui/anim.h:43`) refer to `~/Repositories/CAD`, the audited design
source. They are **design provenance only** — evidence that a rule was proven
in a shipping product. CAD is **not** a runtime dependency of Chudcode:
Chudcode is a direct Chudcode implementation, and every module below is built in
this repository against upstream Dear ImGui.

Rule keywords are RFC 2119.

---

## 1. Provenance and licensing

- **Every third-party UI asset MUST have an identifiable license before it
  enters the tree.** (Carried from the fork doc §0; the
  `KingsleydotDev/ImGui-Menus` dump remains banned under all circumstances —
  no license, multi-author, and the "look" inside it is stock Dear ImGui
  anyway.)
- A `docs/licenses.md` row MUST land **in the same change** as any new
  dependency or asset (rule proven at `CAD:contracts/licenses.md:103`).
- License texts ship next to the binaries they cover: `assets/fonts/OFL.txt`
  for Rubik and JetBrains Mono. (CAD ships the `.ttf` files without the OFL
  text — verified 2026-08-27 — do not repeat that.)
- Generated assets MUST record their generator script + inputs so they are
  reproducible and provenance-auditable.
- Chudcode starts with an **empty license-debt register**. CAD's
  `contracts/license_debt.md` rows (Gemma weights, scraping adapters, GPL
  solvers, CC-BY-NC models) are not UI dependencies and are **not inherited**.

### Ships in Chudcode

| Asset | License | Obligation |
| --- | --- | --- |
| Dear ImGui `v1.91.6-docking`, upstream `ocornut/imgui`, FetchContent-pinned | MIT | attribution in licenses.md |
| GLFW 3.4 (FetchContent; Emscripten uses its own port) | zlib/libpng | attribution |
| Rubik Regular/Medium/SemiBold/Bold | SIL OFL 1.1 | ship OFL text alongside |
| JetBrains Mono Regular/Medium | SIL OFL 1.1 | ship OFL text alongside |
| Theme/kit/anim/metrics source ported from CAD | in-house (same owner), private→private | keep provenance headers (`CAD:` file + commit) so drift stays traceable |
| Shell widgets (pill tabs, v-rail, group child, stacking two-column) — clean-room port, structure/interaction only (`CAD:host/src/ui/widgets/interwebz.h:1-4`) | in-house clean-room | rename on import (see drift D10); keep the clean-room provenance comment |

### MUST NOT ship in Chudcode

| Asset | Why | Replacement policy |
| --- | --- | --- |
| `CADSymbols.ttf` | CAD-domain symbol font (∅ ∥ ≡ ⊥ ⌀ …, `CAD:host/src/ui_theme.cpp:805-807`) with **no row in CAD's own license ledger**; merged onto every face in `loadFonts`, so a naive port drags it in | Strip the merge in the ported `loadFonts`. If a symbol face is ever needed, generate one in-house with recorded provenance. |
| CAD icon atlas inventory (extrude/fillet/mate/CAM tiles, photographic CAM toolpath renders, AI-batch raster cells in `CAD:assets/icons/src/`, `batches/`, `icon_prompts.json`) | CAD-domain; per-cell provenance lives only inside CAD's pipeline | Regenerate a Chudcode atlas with the **same pipeline pattern** (deterministic PIL generation, dual dark/light atlases sharing one layout, `atlas.json` schema, stable names, computed packing — `CAD:contracts/icons.md`) over a new IDE inventory: file/folder/git-status/diff/search/terminal/graph/LSP-kind glyphs. Adding an icon = draw function + name row, never hand-packed. |
| Chudware brand marks: the tesseract animated mark, `provider_logos.cpp` vendor logos | Tesseract is the monetized product's brand identity; vendor logos carry third-party trademark terms | Chudcode gets its own neutral working-mark satisfying `busyLabel`'s box contract; provider identity renders as tone-colored initials chips unless trademark usage is re-validated for Chudcode. |
| SolidWorks-look viewport/sketch/sim/CAM palette role families (`viewport*`, `plane*`, `sketch*`, `sim*`, `cam*`) and ribbon photographic tiles | CAD-domain, and a deliberate CAD aesthetic quotation an IDE should not carry | The Chudcode `Palette` **forks at the role level** (§3): those families are dropped and IDE families added instead. |

---

## 2. Build integration

- Dear ImGui via CMake `FetchContent`, pinned `v1.91.6-docking`; core + draw +
  tables + widgets + GLFW/OpenGL3 backends compiled into the executable.
  (Proven on Linux/Windows/macOS/WASM: `CAD:CMakeLists.txt:105-108,333-339`.)
- GL init order: context → theme → fonts → backends. `#version 330` desktop,
  `#version 300 es` under Emscripten.
- **Multi-viewport DECISION: OFF at v1.** Single GLFW window + docking. CAD
  ships without `ImGuiConfigFlags_ViewportsEnable` on four platforms; revisit
  only with a concrete detached-window need, and amend this section first.

---

## 3. Theme — semantic roles only

One module (`chud_ui_theme`, §14) owns a `Palette` of **named semantic
roles**; `applyTheme(Theme, float uiScale)` fills the palette, resets
`ImGuiStyle`, maps roles onto `ImGuiCol_*`, and DPI-scales sizes once via
`ScaleAllSizes`. **Panels read palette roles. Panels never hardcode a color
literal — including transparent wash/edge variants.** Tokens are mandatory for
*every* semantic color (closes fork-doc gap §9.1).

### Inherited dark-baseline values (provenance `CAD:host/src/ui_theme.h:29-205`)

| Role | Value |
| --- | --- |
| `windowBg` | `0.082, 0.090, 0.110, 1` |
| `panelBg` | `0.094, 0.106, 0.129, 1` |
| `headerBg` | `0.110, 0.125, 0.157, 1` |
| `popupBg` | `0.106, 0.118, 0.145, 1` |
| `border` | `0.165, 0.184, 0.227, 0.85` |
| `statusBg` | `0.075, 0.086, 0.108, 1` |
| `text` / `textDim` / `textDisabled` | `0.898,0.918,0.945` / `0.620,0.660,0.720` / `0.471,0.502,0.549` |
| `button` /hover/active | `0.149,0.176,0.220` / `0.184,0.224,0.275` / `0.216,0.259,0.318` |
| `frameBg` /hover/active | `0.129,0.149,0.184` / `0.165,0.192,0.235` / `0.192,0.224,0.271` |
| `codeBg` | `0.055, 0.065, 0.085, 1` |
| `proseBg` / `proseText` | `0.085,0.100,0.130` / `0.780,0.820,0.880` |
| `statusOk` / `statusWarn` / `statusErr` | `0.459,0.859,0.549` / `0.953,0.761,0.420` / `0.961,0.549,0.420` |
| diff add/del/hunk/header | `0.459,0.859,0.549` / `0.961,0.502,0.502` / `0.451,0.741,0.961` / `0.600,0.660,0.740` |
| glass bg/border/highlight/shadow | `0.118,0.133,0.167,0.87` / `0.230,0.275,0.365,0.80` / `1,1,1,0.09` / `0,0,0,0.40` |
| console default/ok/warn/err/dim | `0.780,0.820,0.880` / statusOk / statusWarn / statusErr / textDim |

`statusOk` means SUCCESS, never brand — it must not track the accent
(`CAD:host/src/ui_theme.h:141-146`).

### Chudcode role fork

**Dropped:** every `viewport*`, `plane*`, `sketch*`, `sim*`, `flow*`, `cam*`,
`fit*`, `plan*`, `parts*`, ribbon role.

**Added (IDE families, values authored in `chud_ui_theme` at implementation
time and recorded here when they land):** editor gutter + line-highlight +
current-line, search-match / search-current, terminal 16-color ANSI ramp,
graph node tones (rides `kit::Tone`), scrollbar pill, tab strip roles,
inline-diagnostic error/warn/hint underlines.

### Accent — user-owned, single authority

Defaults: primary orange `#F28216`, secondary blue `#0078D7`.
`setAccentColors(primary, secondary)` derives every variant and retints the
icon atlas; a theme switch re-installs the remembered pair.

Derivation: `Dim = RGB × 0.70`; wash alphas come from **one per-theme
`AccentAlphas` table and nowhere else**:

| alpha | dark | light |
| --- | --- | --- |
| soft | .22 | .18 |
| mid | .40 | .35 |
| **selection** | **.50** | **.40** |
| **hover** | **.40** | **.35** |
| overlayBorder | .275 | .40 |
| chip | .30 | .22 |
| treeHover | .10 | .08 |

**Normative rule (resolves drift D1): selection alpha is strictly greater
than hover alpha in both themes.** Selection is the persistent state and must
read stronger than the transient wash. CAD's header documents this fix
(`CAD:host/src/ui_theme.h:89-94`) while its runtime table re-installs the
inversion (`CAD:host/src/ui_theme.cpp:67`) — Chudcode authors the alphas in
the table **only**; `Palette` struct defaults are a non-normative out-of-box
preview.

Check marks, slider grabs, headers, separators, resize grips, tab hover,
docking preview, selected-text background and nav highlight all resolve from
accent roles — never set per-widget.

**Light is a real second palette, not an inversion.**

### Style metrics (provenance `CAD:host/src/ui_theme.cpp:396-422`)

```
rounding   window 9  child 9  frame 7  popup 8  scrollbar 10  grab 7  tab 8
padding    window 15x13  frame 12x7  item 10x9  inner 8x6  cell 8x6
scrollbar  size 12  grab min 11
borders    window/child/popup 1   frame 1 light / 0 dark   tab 0
disabled alpha 0.45
```

---

## 4. Adaptive glass (Liquid Glass v2)

Undocumented in the fork doc (drift D3); normative here for any panel floating
over live content (graph canvas, editor minimap, HUD, toasts).
Provenance `CAD:host/src/ui_theme.h:338-520`.

- **`GlassLevel`** UltraThin/Thin/Regular/Thick — scrim tint alphas
  `.12 / .22 / .35 / .52`.
- **`GlassGroup`** — per-group user styling with sentinel-inherit
  `GlassStyle` (hue, saturation, strength, level, opacity multiplier,
  rounding, contrast boost, dynamic color). Chudcode groups:
  `Global, Explorer, Editor, Copilot, Graph, Hud`. Pass the **same group every
  frame** for a given surface id.
- **`AdaptiveSurface`** — precomputed contrast surface (scrim tint,
  textPrimary/Secondary/Tertiary, darkText flag). `adaptivePanel(id, rect,
  group)` samples backdrop luminance with **.42/.58 hysteresis and 0.24 s
  temporal smoothing** so text tone never flickers at a threshold.
- **Sampler registration**: the host render layer registers a
  `LuminanceSampler` and optional `BackdropStatsSampler` (mean hue/sat +
  luminance variance from the blurred quarter-res buffer); the theme consumes
  them. No backdrop registered → palette fallback path, `darkText =
  (theme == Light)`.
- Text painted directly on live content uses `glassText` (contrast halo) or
  `maxContrastTextOn(surface)` — never a raw palette text role.
- Glass helpers for chrome: `glassBackground` (with alpha-scaled variant so a
  fading toast dims all five layers coherently), `glassRowBackground`,
  `glassSelectionGlow` (the ONE "selected" look — thin glow border, no fill,
  recolor by passing a different accent), `coloredRowWash`, `glassCardWash`.

### Pill scrollbars (drift D4)

- `drawScrollPill` / `drawWindowPillScrollbarV`: thin full-length hairline
  track + rounded pill thumb; the host child MUST carry
  `ImGuiWindowFlags_NoScrollbar` so the pill replaces, not doubles, the stock
  bar.
- Transcript/chat bar: **9 px pill, flush right**; the scroll child MUST
  reserve a **13 logical px right lane** (`kChatScrollbarLane`) or content
  slides under the bar. Scale with `metrics::px()`.

### Gauges and the working mark (drift D5)

- `drawFractionRing` / `drawStackedFractionRing` are the **one shape** for
  every budget/usage readout (context window, provider limits, toast
  countdown). Stacked spans clamp the total so an over-budget sum cannot wrap
  past 12 o'clock and read as nearly empty.
- `busyLabel(label)` is the **one** inline working indicator (mark + label on
  one baseline). ASCII dot / braille / `|-\` spinner cycles spliced into label
  strings are banned.

---

## 5. Metrics and density

`ui::metrics` keeps **only primitives and genuinely global tokens**:

- `px(logical)` — DPI scale; `U(n)` — 4 px base grid; `stroke(t)` —
  hairline-clamped ≥ 1 px; `rounding(r)` — radius-clamped ≥ 1 px.
- Values derived from `CalcTextSize` / `GetFrameHeight` / `GetStyle()` are
  already scaled — never wrap those in `px()`.
- Global tokens: chat scrollbar lane (§4), docked copilot column default/min
  width (340/200), composer max input lines 6, prose cap 150, live-stream grow
  cap 420, code/diff cap 220 (provenance `CAD:host/src/ui/metrics.h:47-74`).

**Normative rule (resolves drift D6): `kit` Density is the ONLY rhythm
source.** CAD's four near-identical per-workspace token families (`cpMenu*`,
`cpChat*`, `re*`, `cam*`) are exactly the drift Density was built to end
(`CAD:host/src/ui/widgets/kit.h:56-65`); importing any of them into Chudcode
is a lint failure (§15, rule `ownership`).

Density resolves `padX / padY / rowGap / rowRound / chipRound / sectionGap /
headGap / gutter`, all pre-multiplied by `uiScale`:

| Density | use | rhythm provenance |
| --- | --- | --- |
| `Compact` | streaming transcript runs | cpChat: row gap 2, card pad 9×4, turn gap 6 |
| `Cozy` | docked panes, menus (default) | cpMenu/cam: gutter 10, pad 10×8, gap 5, corner 8, section 14/6 |
| `Roomy` | full-width views, wizards, settings | re: pad 12×10, gap 8, corner 8, section 16/6 |

`pushDensity/popDensity` nest. **Never invent a fourth rhythm.**

---

## 6. Fonts and icons

- Load from disk at `<assetsDir>/fonts/`, not embedded. Faces × DPI scale
  (verified `CAD:host/src/ui_theme.cpp:842-846`): body Rubik Regular 17.5,
  medium Rubik Medium 17.5, h1 Rubik Bold 30.0, h2 Rubik SemiBold 19.0, mono
  JetBrains Mono Regular 15.5. **Strip the CADSymbols.ttf merge** (§1).
- **Glyph range is deliberately narrow:** `0x0020–0x00FF`,
  `0x2010–0x2027`, `0x2070–0x209F`. The font DOES carry `…` `—` `·` `×` `•`;
  it does NOT carry arrows, checkmarks, crosses, geometric shapes,
  box-drawing, dingbats — those render as `?` notdef.
- **Therefore: never use Unicode symbols for UI affordances.** Status marks
  are `kit::statusGlyph` (vector) or atlas icons, never string glyphs. This is
  the single most common way to ship a broken-looking build.
- Icon pipeline: deterministic script generation → `atlas_dark.png` +
  `atlas_light.png` + `atlas.json`, both atlases sharing one layout so a theme
  switch swaps textures with identical UVs; cells at 20 px and 32 px; glyph
  redraws are free but **names and UVs stay stable**. Chudcode inventory is
  IDE-domain (file/folder kinds, git status, diff, search, terminal, graph,
  LSP symbol kinds) and lives in `docs/icons.md` (append-only names section).

---

## 7. Widget vocabulary

`chud_ui_kit` is the app-wide visual vocabulary: **one implementation of each
composite widget**. CAD grew eight parallel toolkits — eight empty-state
painters, six section headers, five chip painters, six spinner idioms, fifteen
inline card chromes (`CAD:host/src/ui/widgets/kit.h:4-18`). Domain code
forwards to the kit; no module paints its own card, header, chip, empty state,
progress bar or status glyph.

Hard rules (kit contract):

1. Colors come from `ui::palette` / the `AdaptiveSurface` passed in — never a
   literal `ImU32`/`ImVec4`.
2. Sizes come from Density accessors or `ui::metrics` — never a fresh pixel
   literal.
3. Icons come from `docs/icons.md` by name — never a Unicode glyph.
4. Motion comes from `chud_ui_anim` — never a hand-rolled smoothstep or a bare
   duration literal.

Inventory (complete; the fork doc's list plus drift-D5 omissions):

- **Tone:** `Neutral, Accent, Ok, Warn, Err, Info` + `toneU32/toneVec` +
  `toneOn(Tone, AdaptiveSurface)` for legibility on glass.
- **Containers:** `cardBegin(id, title?, icon?, open?, tint?)` / `cardEnd()`
  (always paired, including collapsed path) / `cardHeaderRight(w)`.
- **Lists:** `sectionHeader(label, icon?, trailing?, count, first)` (owns its
  own gaps — no hand-placed `Dummy()` spacers); `row(id, title, RowStyle)`;
  `rowBegin/rowEnd` for bespoke bodies (kit still owns background, hover wash,
  selection glow, hit test, rhythm). `RowStyle`: icon/thumb, iconTone,
  secondary, meta, tooltip, selected, disabled, actionsW.
- **Chips:** `chip`, `valueChip`, `toggleChip`.
- **Buttons:** `primaryButton` / `secondaryButton` / `dangerButton` — disabled
  renders **disabled + `disabledReason` tooltip; never hide an action**;
  `iconButton` — **tooltip REQUIRED**; `segmented`; `popoverBegin/End` with
  active-count badge so collapsed filters never hide that filters are on.
- **Status:** `Status {Pending, Running, Done, Failed, Retry, Skipped}`,
  `statusTone`, `statusGlyph` + `statusGlyphInline`, `inlineStatus`,
  `progressBar` (frac outside `[0,1]` renders an **indeterminate marquee**,
  never a misleading empty/full bar), `spinner` (wraps `busyLabel`).
- **Empty/blocked:** `emptyState` (nothing YET — body explains what will
  appear and how to make it appear) and `blockedState` (something WRONG —
  reason + hint + optional action). **Every pane MUST render one of these
  instead of a blank region.**
- **Text/rhythm:** `dimText`, `keyValueRow(key, value, tone, copyable)`
  (value elides + tooltip, never wraps mid-token), `elide`, `rule`, `gapRow`,
  `gapSection`.
- **Formatting — one spelling per quantity:** `fmtBytes` ("2.4 MB"), `fmtAgo`
  ("3 min ago", "just now" under 10 s), `fmtCount` ("1.2k"), `fmtDuration`
  ("4.3 s").

**Stock ImGui widgets are fine and expected** (`InputTextMultiline`, `Button`,
`Checkbox`, `Selectable`, `BeginChild`, `Table`, `BeginPopup`). The custom
vocabulary is mandatory only for the named semantic composites.

**Draw-list convention:** custom geometry pairs (a) an ImGui hit item
(`InvisibleButton`), (b) the draw-list visual, (c) cursor restoration when the
hit item is absolutely positioned. Backgrounds behind controls use
`ImDrawListSplitter` channels and **always merge**.

---

## 8. Motion

Owned entirely by `chud_ui_anim` (fork-doc omission; drift D2). Provenance
`CAD:host/src/ui/anim.h`.

### Tokens (seconds, wall clock — identical at 20 Hz and 144 Hz)

| token | value | use |
| --- | --- | --- |
| `kInstant` | 0.08 | press/release feedback, checkbox fill |
| `kFast` | 0.14 | hover wash, chip tint, row highlight |
| `kBase` | 0.22 | expand/collapse, tab switch, selection move |
| `kSlow` | 0.38 | card entrance, drawer slide |
| `kStagger` | 0.02 | per-item delay in an entrance wave |
| `kBreathe` | 2.40 | ambient "alive / recently changed" pulse |
| `kMarch` | 1.10 | marching-ants / flow phase wrap |

Anything slower than `kSlow` on an interactive control feels broken, not
premium.

### Easings (clamped, t ∈ [0,1])

- `easeOut` — default for **user-triggered** motion: instant start, settle.
- `easeInOut` — motion the user did **not** trigger (auto-scroll, auto-frame).
- `easeOutBack` — **entrances only; never on a value the user reads** (it
  briefly displays a wrong number).
- `easeSpring` — critically damped, no overshoot; chasing a moving target.

### Invariants

- The app idles at 20 Hz (`glfwWaitEventsTimeout(0.05)`); any painter that
  needs the next frame soon calls `requestFrames()` **every frame it is
  moving** and simply stops when done — no release, no leak.
- `dt()` clamps to `[0, 0.05]` so a stall (breakpoint, blocking RPC, window
  drag) can never teleport a tween to its end state.
- `toward(id, target, seconds)` is the stateless per-id tween:
  frame-rate-independent exponential settle, continuous mid-flight
  re-targeting, auto frame requests only while moving. `peek` reads without
  advancing; `forget` retires an id (closed document, destroyed row).
- `pulse(period)` / `phase(period)` request frames on **every call** — call
  them only while the animated thing is on screen.
- New motion comes from tokens; a bare duration literal is a lint failure.
- **Motion ownership:** hover/press/disclosure/selection motion lives inside
  `chud_ui_kit`; feature modules never re-implement it.

### Motion vocabulary (per surface)

| Surface | Specification |
| --- | --- |
| **Streaming transcript rows** | New activity item: fade + 4 dp rise, `kFast` `easeOut`. Burst arrivals: `stagger(t0, i, kFast)`, wave capped at 8 items (beyond that appear instantly — long stagger on a fast stream reads as lag). Live thinking box grows via `toward(id, targetH, kBase)`. Streaming indicator = `busyLabel` + `pulse(kBreathe)` on the live-turn edge. Sticky autoscroll uses `SetScrollHereY(1)` — position snaps with content, never tweened. |
| **Filesystem edit events** (tree + live feed) | Created: row expands from 0 height, `kBase` `easeOutBack`. Modified: accentSoft wash pulse, exactly 2 × `kBreathe`, then a dim "recently changed" dot decaying after 30 s. Deleted: fade `kFast` → height collapse `kBase` `easeOut` → `forget(id)`. Renamed/moved: row travels via `toward` + `easeSpring`, `kBase`. Bursts (branch switch, formatter): above 20 events/frame suppress per-row motion, show one summary chip — motion degrades before it floods. |
| **Diffs** | Hunk expand/collapse: `toward` height, `kBase` `easeOut`. Line wash fade-in `kFast`, stagger `kStagger` capped at 10 lines. Navigate-to-hunk auto-scroll: `easeInOut` `kSlow`. **Never animate diff text color** — only the wash behind it. |
| **Graph insertions/removals** | Insert: node scales 0→1 `kSlow` `easeOutBack`; edges draw in via phase-clipped stroke over `kBase`; batch inserts stagger by graph distance from the trigger node, not array index. Remove: fade + scale to 0.6, `kBase` `easeOut`, then `forget`. Force-layout settle: positions chase targets via `easeSpring` `kBase` — never teleport. Recently-changed halo: `pulse(kBreathe)` within the change window. Active-flow edges: `phase(kMarch)` dash march. All ambient graph motion draws only while the canvas is visible. |
| **Tab changes** | Active underline slides via `toward`, `kFast` `easeOut`. Content: crossfade `kBase` maximum — **no horizontal content slide**. Dirty-dot `kInstant`; close-button hover `kFast`. |
| **Notifications / toasts** | Enter: 12 dp slide + fade, `kSlow` `easeOutBack`; glass layers dim coherently via the alpha-scaled `glassBackground`. Exit: `kBase` `easeOut`. Auto-dismiss countdown: depleting `drawFractionRing`. Stack limit 3; older toasts compress to a count chip with no per-toast reflow animation. |
| **Kit-owned micro-motion** | Hover wash `toward` `kFast`; press `kInstant`; card disclosure `kBase` `easeOut`; toggleChip fill `kFast`; selection-glow move `kBase`. |

### Reduced motion

CAD has no reduced-motion support; Chudcode adds it in `chud_ui_anim`:
`setMotionScale(float)` / `motionScale()`, settings knob "Reduce motion"
(sets 0). **No caller may branch on `motionScale` itself** — the semantics
live entirely inside the anim module so reduced motion cannot drift per-panel.

At scale 0:

- `toward()` jumps to target on the first frame; no frames requested.
- `pulse()` returns constant 1.0; `phase()` constant 0.0 — live markers render
  fully visible and static; marching ants become solid strokes.
- `stagger()` returns 1.0 immediately.
- Indeterminate marquee becomes a static "working" bar; `busyLabel`'s mark
  freezes at its rest pose.
- Entrances/exits render final state, except deletion keeps a ≥ 1-frame
  `textDim` strike-state so a removal is perceivable without motion.
- Ambient painters stop requesting frames — reduced motion also means reduced
  wakeups.

---

## 9. Panel contract

CAD has no panel base class or registration table — panels are imperative
functions in app-frame order; the fork doc names that a gap. This is the
Chudcode contract.

### Registration

Static registry in `chud_ui_kit` (`chud/ui/kit/panel.h`):

```
PanelDesc {
  const char* id;            // stable kebab-case, e.g. "vcs.status"
  const char* title;
  const char* icon;          // docs/icons.md name
  Density     defaultDensity;
  float       minWidthDp;
  bool        multiInstance;
  void      (*draw)(PanelCtx&);
  // optional hooks:
  void      (*onOpen)(PanelCtx&);  void (*onClose)(PanelCtx&);
  void      (*onProject)(PanelCtx&);
}
```

Panels register at static init; the shell iterates the table for the View
menu, dockspace builder, quick-open palette, persistence — and the visual
gate (§15) enumerates panels from the same table.

### Lifecycle

`closed → opening (onOpen: subscribe) → drawn every frame while visible
(cheap when idle; declare motion via requestFrames only while moving) →
hidden (registered, draw skipped, subscriptions kept) → closed (onClose:
unsubscribe, anim::forget retired ids)`. Project switch fires `onProject` on
all open panels: drop document-scoped state, keep panel-scoped prefs.

### Density

The shell pushes `defaultDensity` around `draw()`. A panel may push `Compact`
around a streaming sub-region only. Transcript = Compact; docked tools =
Cozy; full-width views = Roomy.

### State ownership — three tiers

1. **App/domain state**: owned by the app core; panels receive const
   snapshots + mutation callbacks. **A panel never owns a document.**
2. **Panel view state** (scroll, collapsed cards, filters, selected row):
   owned by the panel TU, keyed by panel instance id.
3. **Transient widget state**: ImGui + anim per-id tables.

No globals shared between panels; cross-panel effects go through the app core.

### Persistence

- Layout: **versioned ini** `imgui_chudcode_v1.ini` (bump on breaking dock
  changes); `IniFilename = nullptr` in headless/screenshot mode.
- Panel view state: one JSON per panel at `state/panels/<panel-id>.json`,
  written on a **400 ms debounce with an atomic durable write**; the loader
  **recovers** parseable files and never prunes unverified data (conservatism
  proven at `CAD:host/src/…/conversations.cpp:848-884,1365-1440`).
- Persistence key = `panel-id[:instance-ordinal]`; uniqueness is linted.

### Narrow-width ladder

Each panel declares `minWidthDp`. As width shrinks, degrade in order:
drop `RowStyle.meta` → elide secondary lines → toolbars go icon-only
(tooltips already mandatory) → multi-column bodies stack (two-column stacks
under 520 dp — proven shell-widget behavior) → below `minWidthDp` render a
single `blockedState("Panel too narrow", hint)` rather than clipped garbage.
Chrome never scrolls horizontally; only content (diffs, code) may.

### Empty / loading / error — mandatory

Every pane renders exactly one of: content, `emptyState`,
`spinner`/`progressBar` (indeterminate marquee when no progress is known), or
`blockedState` with the **failing dependency named** — never a bare "error",
never a blank region.

---

## 10. Keyboard and accessibility

- `ImGuiConfigFlags_NavEnableKeyboard` on.
- **Focus ring**: 2 px accent glow (the `glassSelectionGlow` shape) on the
  nav-focused item — one look app-wide.
- **Contrast** ≥ 4.5:1 for text on its painted surface. Over live backdrops
  this is what `AdaptiveSurface` / `maxContrastTextOn` exist for; panels never
  place raw palette text on a sampled surface.
- **Status is never color-alone**: `statusGlyph` pairs shape with tone.
- Disabled controls render disabled **with a reason tooltip**, never hidden.
- Every `iconButton` requires a tooltip (API contract + lint).

### Keyboard routing — four layers, resolved in order

1. **Active text input owns everything** except app-reserved chords; check
   `io.WantTextInput` before ANY global shortcut.
2. **Pre-input intercepts** claim keys via `ImGui::SetKeyOwner` **before** the
   widget (reference pattern: image paste claiming Ctrl/Super+V, falling back
   to normal text paste on failure).
3. **Panel-local shortcuts** require that panel's window focus.
4. **Global chords** (quick-open `Ctrl+P`, command palette `Ctrl+Shift+P`,
   panel cycling `Ctrl+PageUp/Down`, `Ctrl+S` routed to the focused editor)
   registered centrally with **conflict detection at registration time**.

In-input navigation (autocomplete Up/Down/Enter) is consumed **inside the
InputText callback** so it never fights send.

---

## 11. Composer and transcript — the prompt-box familiarity contract

The composer MUST feel exactly like the Chudcode prompt box the user already knows.
The behaviors below are ported (not reimplemented) from the proven
implementation (provenance `CAD:host/src/ui/copilot/composer.cpp`,
`text_wrap.h`, `chat_log.cpp`, `ui_common.cpp`).

### Selection-correct, artifact-free copy

- ImGui's multiline input does not wrap → implement same-length **soft
  wrapping** and track **user-entered hard-break offsets separately** so
  reflow never erases them.
- After native Ctrl+C/Ctrl+Insert, read `ImGuiInputTextState`, normalize
  **only the soft-wrap newlines against tracked hard-break provenance**, and
  overwrite the clipboard. Copies never pick up pipe/newline artifacts.

### Input ownership

- Send on bare Enter or Ctrl+Enter; **Shift/Alt+Enter inserts a hard
  newline**. Submit is gated on the input's own focus.
- Slash autocomplete consumes Up/Down/Enter inside the input callback.
- Image paste intercepted before InputText via `SetKeyOwner`; on failure,
  normal text paste still works.
- Input grows to 6 lines, then scrolls (§5 global tokens).

### Transcript

- Assistant turns are an **ordered event timeline**, not one prose blob;
  stream events fold into activity items; completed thinking/ops boxes
  collapse while retaining user-pinned state. Live thinking boxes grow to the
  420 px stream cap, then fall back to the 150 px fixed-height scroll.
- Prose is fence-aware: code fences render through a copyable read-only
  monospace box; other prose is selectable. Diffs are color-per-line in a
  horizontally scrolling child.
- Read-only `InputTextMultiline` gives click-drag selection and native Ctrl+C
  for assistant text; right-click offers selection-aware Copy / Copy text /
  Copy all.
- **Long transcripts use manual render windowing, not `ImGuiListClipper`**
  (rows are variable-height and interaction-sensitive): cache rendered height
  per message; replace off-screen non-interactive rows with same-height
  `Dummy` spacers.
- Autoscroll sticks during stream growth unless the user scrolls up; uses
  `SetScrollHereY(1)`, never a stale `ScrollMaxY`; render a jump-to-latest
  control after the child.

---

## 12. Hard-won interaction rules (carried verbatim; each was a shipped bug)

1. Resolve radio/tab hit zones **before** painting, or you get a one-frame
   stale highlight.
2. Unique scroll-child IDs per logical view, or scroll state leaks between
   views.
3. **Do not dismiss a tabbed overlay on "click outside"** — `IsWindowHovered`
   is false while an active item or popup owns interaction, so it flickers.
4. Save/restore cursor position around absolutely-positioned overlay
   `InvisibleButton`s.
5. A deferred scroll anchor must also break sticky-tail state.

---

## 13. Persistence summary

Covered normatively in §9; recorded here as the checklist: versioned ini;
`IniFilename = nullptr` headless; per-panel JSON with 400 ms debounced atomic
writes; conservative recovery (recover parseable, never prune unverified);
app state / drafts / transcripts always separate from the ini.

---

## 14. Module boundaries and ownership

Layering (arrows = allowed dependency):

```
L0  imgui (pinned v1.91.6-docking)
L1  chud_ui_theme     chud_ui_anim        (peers — no cross-dependency)
L2  chud_ui_kit  →  theme, anim, icons
L3  chud_ui_graph / chud_ui_editor / chud_ui_vcs / chud_ui_copilot
      →  kit, theme, anim   (NEVER each other, two allowlisted edges below)
```

- `imgui_internal.h` is permitted **only** in `chud_ui_theme` and
  `chud_ui_kit` TUs; feature modules get `ImRect`-free public APIs.
- Cross-feature composition happens only in the app shell via the panel
  registry.
- **Allowlisted L3 edges (explicit, not a loophole):** `chud_ui_vcs →
  chud_ui_editor` (diff view reuse) and `chud_ui_copilot → chud_ui_editor`
  (fence/diff rendering reuse).

| Module | Owns | Public headers | Must not |
| --- | --- | --- | --- |
| `chud_ui_theme` | Palette roles; Theme; `applyTheme`; accent pair + AccentAlphas single authority; Fonts/`loadFonts` (no CADSymbols); glass v1 helpers; Liquid Glass v2 (GlassLevel/Group/Style, AdaptiveSurface, `adaptivePanel`, sampler registration); pill scrollbars + chat lane; fraction rings; `busyLabel`; `uiScale` | `chud/ui/theme.h`, `chud/ui/glass.h` | reference any panel/feature module; any I/O beyond font/atlas load; any renderer types (samplers are registered function pointers) |
| `chud_ui_anim` | duration/period tokens; four easings; `requestFrames`/`consumeFrameRequest`; `dt` clamp; `toward`/`peek`/`forget`; `pulse`/`phase`/`stagger`; **`setMotionScale`/`motionScale`** | `chud/ui/anim.h` | depend on theme or kit; leave the GUI thread |
| `chud_ui_kit` | Tone + `toneOn`; Density + rhythm accessors; cards, section headers, rows, chips, buttons, segmented, popover; Status + glyphs; `inlineStatus`; `progressBar`; `spinner`; `emptyState`/`blockedState`; text/rhythm/format helpers; icon atlas loader; **panel registry** | `chud/ui/kit.h`, `chud/ui/kit/panel.h`, `chud/ui/icons.h` | know about files, git, LSP, transcripts, graphs — pure presentation vocabulary |
| `chud_ui_graph` | force-directed canvas panel; node/edge draw vocabulary (Tone-coded nodes, `phase(kMarch)` edges, §8 insert/remove motion); hit-testing; camera (pan/zoom, `easeInOut` auto-frame); LOD labels via `elide`; HUD via `GlassGroup::Graph` | `chud/ui/graph.h` | own a data model — consumes a plain node/edge snapshot + diff stream (added/removed/changed ids) from the app |
| `chud_ui_editor` | code editor panel (buffer view, gutter, syntax tones), tabs/dirty/save-reload prompts, quick-open + in-file search UI, LSP presentation (diagnostics, hover card on glass, completion popup), diff view (palette diff roles, §8 motion) | `chud/ui/editor.h`, `chud/ui/diff.h` | touch disk or sockets — text/LSP/file transport is injected |
| `chud_ui_vcs` | git status/stage rows, commit composer (reuses editor input core), history log with render windowing, branch switcher, blame gutter, live file-edit event feed | `chud/ui/vcs.h` | own VCS state — consumes a snapshot/diff-event interface |
| `chud_ui_copilot` | transcript panel (§11), composer (§11), streaming motion, jump-to-latest, chat scrollbar lane | `chud/ui/copilot.h` | couple to any CAD type — consumes a neutral Chudcode event-stream interface (turns, activity items, deltas) |

Enforcement: the include-graph lint (§15, `ownership`) fails any `#include`
crossing this matrix.

---

## 15. Gates — lint rules and pixel acceptance matrix

### Lint rules

Ported from the proven linter (`CAD:scripts/gui_lint.py`) plus Chudcode
additions. sha1-keyed baseline file for legacy findings; per-line
`// gui-lint: allow` escape.

| Rule | Check |
| --- | --- |
| `scale` | pixel-geometry literals in ImGui/draw-list calls must route through `px()`/`U()`/`stroke()`/`rounding()` or scale tokens; world-space canvas files demoted to non-gating `scale-ws` |
| `color` | `IM_COL32` with numeric channels; `ImVec4(r,g,b,a)` in color contexts (`PushStyleColor`/`TextColored`/`Add*`); `GetStyleColorVec4(non-Text)` — all fail outside the authoring allowlist (theme, icon baker, brand marks). Extends to transparent wash/edge variants: every semantic alpha is a token |
| `glyph` | string-literal codepoints outside the §6 allowlist fail (arrows/shapes render `?`); log-sink and model-prompt strings exempt |
| `dupe` | a definition matching a kit-primitive name whose body does not forward to `ui::kit` within 14 lines = second implementation = fail |
| `icon` | icon-name string arguments must exist in `atlas.json` |
| `theme` | `applyTheme(...,1.0f)` literal and `FontGlobalScale` assignment banned |
| `motion` *(new)* | bare float duration in `toward`/`stagger`/`pulse`/`phase` call sites (must be a `k*` token or a constant derived from one); hand-rolled smoothstep (`t*t*(3`) outside `chud_ui_anim`; `easeOutBack` heuristically flagged on values that also feed a text formatter |
| `ownership` *(new)* | include-graph enforcement of §14; any non-theme/kit TU including `imgui_internal.h`; any use of CAD's legacy `cpMenu*`/`cpChat*`/`re*`/`cam*` accessor names |
| `panel` *(new)* | PanelDesc id uniqueness + kebab-case; every registered panel's `draw()` references `emptyState`/`blockedState`/`spinner`/`progressBar` or is allowlisted always-populated; persistence-key collisions |
| `duplicate-widget` *(new)* | ast-grep pass for a second declaration colliding with the kit vocabulary names in feature-module namespaces |

### Pixel acceptance matrix (headless shot harness)

The harness enumerates panels **mechanically from the registry** and renders
each through the matrix:

```
{dark, light} × {uiScale 1.0, 2.0} × {populated, empty, loading, error}
             × {default width, minWidthDp}
```

Empty/loading/error are forced through the panel's injected data interface —
a panel that cannot be forced into those states fails review.

Assertions per shot:

1. No `#000000`/`#FFFFFF` runs outside sentinel/identity-tint contexts.
2. No notdef `?` where a glyph/icon was intended (probe string of every atlas
   icon name + every status glyph).
3. Hairlines ≥ 1 physical px at both scales.
4. Row/card left edges within 1 px of the density gutter line (the "nothing
   shared a left edge" regression class).
5. Text contrast ≥ 4.5:1 vs its painted background, including
   adaptive-surface panels over a bright **and** a dark synthetic backdrop.
6. Focus: tab through headlessly; exactly one accent focus ring per frame;
   every interactive item reachable.
7. Motion: with a fixed synthetic clock, capture t = 0 / ½dur / dur for each
   §8 vocabulary entry; assert start/end states and monotonicity. With
   `motionScale = 0`, assert frame 1 == final frame and zero `requestFrames`
   calls from ambient painters.
8. 1.0-vs-2.0-scale shot pair diffed after downsampling: layouts must be
   geometrically similar (the mis-scale regression class).

---

## 16. Drift register

Living register: every divergence between this contract and shipped code gets
a row (severity, finding, resolution owner). Seeded from the 2026-08-27 audit
of CAD against `docs/fork/IMGUI-UI-STANDARDS.md`:

| # | Sev | Where | Finding | Resolution in this contract |
| --- | --- | --- | --- | --- |
| D1 | high | `CAD:ui_theme.h:89-94` vs `CAD:ui_theme.cpp:67,90-91,489-490` | Three-way selection/hover alpha disagreement: header default+comment claim selection .50 > hover .40 ("previously inverted" fix), but the runtime `AccentAlphas` table re-installs selection .22 < hover .40 on every `applyTheme`/`setAccentColors`; the fork doc copied the runtime values. The header's 0.50 is dead code. | §3: selection strictly > hover in both themes; alphas authored only in the AccentAlphas table; struct defaults non-normative. |
| D2 | high | `CAD:ui/anim.h` vs fork doc | Fork doc has **no motion section** despite kit's hard rule 4; tokens, easings, frame-pump contract, dt clamp all undocumented. | §8 is normative. |
| D3 | high | `CAD:ui_theme.h:338-520` vs fork doc | Liquid Glass v2 adaptive-contrast system entirely undocumented (GlassLevel alphas, GlassGroup/GlassStyle, AdaptiveSurface, .42/.58 hysteresis + 0.24 s smoothing, samplers, glassText, maxContrastTextOn). | §4 is normative. |
| D4 | med | `CAD:ui_theme.h:486-520` vs fork doc | Pill-scrollbar contract (9 px flush-right chat bar, 13 lp reserved lane, NoScrollbar requirement) code-only. | §4. |
| D5 | med | `CAD:ui_theme.h:522-550`, `CAD:kit.h` vs fork doc | Undocumented: fraction rings, `busyLabel`, `Tone::Info`, `toneOn`, `statusGlyphInline`, `keyValueRow(copyable)`, `elide`, density accessors. | §4, §7. |
| D6 | med | `CAD:metrics.h:76-172` vs `CAD:kit.h:56-65` | Four near-identical rhythm families that kit Density explicitly supersedes; fork doc quotes their values without banning their import. | §5: Density is the only rhythm source; importing a legacy family is a lint failure. |
| D7 | low | `CAD:gui_lint.py:40`, `CAD:ui_theme.cpp:838-848` | Icons moved to shared `assets/icons` (T-G11); fonts verified (Rubik 17.5/17.5/30/19, JBMono 15.5) but CADSymbols.ttf is merged onto **every** face and would ride along in a naive port. | §1, §6: strip the merge. |
| D8 | low | `CAD:scripts/gui_lint.py` vs fork doc §9.1 | Fork doc laments unenforced color policy without mentioning CAD's existing linter and baseline mechanism. | §15 ports and extends it. |
| D9 | low | fork doc §9.4/§9.5 | Panel lifecycle and multi-viewport were left undecided. | §9 (contract) and §2 (multi-viewport OFF at v1) decide them. |
| D10 | info | `CAD:ui/widgets/interwebz.h:1-4` | Shell-widget family shares a name with the §1-banned archive but is a documented clean-room port (structure/interaction only, palette-driven). | §1: safe to reuse; rename on import; keep the clean-room provenance comment. |

Open items (not blockers):

- CADSymbols.ttf provenance is unrecorded in CAD's own ledger — CAD hygiene
  item; Chudcode excludes the font entirely.
- Whether Chudcode ever reuses the tesseract mark is an owner brand decision;
  this contract assumes a new neutral working mark.

---

## 17. Maintenance checklist (flat)

Every item below is part of the version-controlled UI foundation contract and
must be kept current in this file (or the named sibling) **in the same change**
that alters the corresponding code:

1. §1 license tables + `docs/licenses.md` row per new dependency/asset.
2. §2 ImGui/GLFW pins and the multi-viewport decision.
3. §3 palette role inventory (IDE fork) + AccentAlphas table.
4. §4 glass levels/groups, adaptive-surface constants, scrollbar/gauge/mark
   contracts.
5. §5 metrics primitives + Density rhythm values.
6. §6 font faces/sizes, glyph-range allowlist, `docs/icons.md` name inventory
   (append-only).
7. §7 kit widget inventory and its four hard rules.
8. §8 motion tokens, easings, per-surface vocabulary, reduced-motion
   semantics.
9. §9 panel registry schema, lifecycle, state tiers, persistence keys,
   narrow-width ladder, empty/loading/error mandate.
10. §10 keyboard routing layers + accessibility rules.
11. §11 composer/transcript familiarity contract.
12. §12 hard-won interaction rules (append-only).
13. §13 persistence checklist.
14. §14 module dependency matrix + allowlisted edges.
15. §15 lint rule set + pixel acceptance matrix.
16. §16 drift register (append a row for every contract/code divergence).
