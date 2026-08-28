import { ChevronDown, FolderOpen } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RecentProject, WorkspaceDescriptor } from "../protocol";
import type { DesktopClient } from "./desktop-client";

const PROJECT_CHORD_TIMEOUT_MS = 1_500;

export interface ProjectSwitcherProps {
	client: DesktopClient;
	workspace?: WorkspaceDescriptor;
	fallbackPath?: string;
	onWorkspaceOpen(workspace: WorkspaceDescriptor): void;
	onError?(message: string): void;
}

/** Prominent workspace control. The full path remains visible rather than being buried in a menu. */
export function ProjectSwitcher({
	client,
	workspace,
	fallbackPath,
	onWorkspaceOpen,
	onError,
}: ProjectSwitcherProps): ReactNode {
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [recentProjects, setRecentProjects] = useState<readonly RecentProject[]>([]);
	const [error, setError] = useState<string | null>(null);
	const chordPendingRef = useRef(false);
	const chordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const currentPath = workspace?.rootPath ?? fallbackPath;
	const currentName =
		workspace?.displayName ??
		(currentPath
			? currentPath
					.replace(/[\\/]+$/, "")
					.split(/[\\/]/)
					.at(-1) || currentPath
			: "Open a project");

	const reportError = useCallback(
		(cause: unknown): void => {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			onError?.(message);
		},
		[onError],
	);

	const refreshRecent = useCallback(async (): Promise<void> => {
		try {
			const result = await client.request("workspace.recent", {});
			setRecentProjects(result.projects);
			setError(null);
		} catch (cause) {
			reportError(cause);
		}
	}, [client, reportError]);

	useEffect(() => {
		void refreshRecent();
	}, [refreshRecent]);

	useEffect(() => {
		const clearChord = (): void => {
			chordPendingRef.current = false;
			if (chordTimerRef.current !== null) clearTimeout(chordTimerRef.current);
			chordTimerRef.current = null;
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.isComposing || event.altKey) return;
			const command = event.ctrlKey || event.metaKey;
			if (command && !event.shiftKey && event.key.toLowerCase() === "k") {
				event.preventDefault();
				clearChord();
				chordPendingRef.current = true;
				chordTimerRef.current = setTimeout(clearChord, PROJECT_CHORD_TIMEOUT_MS);
				return;
			}
			if (
				chordPendingRef.current &&
				!event.ctrlKey &&
				!event.metaKey &&
				!event.shiftKey &&
				event.key.toLowerCase() === "p"
			) {
				event.preventDefault();
				clearChord();
				setOpen(true);
				void refreshRecent();
				return;
			}
			if (chordPendingRef.current && !["Control", "Meta", "Shift"].includes(event.key)) clearChord();
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			clearChord();
		};
	}, [refreshRecent]);

	const openWorkspace = useCallback(
		async (rootPath: string): Promise<void> => {
			setLoading(true);
			try {
				const result = await client.request("workspace.open", { rootPath });
				onWorkspaceOpen(result.workspace);
				setOpen(false);
				setError(null);
				void refreshRecent();
			} catch (cause) {
				reportError(cause);
			} finally {
				setLoading(false);
			}
		},
		[client, onWorkspaceOpen, refreshRecent, reportError],
	);

	const pickWorkspace = useCallback(async (): Promise<void> => {
		setLoading(true);
		try {
			const picked = await client.request("workspace.pick", currentPath ? { initialPath: currentPath } : {});
			if (!picked.cancelled && picked.rootPath) await openWorkspace(picked.rootPath);
		} catch (cause) {
			reportError(cause);
		} finally {
			setLoading(false);
		}
	}, [client, currentPath, openWorkspace, reportError]);

	return (
		<div className="project-switcher">
			<button
				type="button"
				className="project-switcher-current"
				aria-label="Switch project"
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
				title="Switch project (Ctrl/Cmd+K, then P)"
			>
				<FolderOpen size={16} strokeWidth={1.8} aria-hidden />
				<span className="project-switcher-copy">
					<strong>{currentName}</strong>
					<span className="project-switcher-path" title={currentPath}>
						{currentPath ?? "Choose a folder to begin"}
					</span>
				</span>
				<ChevronDown size={14} strokeWidth={1.8} aria-hidden />
			</button>
			{open ? (
				<section className="project-switcher-menu" role="dialog" aria-label="Projects">
					<header>
						<strong>Projects</strong>
						<kbd>Ctrl/Cmd+K P</kbd>
					</header>
					<button
						type="button"
						className="project-open-folder"
						onClick={() => void pickWorkspace()}
						disabled={loading}
					>
						<FolderOpen size={15} aria-hidden /> Open Folder…
					</button>
					<div className="project-recent-heading">Recent projects</div>
					<ul className="project-recent-list">
						{recentProjects.map(project => (
							<li key={project.rootPath}>
								<button
									type="button"
									title={project.rootPath}
									onClick={() => void openWorkspace(project.rootPath)}
									disabled={loading}
								>
									<strong>{project.displayName}</strong>
									<span>{project.rootPath}</span>
								</button>
							</li>
						))}
						{recentProjects.length === 0 ? <li className="project-recent-empty">No recent projects</li> : null}
					</ul>
					{error ? (
						<div className="project-switcher-error" role="alert">
							{error}
						</div>
					) : null}
				</section>
			) : null}
		</div>
	);
}
