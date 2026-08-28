/**
 * The agent half of the Discord session bot: one real chudcode agent process
 * per Discord thread, driven over the documented RPC protocol.
 *
 * Why a child process per thread instead of embedding `AgentSession` in the bot:
 * the bot owns a single websocket to Discord that must survive everything the
 * agent does. A tool that wedges, a native addon that faults, or an
 * out-of-memory model turn takes down only its own child here, and the gateway
 * connection -- along with every other thread's session -- keeps running. The
 * in-process SDK would put all of that in the bot's crash domain and would also
 * require hand-threading a private `AgentRegistry` per concurrent session.
 *
 * Three invariants this module holds:
 *
 * 1. One turn at a time per session. A second prompt arriving mid-turn is the
 *    caller's problem to steer or reject; the runtime never interleaves two
 *    turns on one transcript.
 * 2. A turn always settles. Terminal `agent_end`, an operator abort, the turn
 *    ceiling, or a dead child -- there is no fourth outcome and no path that
 *    leaves a Discord thread waiting forever.
 * 3. Session identity outlives the child process. The agent's session id is
 *    persisted per thread, so a bot restart resumes the same transcript with
 *    `--resume` instead of starting a stranger in the same thread.
 *
 * Sessions are written to the default session store, not a bot-private one, so
 * work started from Discord can be reopened later with `omp -r` at the desk.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { DevbotConfig, WorkspaceRoot } from "./devbot-config";
import type { TodoLine } from "./transcript";

/** How often a running turn checks that its agent child is still alive. */
const HEARTBEAT_INTERVAL_MS = 4_000;

/** Ceiling for a plain command round trip (`get_state`, `set_model`, ...). */
const COMMAND_TIMEOUT_MS = 30_000;

export type TurnOutcome = "completed" | "aborted" | "timeout" | "crashed";

export interface TurnResult {
	readonly outcome: TurnOutcome;
	/** Cumulative session cost/tokens after the turn, or null when unavailable. */
	readonly stats: SessionStats | null;
	/** Operator-facing explanation for every outcome but `completed`. */
	readonly detail: string | null;
}

export interface TurnHooks {
	/** Every session event of the turn, in arrival order. */
	onEvent(event: AgentSessionEvent): void;
	/** Periodic liveness tick carrying the agent's own view of its todos. */
	onHeartbeat?(todos: readonly TodoLine[]): void;
}

export class SessionBusyError extends Error {
	constructor() {
		super("that session is mid-turn");
		this.name = "SessionBusyError";
	}
}

export class SessionLimitError extends Error {
	constructor(limit: number) {
		super(`already running ${limit} agent sessions; end one with !end before starting another`);
		this.name = "SessionLimitError";
	}
}

/** What survives a bot restart: enough to resume, and nothing sensitive. */
interface PersistedSession {
	workspace: string;
	sessionId: string | null;
	createdAt: string;
	lastPromptAt: string;
}

interface PersistedState {
	version: 1;
	threads: Record<string, PersistedSession>;
}

/**
 * A live agent child bound to one Discord thread. Created only by
 * {@link SessionPool}, which owns the process budget and the persisted map.
 */
export class ManagedSession {
	#client: RpcClient;
	#busy = false;
	#disposed = false;
	#sessionId: string | null;
	#abortRequested = false;

	constructor(
		readonly threadId: string,
		readonly workspace: WorkspaceRoot,
		private readonly config: DevbotConfig,
		client: RpcClient,
		sessionId: string | null,
	) {
		this.#client = client;
		this.#sessionId = sessionId;
	}

	get sessionId(): string | null {
		return this.#sessionId;
	}

	get busy(): boolean {
		return this.#busy;
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	/**
	 * Run one turn to settlement. Rejects with {@link SessionBusyError} rather
	 * than queueing, because the caller can steer a running turn instead and a
	 * silent queue is indistinguishable from a hang on a phone screen.
	 */
	async runTurn(text: string, hooks: TurnHooks): Promise<TurnResult> {
		if (this.#disposed) throw new Error("session was already ended");
		if (this.#busy) throw new SessionBusyError();
		this.#busy = true;
		this.#abortRequested = false;

		const settlement = Promise.withResolvers<TurnResult>();
		let settled = false;
		const finish = (outcome: TurnOutcome, detail: string | null): void => {
			if (settled) return;
			settled = true;
			settlement.resolve({ outcome, stats: null, detail });
		};

		const unsubscribe = this.#client.onSessionEvent(event => {
			try {
				hooks.onEvent(event);
			} catch {
				// A renderer fault must not strand the turn; the transcript is
				// cosmetic, settlement is not.
			}
			// A non-terminal `agent_end` means an async delivery will resume the
			// session, so the turn has not actually finished yet.
			if (event.type === "agent_end" && event.isTerminal !== false) {
				finish(this.#abortRequested ? "aborted" : "completed", this.#abortRequested ? "aborted by operator" : null);
			}
		});

		const heartbeat = setInterval(() => {
			void this.#heartbeat(hooks, finish);
		}, HEARTBEAT_INTERVAL_MS);

		const ceiling = setTimeout(() => {
			void this.#client.abort().catch(() => undefined);
			finish("timeout", `turn exceeded CC_DEVBOT_TURN_TIMEOUT_MS (${this.config.turnTimeoutMs}ms)`);
		}, this.config.turnTimeoutMs);

		try {
			await this.#client.prompt(text);
			const result = await settlement.promise;
			const stats = await this.#client.getSessionStats().catch(() => null);
			return { ...result, stats };
		} catch (error) {
			return {
				outcome: "crashed",
				stats: null,
				detail: `${describe(error)}${stderrTail(this.#client)}`,
			};
		} finally {
			clearInterval(heartbeat);
			clearTimeout(ceiling);
			unsubscribe();
			this.#busy = false;
		}
	}

	/** Fold text into the turn already running. */
	async steer(text: string): Promise<void> {
		await this.#client.steer(text);
	}

	async abort(): Promise<void> {
		this.#abortRequested = true;
		await this.#client.abort();
	}

	async state(): Promise<RpcSessionState> {
		return await this.#client.getState();
	}

	async stats(): Promise<SessionStats> {
		return await this.#client.getSessionStats();
	}

	async compact(): Promise<void> {
		await this.#client.compact();
	}

	/**
	 * Resolve a phone-typed model name against the models this install actually
	 * has. In-session model changes need an exact provider/id pair, unlike the
	 * `--model` launch flag which fuzzy-matches for us.
	 */
	async setModel(query: string): Promise<{ provider: string; id: string }> {
		const wanted = query.trim().toLowerCase();
		const models = await this.#client.getAvailableModels();
		const match =
			models.find(model => model.id.toLowerCase() === wanted) ??
			models.find(model => `${model.provider}/${model.id}`.toLowerCase() === wanted) ??
			models.find(model => model.id.toLowerCase().includes(wanted)) ??
			models.find(model => `${model.provider}/${model.id}`.toLowerCase().includes(wanted));
		if (!match) throw new Error(`no installed model matches ${query}`);
		return await this.#client.setModel(match.provider, match.id);
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		await this.#client.stop().catch(() => undefined);
	}

	/** Refresh the cached session id once the child has one to report. */
	async syncSessionId(): Promise<string | null> {
		const state = await withTimeout(this.#client.getState(), COMMAND_TIMEOUT_MS, "get_state");
		this.#sessionId = state.sessionId || null;
		return this.#sessionId;
	}

	async #heartbeat(hooks: TurnHooks, finish: (outcome: TurnOutcome, detail: string | null) => void): Promise<void> {
		try {
			const state = await withTimeout(this.#client.getState(), COMMAND_TIMEOUT_MS, "get_state");
			hooks.onHeartbeat?.(flattenTodos(state));
		} catch (error) {
			// The only way a `get_state` round trip fails is a child that can no
			// longer answer, which is exactly the case an `agent_end` will never
			// arrive for.
			finish("crashed", `agent process stopped answering: ${describe(error)}${stderrTail(this.#client)}`);
		}
	}
}

/**
 * Owns every live agent child, the concurrency budget, the idle reaper, and the
 * thread-to-session map on disk.
 */
export class SessionPool {
	readonly #sessions = new Map<string, ManagedSession>();
	readonly #starting = new Map<string, Promise<ManagedSession>>();
	#state: PersistedState = { version: 1, threads: {} };
	#loaded = false;
	#reaper: Timer | undefined;
	#lastActivity = new Map<string, number>();

	constructor(private readonly config: DevbotConfig) {}

	get size(): number {
		return this.#sessions.size;
	}

	/** Start the idle reaper. Separate from the constructor so tests stay quiet. */
	startReaper(): void {
		this.#reaper ??= setInterval(
			() => {
				void this.#reapIdle();
			},
			Math.max(30_000, Math.floor(this.config.idleTimeoutMs / 4)),
		);
	}

	get(threadId: string): ManagedSession | undefined {
		return this.#sessions.get(threadId);
	}

	/** The workspace a known thread belongs to, even when its child is gone. */
	async knownWorkspace(threadId: string): Promise<string | undefined> {
		await this.#load();
		return this.#state.threads[threadId]?.workspace;
	}

	/**
	 * The session for a thread, starting or restarting an agent child if needed.
	 * Concurrent callers for one thread share a single start.
	 */
	async acquire(threadId: string, workspace: WorkspaceRoot): Promise<ManagedSession> {
		const live = this.#sessions.get(threadId);
		if (live && !live.disposed) {
			this.#lastActivity.set(threadId, Date.now());
			return live;
		}
		const pending = this.#starting.get(threadId);
		if (pending) return await pending;

		if (this.#sessions.size >= this.config.maxSessions) {
			throw new SessionLimitError(this.config.maxSessions);
		}

		const start = this.#start(threadId, workspace);
		this.#starting.set(threadId, start);
		try {
			return await start;
		} finally {
			this.#starting.delete(threadId);
		}
	}

	async release(threadId: string): Promise<void> {
		const session = this.#sessions.get(threadId);
		this.#sessions.delete(threadId);
		this.#lastActivity.delete(threadId);
		await session?.dispose();
	}

	/** Forget a thread entirely, so the next prompt starts a fresh transcript. */
	async forget(threadId: string): Promise<void> {
		await this.release(threadId);
		await this.#load();
		delete this.#state.threads[threadId];
		await this.#persist();
	}

	async touch(threadId: string): Promise<void> {
		this.#lastActivity.set(threadId, Date.now());
		await this.#load();
		const record = this.#state.threads[threadId];
		if (!record) return;
		record.lastPromptAt = new Date().toISOString();
		await this.#persist();
	}

	async shutdown(): Promise<void> {
		clearInterval(this.#reaper);
		this.#reaper = undefined;
		const sessions = Array.from(this.#sessions.values());
		this.#sessions.clear();
		await Promise.allSettled(sessions.map(session => session.dispose()));
	}

	async #start(threadId: string, workspace: WorkspaceRoot): Promise<ManagedSession> {
		await this.#load();
		const known = this.#state.threads[threadId];
		const resumeId = known?.workspace === workspace.name ? known.sessionId : null;

		const args = ["--approval-mode", this.config.approvalMode];
		if (this.config.approvalMode === "yolo") args.push("--auto-approve");
		if (resumeId) args.push("--resume", resumeId);

		const client = new RpcClient({
			command: [...this.config.agentCommand],
			cwd: workspace.path,
			...(this.config.model ? { model: this.config.model } : {}),
			args,
		});
		await client.start();

		const session = new ManagedSession(threadId, workspace, this.config, client, resumeId);
		try {
			await session.syncSessionId();
		} catch (error) {
			await session.dispose();
			throw new Error(`agent started but never reported its session: ${describe(error)}`);
		}

		this.#sessions.set(threadId, session);
		this.#lastActivity.set(threadId, Date.now());
		const now = new Date().toISOString();
		this.#state.threads[threadId] = {
			workspace: workspace.name,
			sessionId: session.sessionId,
			createdAt: known?.createdAt ?? now,
			lastPromptAt: now,
		};
		await this.#persist();
		return session;
	}

	async #reapIdle(): Promise<void> {
		const deadline = Date.now() - this.config.idleTimeoutMs;
		for (const [threadId, session] of this.#sessions) {
			if (session.busy) continue;
			if ((this.#lastActivity.get(threadId) ?? 0) > deadline) continue;
			await this.release(threadId);
		}
	}

	async #load(): Promise<void> {
		if (this.#loaded) return;
		this.#loaded = true;
		try {
			const raw: unknown = JSON.parse(await fs.readFile(this.#statePath(), "utf8"));
			this.#state = { version: 1, threads: parseThreadMap(raw) };
		} catch {
			// A missing or corrupt map is not fatal: the cost is a fresh
			// transcript in an old thread, not a broken bot.
		}
	}

	async #persist(): Promise<void> {
		const target = this.#statePath();
		await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
		const temporary = `${target}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
		await fs.rename(temporary, target);
	}

	#statePath(): string {
		return path.join(this.config.stateDir, "threads.json");
	}
}

/** The agent's own todo view, flattened across phases for a flat chat surface. */
export function flattenTodos(state: RpcSessionState): readonly TodoLine[] {
	const lines: TodoLine[] = [];
	for (const phase of state.todoPhases ?? []) {
		for (const task of phase.tasks ?? []) {
			lines.push({ content: task.content, status: task.status });
		}
	}
	return lines;
}

/**
 * Rebuild the thread map field by field. The file is written by this process but
 * read after an arbitrary restart, possibly across a format change, so nothing
 * is trusted structurally: a record that does not describe a resumable session
 * is dropped rather than resumed into.
 */
function parseThreadMap(raw: unknown): Record<string, PersistedSession> {
	const threads: Record<string, PersistedSession> = {};
	if (!raw || typeof raw !== "object" || !("threads" in raw)) return threads;
	const source = raw.threads;
	if (!source || typeof source !== "object" || Array.isArray(source)) return threads;
	for (const [threadId, value] of Object.entries(source)) {
		if (!/^\d{15,25}$/.test(threadId)) continue;
		if (!value || typeof value !== "object") continue;
		const workspace = "workspace" in value && typeof value.workspace === "string" ? value.workspace : null;
		if (!workspace) continue;
		const sessionId = "sessionId" in value && typeof value.sessionId === "string" ? value.sessionId : null;
		const createdAt = "createdAt" in value && typeof value.createdAt === "string" ? value.createdAt : "";
		const lastPromptAt = "lastPromptAt" in value && typeof value.lastPromptAt === "string" ? value.lastPromptAt : "";
		threads[threadId] = { workspace, sessionId, createdAt, lastPromptAt };
	}
	return threads;
}

async function withTimeout<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
	let timer: Timer | undefined;
	const expiry = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} did not answer within ${milliseconds}ms`)), milliseconds);
	});
	try {
		return await Promise.race([work, expiry]);
	} finally {
		clearTimeout(timer);
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The child's stderr tail is the only diagnosis available for a spawn or auth
 * failure, and it is worth a Discord message. Bounded because a crash loop can
 * produce far more than Discord will accept.
 */
function stderrTail(client: RpcClient): string {
	const stderr = client.getStderr().trim();
	if (!stderr) return "";
	const tail = stderr.length > 600 ? `…${stderr.slice(-600)}` : stderr;
	return `\n\`\`\`\n${tail}\n\`\`\``;
}
