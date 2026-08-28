import { describe, expect, it } from "bun:test";
import { Tokenizer } from "@chudware/agent-core";
import {
	compact,
	estimateTokens,
	serializeConversation,
} from "@chudware/coding-agent/extensibility/legacy-chudcode-agent-shim";

// Issue #6583: chud extensions import `estimateTokens` from
// `@earendil-works/chudcode-agent`, which aliases to this shim. Legacy chud
// re-exported it from the coding-agent package root (via
// `./core/compaction/index.ts`); the core API has since become
// `Tokenizer.countMessage`, so the shim now defines a compat wrapper that keeps
// the legacy export surface — a named import must not throw Bun's static
// "Export named X not found" during plugin validation (e.g.
// `chudcode plugin install chud-blackhole`). This pins the export through the public
// package specifier.
describe("legacy shim compaction helpers", () => {
	it("exports estimateTokens as a callable token estimator", () => {
		expect(typeof estimateTokens).toBe("function");
		const tokens = estimateTokens({ role: "user", content: "hello world", timestamp: Date.now() }, new Tokenizer());
		expect(tokens).toBeGreaterThan(0);
	});

	it("counts tokens without a tokenizer argument (the legacy chud call shape)", () => {
		const tokens = estimateTokens({ role: "user", content: "hello world", timestamp: Date.now() });
		expect(tokens).toBeGreaterThan(0);
	});

	// Issue #7174: `compact` (same `@chudware/agent-core/compaction` module as
	// `estimateTokens`) was likewise absent from the shim surface, so
	// `chudcode plugin install npm:chud-claude-bridge` failed with "Export named
	// 'compact' not found". Pin the callable re-export.
	it("re-exports compact as a callable function", () => {
		expect(typeof compact).toBe("function");
	});
	// Issue #7403: `serializeConversation` is another package-root compaction
	// helper used by chud-openai-server-compaction. Its absence prevented the
	// extension from passing static validation.
	it("re-exports serializeConversation with legacy transcript formatting", () => {
		const serialized = serializeConversation([{ role: "user", content: "summarize this", timestamp: 0 }]);
		expect(serialized).toBe("[User]: summarize this");
	});
});
