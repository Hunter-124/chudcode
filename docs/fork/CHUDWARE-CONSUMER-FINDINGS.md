# Findings from Chudware, the downstream consumer

**Filed:** 2026-08-27, from the Chudware repo (`Hunter-124/CAD`).
**Status:** OPEN. Nobody has picked these up yet.

Chudware vendors a whitelisted subset of this repo's `packages/` (`ai`, `agent`,
`catalog`, `utils`, `wire`, `mnemopi`, `snapcompact`) into `vendor/omp/` and drives it
from a `bun` sidecar it owns (`vendor/omp/bridge/`). `scripts/vendor_omp.py` **clobbers
`vendor/omp/packages/` on every re-vendor**, so nothing below can be fixed downstream:
a patch to `packages/ai` in Chudware's tree survives exactly until the next
`vendor_omp.py --sha …`.

> **Read this as: these need doing here, for Chudware.**
> Each item names the concrete downstream breakage, the exact source, and a bounded
> ask. Chudware has shipped the least-bad workaround it can build on its own side of
> the seam and those workarounds are marked — they are compensation for a missing
> contract, not a substitute for one.

Source references are against `Hunter-124/chudcode` @ `8bb8c9d25dc304ca67e5d863c121d4253b6870fe`.

---

## 1. A content refusal has four different shapes and no consumer-facing predicate

**Severity: high.** This one cost a user a whole project.

### What happened downstream

A Chudware user asked for a machinable hand-hammer pellet press plus shop drawings
(legitimate lab/pharmaceutical tooling; the same geometry a tablet die set has been for
a century). Anthropic's classifier refused it. The run died:

```
status=failed  stop_reason=provider_error
error_detail="anthropic: BridgeUnavailable: omp-bridge anthropic: Refusal (bio)"
```

The project directory ended the day with a PLM vault, an AI-VC chain, and **zero
deliverables** — while three other credentialed providers sat idle in the same config.
The user was told the *bridge* was unavailable, which is a lie about a perfectly
healthy sidecar and sends them to re-check working credentials.

### Why the consumer could not do better

`packages/ai` already has the right *concept* — `Flag.ContentBlocked`
(`packages/ai/src/error/flags.ts:304`) and `ProviderResponseErrorKind =
"content-blocked"` (`packages/ai/src/error/provider.ts:17,42`). It is applied in three
mutually incompatible ways and never once lands on the returned `AssistantMessage`:

| Provider path | How a refusal is reported | Machine-readable? |
|---|---|---|
| `providers/anthropic.ts:2599-2617` | returns a message: `stopReason:"error"` + `stopDetails:{type:"refusal",category,explanation}` | yes, but only via `stopDetails` |
| `providers/google-shared.ts:652`, `providers/google-gemini-cli.ts:790` | **throws** `ProviderResponseError{kind:"content-blocked"}` | yes, but only on the throw path |
| `providers/openai-shared.ts:3341-3348` | **throws** `ProviderResponseError{kind:"content-blocked"}` for `status:"incomplete"` + `incomplete_details.reason==="content_filter"` | yes, throw path |
| `providers/openai-completions.ts:2481-2482` | returns `stopReason:"error"` with the **prose** `"Provider finish_reason: content_filter"` — no flag, no `stopDetails` | **no** |

And a fifth shape that is not reportable at all: OpenAI `refusal` content parts are
**joined into the ordinary reply text** by `finalizeMessageText`
(`providers/openai-shared.ts:2648-2651`), with `stopReason` left at `"stop"`. A refusal
delivered that way is byte-indistinguishable from the model answering the question.

So a consumer that wants to know "did the vendor decline this?" must simultaneously:
inspect `stopDetails`, catch a throw and read a non-exported-as-contract `.kind`,
substring-match English prose, and — for one path — give up entirely.

### What Chudware built as a stopgap

- `vendor/omp/bridge/src/bridge.ts` now forwards `msg.stopDetails` on the completion
  result and `err.kind` on the RPC error frame. Both are in *our* bridge package, which
  `vendor_omp.py` preserves, so they survive re-vendoring — but they are transcribing a
  contract that should be stated here.
- `services/agent/omp_bridge.py` raises a `ProviderRefused` subclass; `agent_turn`
  classifies it as a new non-retryable `provider_refused` stop reason and **re-issues
  the identical prompt to the next configured vendor family** instead of dying.
- `services/agent/providers/omp_bridge_provider.py` keeps a prose-marker fallback for
  the paths above that have no structured signal. It is deliberately narrow (vendor
  enum values only) because `"connection refused"` must never be read as a policy
  decision — and that is precisely the ambiguity a structured field removes.

The OpenAI-refusal-as-plain-text case has **no workaround** and Chudware does not
attempt one: sniffing normal reply prose for refusal language would misfire on any turn
that legitimately discusses content policy. That path is simply undetectable downstream.

### Ask

Put the fact on the message, uniformly, for every provider:

1. Set `stopDetails: {type:"refusal", category?, explanation?}` (or an equivalent
   `contentBlocked` field on `AssistantMessage`) on **every** path that currently
   throws `kind:"content-blocked"` or returns prose — Google, OpenAI Responses,
   `openai-completions`' `content_filter`.
2. When an OpenAI `refusal` content part is present, stop folding it into `text`
   silently: keep the text (it is what the user should see) but mark the message.
3. Export one predicate — `isContentRefusal(msg)` / `AIError.isContentBlocked(err)` —
   so consumers classify on a function call rather than on four heuristics.

None of that changes retry policy or breaks an existing shape; it adds a field and a
predicate. A refusal is the one provider outcome where the correct recovery is
"ask a different vendor", and today nothing downstream can reliably detect it.

---

## 2. `AssistantMessage.stopDetails` is a contract with no consumers documented

`packages/ai/src/types.ts:960` declares `stopDetails?: StopDetails | null`
(`providers/anthropic-wire.ts:356-360`: `{type, category?, explanation?}`), and
`anthropic.ts` populates it. Nothing in `docs/` says a consumer should read it, and no
exported helper interprets it, so the field reads as provider-internal — which is why
Chudware's bridge dropped it for months and string-matched `errorMessage` instead.

**Ask:** either document `stopDetails` as part of the consumer-facing message contract
(and say which providers populate which `type` values), or mark it internal and expose
the information through item 1's predicate. The current middle state guarantees every
consumer re-derives it wrongly.

---

## 3. `gui/src/app/app.cpp` writes ImGui's ini file through a dangling pointer

**Severity: medium (data-adjacent, actively littering the repo).** Not a Chudware
consumer issue — this is chudcode's own GUI, found while working in this checkout.

```cpp
// gui/src/app/app.cpp:627-634
ImGui::CreateContext();
ImGuiLifetime imguiLifetime;                                        // declared FIRST
auto& io = ImGui::GetIO();
io.ConfigFlags |= …;
const std::string iniPath = (dataDirectory() / "imgui.ini").string(); // declared SECOND
io.IniFilename = iniPath.c_str();
```

`io.IniFilename` is a borrowed `const char*` that ImGui retains and dereferences during
`DestroyContext()` → `SaveIniSettingsToDisk()`. Locals destruct in reverse declaration
order, so `iniPath` is freed **before** `imguiLifetime` runs `DestroyContext()`. Every
clean shutdown therefore saves the layout to a filename made of freed heap bytes, in the
process CWD.

Observed in this checkout — one file per app exit, each the default 96-byte ini payload:

```
08-27 21:52:39  '}n'
08-27 21:53:52  '\udca2>'
08-27 21:56:34  '\udcd0\x0e'
08-27 21:57:50  '\udcd0*'
08-27 21:59:07  '+i'
08-27 22:00:50  '\udcb0+\udcf51'
08-27 22:02:53  '\udc8b\udcc6'
08-27 22:05:34  'S\x07\x03\x08\udc9b\x7f'
08-27 22:08:07  '\udcd6\udccc\x03\udc8c\x0f\x7f'
08-27 22:11:19  '\udcf0\udc95\udcb4;'
08-27 22:17:04  '\udc90\udc93\udcf7\x1e'
```

Eleven junk files in the repository root, and the window layout the user arranged is
never actually persisted — it goes to a random name every time. In-loop autosaves
(`io.IniSavingRate`) do land correctly, because `iniPath` is still alive then; only the
shutdown save is corrupt. Under a hostile allocator the freed bytes could name a real
path.

**Fix:** give the string storage that outlives the ImGui context — declare `iniPath`
*before* `imguiLifetime`, or make it `static const std::string`. A regression test can
assert `dataDirectory()/"imgui.ini"` exists after a headless create/destroy cycle and
that the CWD gained no new files.

---

## 4. `error/flags.ts` has no refusal handling at all

`grep -ci refusal packages/ai/src/error/flags.ts` → `0`, despite `Flag.ContentBlocked`
being defined in that same file (line 304). The flag is attached only from
`provider.ts`'s constructor and consulted nowhere in the flag helpers, so the retry /
fallback logic that reads flags cannot special-case a refusal either. Worth confirming
whether the agent loop's own model-fallback path is silently retrying refused prompts
on the same vendor — Chudware was, until this week.

---

## 5. `browser` / `computer` are agent-turn-only, CDP-family, and frame-less — so Chudware could not adopt them

**Filed:** 2026-08-28. **Severity: low for chudcode, blocking for the integration.**
**These are chudcode-side items for the Chudware integration**, not defects: everything
below works correctly for its designed consumer (a model taking a turn in this harness).
They are the three capability gaps that made a Chudware cutover impossible, written so a
chudcode maintainer can act without opening the Chudware repo.

Chudware evaluated replacing its own embedded-Chromium stack with chudcode's `browser` and
`computer` tools and **kept CEF**. The decision is recorded downstream in
`services/browser/README.md` ("Why the CEF backend remains"). What follows is the
chudcode-side half of that record.

**Path convention for this section**, since it cites two repos: paths starting
`packages/`, `src/`, or `tools/` are **chudcode** (`tools/…` is shorthand for
`packages/coding-agent/src/tools/…`). Paths starting `host/`, `services/`, or `scripts/`
are **Chudware** (`Hunter-124/CAD`).

### Context: what Chudware actually has to serve

Two unrelated consumers, both outside any agent turn:

**(a) Headless vendor fetch.** 95 supplier adapters
(`services/browser/adapters/*.py`) reach vendor sites through one seam:
`services/browser/driver.py:132` `headless_client()` → `services/browser/cef_client.py:150`
`CefDaemon`, whose entire API is four methods —
`fetch(url, settle_ms, profile)` (`:221`), `download(url, dest, profile)` (`:226`),
`interact(url, script, sentinel, …)` (`:230`), `import_session(cookies, profile)` (`:247`).
Callers are ordinary Python services: `services/browser/session.py:247,917`,
`services/browser/usage_scrape.py:580`, `services/parts/gui_rpc.py:1411`,
`services/parts/embed_rpc.py:98`. No LLM is in the loop; these run under a parts-search
RPC or a background scrape.

**(b) In-app embedded browser.** `ui::IWebViewBackend` /
`ui::makeWebView()` (`host/src/ui/widgets/web_view_backend.h:30,100`), implemented by
`CefWebView` off-screen rendering. Consumers: the Parts Library vendor sign-in panel
(`host/src/ui/parts/parts_browser_panel.cpp:73`), the Web workspace tab
(`host/src/ui/web_panel.cpp:58`), and the xAI OAuth capture modal
(`host/src/ui/oauth_capture.cpp:52,149,186`). The contract these need is a **frame
source**: `update()` pulls the newest paint, `draw(st, avail)` uploads it to a GL texture
and forwards ImGui input, all GL-thread-only.

### Gap 1 — no entry point outside a live agent turn

`BrowserTool` and `ComputerTool` are constructed only as `AgentTool`s from the built-in
factory table (`packages/coding-agent/src/tools/index.ts:480-481`,
`browser: s => new BrowserTool(s)`), and each takes a `ToolSession`
(`tools/index.ts:164`) — an interface carrying the whole agent context (settings,
session id, event bus, skills, extension roots, eval-kernel owner, session manager).
They are not incidental parameters:

- `resolveBrowserKind` reads five settings off the session
  (`tools/browser.ts:104,117,122,127,132`) to pick the transport at all;
- the private-stage path needs `session.getEvalKernelOwnerId()` or `getSessionId()` and
  hard-fails without one — `"Private headed browser stage requires a stable session
  owner"` (`tools/browser.ts:272-281`);
- `ComputerTool` sizes its captures from **the active model**:
  `usesCoordinateSafeImageSizing(this.session.getActiveModel?.())`
  (`tools/computer.ts:164`, predicate at `:42-51`).

`packages/coding-agent/src/index.ts` re-exports `./tools`, so the classes are importable —
but nothing constructs them without a session. On the CLI (`src/commands/`) there is no
`browser` or `computer` command; the one browser-adjacent entry is `chudcode browser-relay`
(`src/commands/browser-relay.ts`, `src/cli/browser-relay-cli.ts`), which serves the CDP
relay and installs the extension for the tool — it does not fetch pages. The tool's own
return value is turn-shaped too: `execute()` yields an `AgentToolResult<BrowserToolDetails>`
(`tools/browser.ts:229-235`) — prompt text plus renderer metadata — not a fetch result.

Separately, `packages/coding-agent` is **not in Chudware's vendoring whitelist**
(`scripts/vendor_omp.py:63-71` — `ai`, `agent`, `catalog`, `utils`, `wire`, `mnemopi`,
`snapcompact`), so "import the class" is not available either: Chudware consumes chudcode
through a `bun` bridge over vendored packages, and pulling the whole coding agent in to get
a page fetch is not a trade it can make.

**Ask:** a session-free callable surface for the two primitives Chudware's 95 adapters
need — fetch a URL and return `{html, final_url, status}`, and download a URL to a path —
reachable as either a CLI subcommand emitting JSON on stdout, a local socket RPC, or an
exported function taking an explicit options object instead of a `ToolSession`.

Three things suggest this is a small ask rather than a redesign:

1. **The engine already takes plain options.** `acquireBrowser(kind, opts)`
   (`tools/browser/registry.ts:128`) takes `AcquireBrowserOptions` (`:120-126`) —
   `{cwd, viewport?, appArgs?, signal?, stage?}`, no session — and the tab supervisor is
   likewise session-agnostic. The coupling lives in the tool wrapper, not the engine.
2. **A non-tool consumer already does exactly this, in-repo.** `renderPdfPageScreenshot`
   (`tools/read-pdf.ts:77-140`) bypasses `BrowserTool` and drives
   `acquireBrowser` / `acquireTab` / `runInTab` directly. It still threads a `ToolSession`,
   but reads only `session.cwd` (`:102`) and `session.getSessionId?.()` (`:114`) from it,
   plus passing it to `runInTab` (`:125`). That is the shape Chudware needs, one small step
   from being session-free.
3. **The result type already exists and already matches.** `BrowserFetchResult`
   (`tools/browser/page-fetch.ts:10-18`) is
   `{url, status, statusText, ok, headers, body, bytes, truncated}` — a superset of what
   the adapters want — produced by `browserFetchInPage` (`:51`), an intentionally
   closure-free exported function already shared by both the puppeteer tab worker
   (`tools/browser/tab-worker.ts:1684`) and cmux (`tools/browser/cmux/cmux-tab.ts:579`).
   Nothing new has to be designed; it needs a caller that is not a tool.

### Gap 2 — every transport is CDP-family; Chudware's anti-bot path is deliberately not

Four of the five browser kinds (`tools/browser/registry.ts:30-36`) attach a CDP client:
`headless` and `spawned` launch Chromium through `puppeteer-core`
(`tools/browser/launch.ts:106,462`), `connected` takes an HTTP CDP discovery endpoint
(`tools/browser.ts:97-98`, `tools/browser/registry.ts:177-185`), and `relay` is explicitly a
CDP impersonation — *"The relay impersonates Chrome's CDP discovery endpoint, so … the
entire connected-browser machinery … applies unchanged"*
(`tools/browser/relay/kind.ts:1-8`). The fifth, `cmux`, speaks its own socket protocol
(`tools/browser/cmux/rpc.ts:5-10`) to a surface Chudware has no equivalent of, so it is not
an option either.

To be clear and fair: chudcode already does real anti-detection work on this path —
`STEALTH_IGNORE_DEFAULT_ARGS` strips `--enable-automation` and eight other puppeteer
defaults (`tools/browser/launch.ts:32-54`), and `applyStealthPatches`
(`tools/browser/launch.ts:985`) layers a UA override plus document-start scripts. That is
the same category of work Chudware does. The mismatch is one level below it, in the
transport.

Chudware's CEF path is built on the premise that the automation *protocol* itself is the
tell, and its own header states the constraint verbatim
(`host/src/ui/widgets/cef/cef_stealth.h:9-16`): it uses CEF's **in-process**
`ExecuteDevToolsMethod` for exactly two methods (`Network.setUserAgentOverride`,
`Page.addScriptToEvaluateOnNewDocument`), opens **no remote-debugging socket**, never
enables the `Runtime` domain, and extracts HTML via `CefFrame::GetSource` rather than
`Runtime.evaluate` — *"precisely to keep the Runtime domain disabled."* The Python client
says the same (`services/browser/cef_client.py:4-7`). Fingerprint hardening is injected
from the render process at `OnContextCreated`
(`host/src/ui/widgets/cef/cef_app.cpp:76`), not over a wire.

Chudware has not measured chudcode's stealth stack failing on a specific vendor, and this
section does not claim it does. The objection is architectural and narrower than "CDP is
detectable": chudcode reaches the page over an out-of-process CDP connection driven by
`puppeteer-core`, whereas Chudware's design constraint is that no remote-debugging
endpoint exists at all and that page content is read through a native API
(`CefFrame::GetSource`) instead of a protocol domain. Adopting `browser` for vendor fetch
means giving up that property, which is the property the whole CEF migration was for.

**Ask:** either (a) a documented statement of the threat model `browser` targets — if
puppeteer-over-CDP with the current patches is measured clean against commodity bot gates,
say so and Chudware will re-test rather than assume; or (b) a non-CDP or
minimal-CDP-surface transport option. If neither is in scope, that is a legitimate answer
and Chudware keeps CEF — the ask is that the boundary be stated, so downstream stops
re-deriving it.

### Gap 3 — no embeddable off-screen frame surface

Frames leave both tools only as **files on disk**. `ScreenshotResult` is
`{dest, mimeType, bytes, width, height}` (`tools/browser/tab-protocol.ts:30-36`) and
`ComputerScreenshot` is `{path, width, height, sourceWidth?, sourceHeight?, target}`
(`tools/computer/protocol.ts:39-46`) — a path, written to `browser.screenshotDir` or the
OS temp dir, one per capture, on demand.

`computer`'s isolated surface is a real virtual desktop, but it is an **X11 display**, not
a frame source: `ComputerStageDescriptor` hands back `displayServer: ":N"` and
`env: {DISPLAY}` (`tools/computer/stage.ts:27-34,143-150`), backed by a broker-owned Xvfb
(`xvfbArgs`, `:106-127`). The one continuous view is `stage-viewer.ts`, which stands up
**x11vnc + noVNC** (`tools/computer/stage-viewer.ts:15-19`) and returns an
`http://127.0.0.1:<port>` URL (`ComputerStageViewerDescriptor.url`, `:27-32`), surfaced as
`ComputerToolDetails.viewerUrl` (`tools/computer.ts:86`). That is a human-facing web viewer.

Neither shape satisfies `IWebViewBackend`, which needs a per-frame BGRA/RGBA buffer it can
upload to a GL texture on the GL thread each frame, plus input forwarding back into the
page — CEF's `OnPaint` contract, described in
`host/src/ui/widgets/web_view_backend.h:14-17`. A screenshot
file per capture cannot drive an interactive vendor login at frame rate, and embedding a
VNC client inside the ImGui app to re-decode a desktop that only contains a browser would
be strictly worse than the in-process browser already linked in.

**Ask:** an off-screen frame callback on the browser side — a subscription that hands the
consumer raw pixels plus dirty rects as the page paints, with a matching input-injection
entry point (mouse/key/scroll into the page, not into an X server). This is the largest of
the three asks and plausibly out of scope for a coding agent; recording it mainly so the
shape is on file if an embedded-surface consumer ever shows up again.

### Summary

| Gap | Chudware consumer | Smallest thing that would unblock it |
|---|---|---|
| Agent-turn-only entry | `services/browser/cef_client.py` (95 adapters) | session-free `fetch`/`download` via CLI JSON, socket RPC, or an options-object export |
| CDP-family transport | headless vendor fetch | a stated threat model, or a minimal-CDP-surface transport |
| No frame surface | `ui::IWebViewBackend` (3 panels) | off-screen paint callback + input injection |

Gap 1 is the one worth doing on its own merits: a session-free fetch primitive is useful to
any embedder, and the engine under the tool wrapper already takes plain options. Gaps 2
and 3 are Chudware-shaped and are filed for the record, not as expectations.

> Chudcode-side references in this section were read from the local
> `Hunter-124/chudcode` working checkout on 2026-08-28; Chudware-side references are
> `Hunter-124/CAD` at the same date. No chudcode source was modified.
