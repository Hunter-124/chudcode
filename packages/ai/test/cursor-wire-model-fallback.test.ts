import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { streamCursor } from "@chudware/ai/providers/cursor";
import type { AssistantMessage, Context, Model } from "@chudware/ai/types";
import { buildModel } from "@chudware/catalog/build";
import {
	AgentClientMessageSchema,
	type AgentRunRequest,
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	HeartbeatUpdateSchema,
	InteractionUpdateSchema,
	ReadArgsSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@chudware/catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@chudware/catalog/discovery/protobuf";
import { Effort } from "@chudware/catalog/effort";
import { resolveWireModelId } from "@chudware/catalog/model-thinking";
import type { ModelSpec } from "@chudware/catalog/types";
import { sleep } from "@chudware/utils/async";

const CONNECT_END_STREAM_FLAG = 0b00000010;

type Response = (
	| { kind: "error"; code: string; message: string; partialText?: string; heartbeat?: boolean }
	| { kind: "success"; text: string }
	| { kind: "exec-success" }
) & { delayMs?: number };

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();
let responses: Response[] = [];
let requests: AgentRunRequest[] = [];

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function textDeltaFrame(text: string): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: {
					case: "textDelta",
					value: create(TextDeltaUpdateSchema, { text }),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function turnEndedFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: {
					case: "turnEnded",
					value: create(TurnEndedUpdateSchema, {}),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function heartbeatFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: {
					case: "heartbeat",
					value: create(HeartbeatUpdateSchema, {}),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function execReadRequestFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id: 1,
				execId: "exec-fallback",
				message: {
					case: "readArgs",
					value: create(ReadArgsSchema, { path: "/tmp/fallback", toolCallId: "call-fallback" }),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function connectErrorFrame(code: string, message: string): Buffer {
	const payload = Buffer.from(JSON.stringify({ error: { code, message } }), "utf8");
	return frameConnectMessage(payload, CONNECT_END_STREAM_FLAG);
}

function decodeRunRequest(frame: Buffer): AgentRunRequest {
	const length = frame.readUInt32BE(1);
	const clientMessage = fromBinary(AgentClientMessageSchema, frame.subarray(5, 5 + length));
	if (clientMessage.message.case !== "runRequest") {
		throw new Error(`expected runRequest, received ${clientMessage.message.case ?? "empty message"}`);
	}
	return clientMessage.message.value;
}

function isAgentRunRequest(payload: unknown): payload is AgentRunRequest {
	return payload !== null && typeof payload === "object" && "$typeName" in payload;
}

async function startServer(): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		let pending: Buffer = Buffer.alloc(0);
		const onData = async (chunk: Buffer): Promise<void> => {
			pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
			if (pending.length < 5) return;
			const length = pending.readUInt32BE(1);
			if (pending.length < 5 + length) return;
			stream.off("data", onData);

			requests.push(decodeRunRequest(pending));
			const response = responses[requests.length - 1];
			if (!response) {
				stream.respond({ ":status": 500 });
				stream.end();
				return;
			}

			// This HTTP/2 integration fixture verifies reported performance.now()
			// latency; fake timers would also stall the transport events under test.
			if (response.delayMs) await sleep(response.delayMs);
			stream.respond({
				":status": 200,
				"content-type": "application/connect+proto",
			});
			if (response.kind === "success") {
				stream.end(Buffer.concat([textDeltaFrame(response.text), turnEndedFrame()]));
				return;
			}
			if (response.kind === "exec-success") {
				stream.end(Buffer.concat([execReadRequestFrame(), turnEndedFrame()]));
				return;
			}
			const frames = response.heartbeat ? [heartbeatFrame()] : [];
			if (response.partialText) frames.push(textDeltaFrame(response.partialText));
			frames.push(connectErrorFrame(response.code, response.message));
			stream.end(Buffer.concat(frames));
		};
		stream.on("data", onData);
	});

	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected Cursor fallback fixture to bind a TCP port");
	}
	return `http://127.0.0.1:${address.port}`;
}

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "gpt-5.6-sol",
		requestModelId: "gpt-5.6-sol-none",
		name: "GPT-5.6 Sol",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			effortRouting: {
				off: "gpt-5.6-sol-none",
				[Effort.Low]: "gpt-5.6-sol-low",
				[Effort.Medium]: "gpt-5.6-sol-medium",
				[Effort.High]: "gpt-5.6-sol-high",
				[Effort.XHigh]: "gpt-5.6-sol-xhigh",
			},
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	} satisfies ModelSpec<"cursor-agent">);
}

const context: Context = {
	messages: [{ role: "user", content: "Reply only: OK", timestamp: 1 }],
};

async function runStream(baseUrl: string): Promise<{ events: string[]; result: AssistantMessage }> {
	const model = makeModel(baseUrl);
	const stream = streamCursor(model, context, {
		apiKey: "test-token",
		sessionId: crypto.randomUUID(),
		wireModelId: resolveWireModelId(model, Effort.Medium),
	});
	const events: string[] = [];
	for await (const event of stream) events.push(event.type);
	return { events, result: await stream.result() };
}

async function stopServer(): Promise<void> {
	for (const session of sessions) session.destroy();
	sessions.clear();
	if (!server) return;
	const closing = server;
	server = undefined;
	const closed = Promise.withResolvers<void>();
	closing.close(error => {
		if (error) closed.reject(error);
		else closed.resolve();
	});
	await closed.promise;
}

afterEach(async () => {
	responses = [];
	requests = [];
	await stopServer();
});

describe("Cursor exact discovered effort wire routing", () => {
	it("sends the effortRouting sibling on the first and only attempt", async () => {
		responses = [{ kind: "success", text: "OK" }];
		const baseUrl = await startServer();
		const { events, result } = await runStream(baseUrl);

		expect(events.filter(event => event === "start")).toHaveLength(1);
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].requestedModel?.modelId).toBe("gpt-5.6-sol-medium");
		expect(requests[0].requestedModel?.parameters).toEqual([]);
		expect(requests[0].modelDetails?.modelId).toBe("gpt-5.6-sol-medium");
	});

	it("reports not_found from the exact sibling without a guessed retry", async () => {
		responses = [{ kind: "error", code: "not_found", message: "exact sibling unavailable" }];
		const baseUrl = await startServer();
		const { result } = await runStream(baseUrl);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("exact sibling unavailable");
		expect(requests).toHaveLength(1);
		expect(requests[0].requestedModel?.modelId).toBe("gpt-5.6-sol-medium");
	});

	it("keeps a heartbeat before not_found observable without a second attempt", async () => {
		responses = [{ kind: "error", code: "not_found", message: "Error", heartbeat: true }];
		const baseUrl = await startServer();
		const { events, result } = await runStream(baseUrl);

		expect(events.filter(event => event === "start")).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		expect(requests).toHaveLength(1);
	});

	it("stays single-attempt when the request is canceled", async () => {
		responses = [{ kind: "error", code: "not_found", message: "Error" }];
		const baseUrl = await startServer();
		const controller = new AbortController();
		Object.defineProperty(controller.signal, "aborted", {
			configurable: true,
			get: () => requests.length > 0,
		});
		const model = makeModel(baseUrl);
		const stream = streamCursor(model, context, {
			apiKey: "test-token",
			sessionId: crypto.randomUUID(),
			wireModelId: resolveWireModelId(model, Effort.Medium),
			signal: controller.signal,
		});
		for await (const _event of stream) {
			// drain to completion
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("aborted");
		expect(requests).toHaveLength(1);
	});

	it("reports first-attempt latency for the exact routed sibling", async () => {
		responses = [{ kind: "success", text: "OK", delayMs: 40 }];
		const baseUrl = await startServer();
		const { result } = await runStream(baseUrl);

		expect(result.stopReason).toBe("stop");
		expect(result.duration).toBeGreaterThanOrEqual(30);
		expect(result.ttft).toBeGreaterThanOrEqual(30);
		expect(requests).toHaveLength(1);
	});

	it.each(["permission_denied", "resource_exhausted", "unavailable"])("does not retry %s errors", async code => {
		responses = [{ kind: "error", code, message: "Error" }];
		const baseUrl = await startServer();
		const { result } = await runStream(baseUrl);

		expect(result.stopReason).toBe("error");
		expect(requests).toHaveLength(1);
	});

	it("honors an onPayload model replacement on the only attempt", async () => {
		responses = [{ kind: "error", code: "not_found", message: "hook model unavailable" }];
		const baseUrl = await startServer();
		let hookCalls = 0;
		const model = makeModel(baseUrl);
		const stream = streamCursor(model, context, {
			apiKey: "test-token",
			sessionId: crypto.randomUUID(),
			wireModelId: resolveWireModelId(model, Effort.Medium),
			onPayload: payload => {
				hookCalls++;
				if (!isAgentRunRequest(payload)) throw new Error("expected Cursor AgentRunRequest payload");
				return {
					...payload,
					requestedModel: payload.requestedModel
						? { ...payload.requestedModel, modelId: "hook-selected-model" }
						: undefined,
					modelDetails: payload.modelDetails
						? { ...payload.modelDetails, modelId: "hook-selected-model" }
						: undefined,
				};
			},
		});
		for await (const _event of stream) {
			// drain to completion
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(hookCalls).toBe(1);
		expect(requests).toHaveLength(1);
		expect(requests[0].requestedModel?.modelId).toBe("hook-selected-model");
		expect(requests[0].modelDetails?.modelId).toBe("hook-selected-model");
	});

	it("retains partial output from the single failed attempt", async () => {
		responses = [{ kind: "error", code: "not_found", message: "late failure", partialText: "partial" }];
		const baseUrl = await startServer();
		const { result } = await runStream(baseUrl);

		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "partial" })]);
		expect(requests).toHaveLength(1);
	});

	it("tracks exec bridge busy state on the first attempt", async () => {
		responses = [{ kind: "exec-success" }];
		const baseUrl = await startServer();
		const execStarted = Promise.withResolvers<void>();
		const releaseExec = Promise.withResolvers<void>();
		const model = makeModel(baseUrl);
		const stream = streamCursor(model, context, {
			apiKey: "test-token",
			sessionId: crypto.randomUUID(),
			wireModelId: resolveWireModelId(model, Effort.Medium),
			execHandlers: {
				async read() {
					execStarted.resolve();
					await releaseExec.promise;
					return {
						role: "toolResult",
						toolCallId: "call-fallback",
						toolName: "read",
						content: [{ type: "text", text: "file body" }],
						isError: false,
						timestamp: 1,
					};
				},
			},
		});
		const drain = (async () => {
			for await (const _event of stream) {
				// drain to completion
			}
			return stream.result();
		})();

		await execStarted.promise;
		expect(stream.hasPendingLocalWork).toBe(true);
		releaseExec.resolve();

		const result = await drain;
		expect(result.stopReason).toBe("stop");
		expect(stream.hasPendingLocalWork).toBe(false);
		expect(requests).toHaveLength(1);
	});
});
