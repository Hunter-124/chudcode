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
