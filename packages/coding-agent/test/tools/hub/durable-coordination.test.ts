import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@chudware/utils";
import { Settings } from "../../../src/config/settings";
import { IrcBus, type IrcMessage } from "../../../src/irc/bus";
import { AgentRegistry } from "../../../src/registry/agent-registry";
import type { AgentSession } from "../../../src/session/agent-session";
import type { ToolSession } from "../../../src/tools";
import { HubTool } from "../../../src/tools/hub";
import {
	executeBlackboardGet,
	executeBlackboardSet,
	executeSend,
	executeTopicPublish,
	executeTopicRead,
	executeTopicSubscribe,
	MAX_TOPIC_MESSAGES,
} from "../../../src/tools/hub/messaging";

interface FakeAgentSession {
	session: AgentSession;
	delivered: IrcMessage[];
}

function fakeAgentSession(): FakeAgentSession {
	const delivered: IrcMessage[] = [];
	return {
		session: {
			isStreaming: true,
			subscribe: () => () => {},
			waitForIrcAutoReplies: async () => {},
			deliverIrcMessage: async (message: IrcMessage) => {
				delivered.push(message);
				return "injected" as const;
			},
			emitIrcRelayObservation: () => {},
		} as unknown as AgentSession,
		delivered,
	};
}

function registerAgent(
	registry: AgentRegistry,
	id: string,
	kind: "main" | "sub",
	sessionFile: string,
): FakeAgentSession {
	const fake = fakeAgentSession();
	registry.register({
		id,
		displayName: id,
		kind,
		session: fake.session,
		sessionFile,
	});
	return fake;
}

function hubTool(registry: AgentRegistry, sessionFile: string): HubTool {
	return new HubTool({
		cwd: path.dirname(sessionFile),
		hasUI: false,
		settings: Settings.isolated(),
		agentRegistry: registry,
		getAgentId: () => "Main",
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
	} as ToolSession);
}
describe("durable hub coordination", () => {
	let temp: TempDir;
	let rootSessionFile: string;
	let registry: AgentRegistry;

	beforeEach(() => {
		temp = TempDir.createSync("chudcode-hub-durable-");
		rootSessionFile = temp.join("root.jsonl");
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		registerAgent(registry, "Main", "main", rootSessionFile);
	});

	afterEach(() => {
		temp.removeSync();
	});

	it("reads retained topic publications after the process globals restart", async () => {
		const published = await hubTool(registry, rootSessionFile).execute("publish", {
			op: "publish",
			topic: "contracts",
			message: "Keep the v2 envelope.",
		});
		expect(published.isError).toBeFalsy();
		expect(published.details).toMatchObject({ op: "publish", topic: "contracts" });

		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		registerAgent(registry, "Main", "main", rootSessionFile);

		const read = await executeTopicRead(
			{ registry, senderId: "Main", sessionFileHint: rootSessionFile },
			{ topic: "contracts" },
		);
		expect(read.details?.topicMessages).toEqual([
			expect.objectContaining({
				topic: "contracts",
				revision: 1,
				from: "Main",
				body: "Keep the v2 envelope.",
			}),
		]);
	});

	it("delivers a publication unchanged to each live topic subscriber", async () => {
		const subscriber = registerAgent(registry, "Worker", "sub", temp.join("root", "Worker.jsonl"));
		const subscribed = await executeTopicSubscribe(
			{ registry, senderId: "Worker", sessionFileHint: rootSessionFile },
			{ topic: "handoff" },
		);
		expect(subscribed.details?.subscribers).toEqual(["Worker"]);

		const published = await executeTopicPublish(
			{ registry, senderId: "Main", sessionFileHint: rootSessionFile },
			{ topic: "handoff", message: "  preserve this prose exactly  " },
		);
		expect(published.details?.receipts).toEqual([{ to: "Worker", outcome: "injected" }]);
		expect(subscriber.delivered).toHaveLength(1);
		expect(subscriber.delivered[0]?.body).toBe("  preserve this prose exactly  ");
	});

	it("rejects stale blackboard compare-and-set revisions without changing the value", async () => {
		const deps = { registry, senderId: "Main", sessionFileHint: rootSessionFile };
		const first = await executeBlackboardSet(deps, {
			key: "owners.auth",
			value: { agent: "A" },
			expectedRevision: 0,
		});
		expect(first.details?.blackboard).toEqual(expect.objectContaining({ revision: 1, value: { agent: "A" } }));

		const stale = await executeBlackboardSet(deps, {
			key: "owners.auth",
			value: { agent: "B" },
			expectedRevision: 0,
		});
		expect(stale.isError).toBe(true);
		expect(stale.details?.blackboard).toEqual(expect.objectContaining({ revision: 1, value: { agent: "A" } }));

		const read = await executeBlackboardGet(deps, { key: "owners.auth" });
		expect(read.details?.blackboard).toEqual(expect.objectContaining({ revision: 1, value: { agent: "A" } }));
	});

	it("bounds retained publications while preserving monotonic topic revisions", async () => {
		const deps = { registry, senderId: "Main", sessionFileHint: rootSessionFile };
		for (let revision = 1; revision <= MAX_TOPIC_MESSAGES + 1; revision++) {
			const published = await executeTopicPublish(deps, {
				topic: "bounded",
				message: `message ${revision}`,
			});
			expect(published.isError).toBeFalsy();
		}

		const read = await executeTopicRead(deps, { topic: "bounded", limit: MAX_TOPIC_MESSAGES });
		expect(read.details?.topicMessages).toHaveLength(MAX_TOPIC_MESSAGES);
		expect(read.details?.topicMessages?.[0]?.revision).toBe(2);
		expect(read.details?.topicMessages?.at(-1)?.revision).toBe(MAX_TOPIC_MESSAGES + 1);
	});

	it("keeps the existing direct-message body and receipt wire shape unchanged", async () => {
		const recipient = registerAgent(registry, "Worker", "sub", temp.join("root", "Worker.jsonl"));
		await executeTopicSubscribe(
			{ registry, senderId: "Worker", sessionFileHint: rootSessionFile },
			{ topic: "compat" },
		);

		const sent = await executeSend(
			{
				registry,
				senderId: "Main",
				settings: Settings.isolated(),
				sessionFileHint: rootSessionFile,
			},
			{ to: "Worker", message: "plain DM" },
		);
		expect(sent.details).toEqual({
			op: "send",
			from: "Main",
			to: "Worker",
			receipts: [{ to: "Worker", outcome: "injected" }],
		});
		expect(recipient.delivered.at(-1)?.body).toBe("plain DM");
	});
});
