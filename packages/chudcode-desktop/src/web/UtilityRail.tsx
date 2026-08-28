import type { SessionClient, SessionSnapshot } from "@oh-my-pi/collab-web/session-client";
import { Check, Circle, CircleDot, Copy, ListTodo, Pin, PinOff, Plus, Settings, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { DesktopMethod, DesktopRequestMap, DesktopSessionInfo } from "../protocol";

export type UtilityRoute = "sessions" | "tasks" | "settings-basic" | "settings-advanced";

type RequestClient = SessionClient & {
	request<M extends DesktopMethod>(
		method: M,
		params: DesktopRequestMap[M]["params"],
	): Promise<DesktopRequestMap[M]["result"]>;
};

interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned";
	phase: string;
}

export interface UtilityRailProps {
	client: RequestClient;
	snapshot: SessionSnapshot;
	sessions: readonly DesktopSessionInfo[];
	route: UtilityRoute;
	onRouteChange(route: UtilityRoute): void;
	onResetLayout(): void;
}

function readTodoItems(snapshot: SessionSnapshot): TodoItem[] {
	for (let index = snapshot.entries.length - 1; index >= 0; index -= 1) {
		const entry = snapshot.entries[index];
		if (entry?.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo")
			continue;
		const details = entry.message.details;
		if (
			entry.message.isError ||
			typeof details !== "object" ||
			details === null ||
			!("phases" in details) ||
			!Array.isArray(details.phases)
		)
			continue;
		const items: TodoItem[] = [];
		for (const phaseValue of details.phases) {
			if (
				typeof phaseValue !== "object" ||
				phaseValue === null ||
				!("tasks" in phaseValue) ||
				!Array.isArray(phaseValue.tasks)
			)
				continue;
			const phase = "name" in phaseValue && typeof phaseValue.name === "string" ? phaseValue.name : "Tasks";
			for (const taskValue of phaseValue.tasks) {
				if (
					typeof taskValue !== "object" ||
					taskValue === null ||
					!("content" in taskValue) ||
					typeof taskValue.content !== "string"
				)
					continue;
				const rawStatus = "status" in taskValue ? taskValue.status : undefined;
				const status =
					rawStatus === "in_progress" || rawStatus === "completed" || rawStatus === "abandoned"
						? rawStatus
						: "pending";
				items.push({ content: taskValue.content, status, phase });
			}
		}
		return items;
	}
	return [];
}

function sessionLabel(session: DesktopSessionInfo): string {
	return session.title?.trim() || session.path.split(/[\\/]/).pop() || session.id;
}

function relativeTime(timestamp: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function UtilityTabs({ route, onRouteChange }: Pick<UtilityRailProps, "route" | "onRouteChange">): ReactNode {
	const settingsActive = route === "settings-basic" || route === "settings-advanced";
	return (
		<nav className="utility-tabs" aria-label="Utility views">
			<button
				type="button"
				className={route === "sessions" ? "utility-tab is-active" : "utility-tab"}
				aria-current={route === "sessions" ? "page" : undefined}
				onClick={() => onRouteChange("sessions")}
			>
				<CircleDot size={14} aria-hidden /> Sessions
			</button>
			<button
				type="button"
				className={route === "tasks" ? "utility-tab is-active" : "utility-tab"}
				aria-current={route === "tasks" ? "page" : undefined}
				onClick={() => onRouteChange("tasks")}
			>
				<ListTodo size={14} aria-hidden /> Tasks
			</button>
			<button
				type="button"
				className={settingsActive ? "utility-tab is-active" : "utility-tab"}
				aria-current={settingsActive ? "page" : undefined}
				onClick={() => onRouteChange("settings-basic")}
			>
				<Settings size={14} aria-hidden /> Settings
			</button>
		</nav>
	);
}

function SessionsView({
	client,
	snapshot,
	sessions,
}: Pick<UtilityRailProps, "client" | "snapshot" | "sessions">): ReactNode {
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const selected = sessions.find(session => session.id === snapshot.header?.id) ?? null;
	const cwd = snapshot.header?.cwd ?? snapshot.state?.cwd ?? sessions[0]?.cwd;

	const run = async (key: string, action: () => Promise<void>): Promise<void> => {
		if (pending !== null) return;
		setPending(key);
		setError(null);
		try {
			await action();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setPending(null);
		}
	};

	const select = (path: string): void => {
		void run(`select:${path}`, async () => {
			await client.request("session.select", { path });
		});
	};

	const createSession = (): void => {
		if (!cwd) return;
		void run("new", async () => {
			const result = await client.request("session.new", { cwd });
			await client.request("session.select", { path: result.session.path });
		});
	};

	const forkSession = (): void => {
		if (!selected) return;
		void run("fork", async () => {
			const result = await client.request("session.fork", { path: selected.path });
			if (!result.cancelled) await client.request("session.select", { path: result.session.path });
		});
	};

	const renameSession = (session: DesktopSessionInfo): void => {
		const title = window.prompt("Rename session", sessionLabel(session))?.trim();
		if (!title || title === session.title) return;
		void run(`rename:${session.path}`, async () => {
			await client.request("session.rename", { path: session.path, title });
		});
	};

	const deleteSession = (session: DesktopSessionInfo): void => {
		if (!window.confirm(`Delete “${sessionLabel(session)}”? This cannot be undone.`)) return;
		void run(`delete:${session.path}`, async () => {
			await client.request("session.delete", { path: session.path });
		});
	};

	const pinSession = (session: DesktopSessionInfo): void => {
		void run(`pin:${session.path}`, async () => {
			await client.request("session.pin", { path: session.path, pinned: !session.pinned });
		});
	};

	return (
		<section className="utility-view" aria-labelledby="sessions-title">
			<header className="utility-view-header">
				<div>
					<h2 id="sessions-title">Sessions</h2>
					<span>{sessions.length} local</span>
				</div>
				<div className="utility-view-actions">
					<button
						type="button"
						onClick={forkSession}
						disabled={!selected || pending !== null}
						title="Fork selected session"
					>
						<Copy size={14} aria-hidden />
						<span className="sr-only">Fork selected session</span>
					</button>
					<button type="button" onClick={createSession} disabled={!cwd || pending !== null} title="New session">
						<Plus size={15} aria-hidden />
						<span className="sr-only">New session</span>
					</button>
				</div>
			</header>
			{error !== null ? (
				<div className="utility-error" role="alert">
					{error}
				</div>
			) : null}
			{sessions.length === 0 ? (
				<div className="surface-state" role="status">
					<strong>No sessions</strong>
					<span>{cwd ? "Create one for this workspace." : "Open a workspace to create a session."}</span>
				</div>
			) : (
				<ul className="session-list" aria-label="Local sessions">
					{sessions.map(session => {
						const active = session.id === snapshot.header?.id;
						const busy = pending?.endsWith(session.path) ?? false;
						return (
							<li key={session.path} className={active ? "session-row is-active" : "session-row"}>
								<button
									type="button"
									className="session-select"
									onClick={() => select(session.path)}
									disabled={pending !== null}
									aria-current={active ? "true" : undefined}
								>
									<span
										className={`session-status session-status-${session.status ?? "completed"}`}
										aria-hidden
									/>
									<span className="session-copy">
										<strong>{sessionLabel(session)}</strong>
										<span>
											{session.messageCount} messages · {relativeTime(session.modifiedMs)}
										</span>
									</span>
								</button>
								<div className="session-actions" aria-label={`Actions for ${sessionLabel(session)}`}>
									<button
										type="button"
										onClick={() => pinSession(session)}
										disabled={busy}
										title={session.pinned ? "Unpin" : "Pin"}
									>
										{session.pinned ? <PinOff size={12} aria-hidden /> : <Pin size={12} aria-hidden />}
									</button>
									<button type="button" onClick={() => renameSession(session)} disabled={busy} title="Rename">
										<span aria-hidden>ab</span>
										<span className="sr-only">Rename</span>
									</button>
									<button type="button" onClick={() => deleteSession(session)} disabled={busy} title="Delete">
										<Trash2 size={12} aria-hidden />
									</button>
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}

function TasksView({ snapshot }: Pick<UtilityRailProps, "snapshot">): ReactNode {
	const tasks = useMemo(() => readTodoItems(snapshot), [snapshot]);
	const completed = tasks.filter(task => task.status === "completed").length;
	return (
		<section className="utility-view" aria-labelledby="tasks-title">
			<header className="utility-view-header">
				<div>
					<h2 id="tasks-title">Tasks</h2>
					<span>
						{completed}/{tasks.length} complete
					</span>
				</div>
			</header>
			{tasks.length === 0 ? (
				<div className="surface-state" role="status">
					<strong>No task board</strong>
					<span>Todo entries from the active session appear here.</span>
				</div>
			) : (
				<ul className="todo-list">
					{tasks.map((task, index) => (
						<li key={`${task.phase}:${task.content}:${index}`} className={`todo-item todo-item-${task.status}`}>
							<span className="todo-state" aria-label={task.status.replace("_", " ")}>
								{task.status === "completed" ? (
									<Check size={13} />
								) : task.status === "in_progress" ? (
									<CircleDot size={13} />
								) : (
									<Circle size={13} />
								)}
							</span>
							<span>
								<small>{task.phase}</small>
								{task.content}
							</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function SettingsView({
	route,
	onRouteChange,
	onResetLayout,
}: Pick<UtilityRailProps, "route" | "onRouteChange" | "onResetLayout">): ReactNode {
	const advanced = route === "settings-advanced";
	return (
		<section className="utility-view" aria-labelledby="settings-title">
			<header className="utility-view-header">
				<div>
					<h2 id="settings-title">Settings</h2>
					<span>local UI</span>
				</div>
			</header>
			<div className="settings-route" role="tablist" aria-label="Settings sections">
				<button type="button" role="tab" aria-selected={!advanced} onClick={() => onRouteChange("settings-basic")}>
					Basic
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={advanced}
					onClick={() => onRouteChange("settings-advanced")}
				>
					Advanced
				</button>
			</div>
			{advanced ? (
				<div className="settings-panel" role="tabpanel">
					<h3>Layout</h3>
					<p>Panel visibility and resized widths are stored only in this browser.</p>
					<button type="button" className="utility-action" onClick={onResetLayout}>
						Reset saved layout
					</button>
					<h3>Privacy</h3>
					<p>Desktop services use the loopback connection. Source text is not sent to third-party services.</p>
				</div>
			) : (
				<div className="settings-panel" role="tabpanel">
					<h3>Appearance</h3>
					<p>Use the theme control in the header. System reduced-motion preferences are honored automatically.</p>
					<h3>Keyboard</h3>
					<dl>
						<dt>Ctrl+B</dt>
						<dd>Primary sidebar</dd>
						<dt>Ctrl+Alt+B</dt>
						<dd>Secondary sidebar</dd>
						<dt>Ctrl+1</dt>
						<dd>Editor</dd>
					</dl>
				</div>
			)}
		</section>
	);
}

export function UtilityRail(props: UtilityRailProps): ReactNode {
	return (
		<div className="utility-rail">
			<UtilityTabs route={props.route} onRouteChange={props.onRouteChange} />
			{props.route === "sessions" ? (
				<SessionsView client={props.client} snapshot={props.snapshot} sessions={props.sessions} />
			) : null}
			{props.route === "tasks" ? <TasksView snapshot={props.snapshot} /> : null}
			{props.route === "settings-basic" || props.route === "settings-advanced" ? (
				<SettingsView route={props.route} onRouteChange={props.onRouteChange} onResetLayout={props.onResetLayout} />
			) : null}
		</div>
	);
}
