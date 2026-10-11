import type { AgentTool, AgentToolResult, AgentToolUpdateCallback, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema } from "@oh-my-pi/pi-ai";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { applyToolProxy } from "../../extensibility/tool-proxy";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import type {
	RpcHostLoadableTools,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
} from "./rpc-types";

type RpcHostToolOutput = (frame: RpcHostToolCallRequest | RpcHostToolCancelRequest) => void;

/** Identity of a nested agent executing tools over its parent's RPC connection. */
export interface HostToolAgentScope {
	agentId: string;
	parentAgentId?: string;
}

/** Live source shared by a host session and its descendants. */
export interface HostToolSource {
	createTools(scope: HostToolAgentScope): AgentTool[];
	subscribe(listener: () => void): () => void;
	/** Whether the embedding host currently registers and executes `name`. */
	hasTool(name: string): boolean;
	/**
	 * Host instruction for a tool the host can load but has not registered yet,
	 * with `{name}` filled in. Undefined when the host does not list `name`.
	 */
	unloadedToolHint(name: string): string | undefined;
}

type PendingHostToolCall = {
	resolve: (result: AgentToolResult<unknown>) => void;
	reject: (error: Error) => void;
	onUpdate?: AgentToolUpdateCallback<unknown>;
};

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
	if (!value || typeof value !== "object") return false;
	const content = (value as { content?: unknown }).content;
	return Array.isArray(content);
}

export function isRpcHostToolResult(value: unknown): value is RpcHostToolResult {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; result?: unknown };
	return frame.type === "host_tool_result" && typeof frame.id === "string" && isAgentToolResult(frame.result);
}

export function isRpcHostToolUpdate(value: unknown): value is RpcHostToolUpdate {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; partialResult?: unknown };
	return frame.type === "host_tool_update" && typeof frame.id === "string" && isAgentToolResult(frame.partialResult);
}

class RpcHostToolAdapter<TParams extends TSchema = TSchema, TTheme extends Theme = Theme> implements AgentTool<
	TParams,
	unknown,
	TTheme
> {
	declare name: string;
	declare label: string;
	declare description: string;
	declare parameters: TParams;
	readonly strict = true;
	concurrency: "shared" | "exclusive" = "shared";
	readonly loadMode: ToolLoadMode;
	#bridge: RpcHostToolBridge;
	#definition: RpcHostToolDefinition;
	#scope: HostToolAgentScope | undefined;

	constructor(definition: RpcHostToolDefinition, bridge: RpcHostToolBridge, scope?: HostToolAgentScope) {
		this.#definition = definition;
		this.#bridge = bridge;
		this.#scope = scope;
		applyToolProxy(definition, this);
		this.loadMode = defaultLoadModeForToolName(definition.name, definition.loadMode);
	}

	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		return this.#bridge.requestExecution(
			this.#definition,
			toolCallId,
			params as Record<string, unknown>,
			signal,
			onUpdate,
			this.#scope,
		);
	}
}

export class RpcHostToolBridge implements HostToolSource {
	#output: RpcHostToolOutput;
	#definitions = new Map<string, RpcHostToolDefinition>();
	#loadableNames = new Set<string>();
	#loadableHint = "";
	#pendingCalls = new Map<string, PendingHostToolCall>();
	#listeners = new Set<() => void>();
	#closedError: Error | undefined;

	constructor(output: RpcHostToolOutput) {
		this.#output = output;
	}

	getToolNames(): string[] {
		return Array.from(this.#definitions.keys());
	}

	hasTool(name: string): boolean {
		return this.#definitions.has(name);
	}

	unloadedToolHint(name: string): string | undefined {
		if (this.#definitions.has(name) || !this.#loadableNames.has(name)) return undefined;
		return this.#loadableHint.replaceAll("{name}", name);
	}

	/** Replace the host tool set; `loadable` replaces the host's loadable-tool hints (omitted clears them). */
	setTools(tools: RpcHostToolDefinition[], loadable?: RpcHostLoadableTools): AgentTool[] {
		this.#definitions = new Map(tools.map(tool => [tool.name, tool]));
		this.#loadableNames = new Set(loadable?.names ?? []);
		this.#loadableHint = loadable?.hint ?? "";
		for (const listener of this.#listeners) listener();
		return tools.map(tool => new RpcHostToolAdapter(tool, this));
	}
	createTools(scope: HostToolAgentScope): AgentTool[] {
		return Array.from(this.#definitions.values(), tool => new RpcHostToolAdapter(tool, this, scope));
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	handleResult(frame: RpcHostToolResult): boolean {
		const pending = this.#pendingCalls.get(frame.id);
		if (!pending) return false;
		this.#pendingCalls.delete(frame.id);
		if (frame.isError) {
			const text = frame.result.content
				.filter(
					(item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string",
				)
				.map(item => item.text)
				.join("\n")
				.trim();
			pending.reject(new Error(text || "Host tool execution failed"));
			return true;
		}
		pending.resolve(frame.result);
		return true;
	}

	handleUpdate(frame: RpcHostToolUpdate): boolean {
		const pending = this.#pendingCalls.get(frame.id);
		if (!pending) return false;
		pending.onUpdate?.(frame.partialResult);
		return true;
	}

	requestExecution(
		definition: RpcHostToolDefinition,
		toolCallId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
		scope?: HostToolAgentScope,
	): Promise<AgentToolResult<unknown>> {
		if (signal?.aborted) {
			return Promise.reject(new Error(`Host tool "${definition.name}" was aborted`));
		}

		if (this.#closedError) {
			return Promise.reject(this.#closedError);
		}

		const id = Snowflake.next() as string;
		const { promise, resolve, reject } = Promise.withResolvers<AgentToolResult<unknown>>();
		let settled = false;

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			this.#pendingCalls.delete(id);
		};

		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			this.#output({
				type: "host_tool_cancel",
				id: Snowflake.next() as string,
				targetId: id,
			});
			reject(new Error(`Host tool "${definition.name}" was aborted`));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingCalls.set(id, {
			resolve: result => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			},
			reject: error => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
			onUpdate,
		});

		this.#output({
			type: "host_tool_call",
			id,
			toolCallId,
			toolName: definition.name,
			arguments: args,
			...(scope
				? { agentId: scope.agentId, ...(scope.parentAgentId ? { parentAgentId: scope.parentAgentId } : {}) }
				: {}),
		});

		return promise;
	}

	rejectAllPending(message: string): void {
		const error = new Error(message);
		const pendingCalls = Array.from(this.#pendingCalls.values());
		this.#pendingCalls.clear();
		for (const pending of pendingCalls) {
			pending.reject(error);
		}
	}

	/** Reject active and future host tool requests after the RPC client disconnects. */
	close(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const pendingCalls = Array.from(this.#pendingCalls.values());
		this.#pendingCalls.clear();
		for (const pending of pendingCalls) {
			pending.reject(this.#closedError);
		}
	}
}
