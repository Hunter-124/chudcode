# Magic keywords

Magic keywords are standalone prose words in a user prompt that can add hidden, user-attributed instructions for that turn. Notice injection is enabled by default. The TUI highlights recognized words with animated gradients while editing and static gradients in sent messages; highlighting is a visual affordance and currently remains even when notice injection is disabled in settings.

## Keywords

| Keyword       | Effect                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ultrathink`  | Adds a careful multi-step reasoning notice. When automatic thinking is active, it also selects the highest reasoning effort supported by the current model for that turn.                                                                                                                                                 |
| `orchestrate` | Adds the multi-agent orchestration contract: scope the full task, delegate substantial independent work in parallel, verify each phase, and continue until the request is complete.                                                                                                                                       |
| `workflowz`   | Adds a deterministic multi-subagent workflow contract centered on the persistent `eval` kernel's `agent()`, `parallel()`, `pipeline()`, and `completion()` helpers. It is intended for broad research, reviews, migrations, and adversarial coverage. The notice is injected only when both `eval` and `task` are active. |
| `ultragoon`   | Adds the intent-first contract: saturate the request with parallel read-only research, then run one grounded decision round (via `ask`) that surfaces the load-bearing choices — including consequences discovered in the code that the user did not raise — before any construction. Intent then becomes locked acceptance criteria, and the final reply closes with a decision ledger. Injected when `ask` or `task` is active. |
| `tokenmaxxing` | Adds a maximum-capability routing contract: pick the strongest harness the task shape actually needs (intent verification, parallel research, `task` dispatch, programmatic `eval` fan-out, or a plain inline edit), commit to one, and back every claim with evidence. When `task` is active it also brings in the orchestration contract for the dispatch branch. It does not change reasoning effort — pair it with `ultrathink` for that. |
| `autobot`     | Adds a standing-authority contract for the request: ordinary engineering decisions and reversible actions proceed without permission checkpoints, ambiguity resolves toward repo conventions, and the reply reports what was decided unilaterally. Destructive or externally irreversible actions stay outside the grant unless the request names them. |

Use the keyword anywhere in the prose of the prompt:

```text
ultrathink about the failure modes before changing this API

orchestrate the migration described in docs/plan.md

workflowz an adversarial review of the authentication changes

ultragoon this rewrite of the session store

tokenmaxxing the flaky-test investigation

autobot land the changelog and push it
```

## Matching rules

Matching is deliberate so source code and paths do not accidentally change agent behavior:

- Use the exact lowercase spelling. `Ultrathink`, `Orchestrate`, `Workflowz`, `Ultragoon`, `Tokenmaxxing`, and `Autobot` do not trigger.
- The keyword must be standalone prose. Sentence punctuation and quotes may touch it, but letters, digits, underscores, slashes, backslashes, hyphens, file extensions, symbol references, and call syntax do not match. For example, `orchestrate,` matches; `orchestrated`, `orchestrate.ts`, `foo::orchestrate`, and `orchestrate()` do not.
- Fenced code blocks (backticks or tildes), inline code spans, HTML/XML comments/tags/elements, and their contents are ignored.
- All enabled keywords in one prompt may add their own notice. The visible word remains in the user message; hidden notices are non-displayed custom messages attributed to the user.
- The instruction applies only to the turn containing the keyword.

## Configuration

Open `/settings` and use **Interaction → Magic Keywords**, or change the settings from a shell:

```bash
# Disable every magic keyword
chudcode config set magicKeywords.enabled false

# Disable one keyword while leaving the others enabled
chudcode config set magicKeywords.ultrathink false
chudcode config set magicKeywords.orchestrate false
chudcode config set magicKeywords.workflow false
chudcode config set magicKeywords.ultragoon false
chudcode config set magicKeywords.tokenmaxxing false
chudcode config set magicKeywords.autobot false
```

The global switch and six per-keyword switches default to `true`. The global switch gates every hidden notice; a per-keyword switch gates only that notice (and ultrathink's maximum-auto-thinking override). These settings do not currently disable the editor/message gradient. Run `chudcode config list` to inspect every setting and its current value. See [Settings](./settings.md) for configuration scopes, precedence, and project-local overrides.
