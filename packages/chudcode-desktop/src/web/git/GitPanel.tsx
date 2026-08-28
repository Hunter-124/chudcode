import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitBranch, GitFileState, GitRemote, GitSnapshot, WorkspaceId } from "../../protocol";
import type { DesktopClient } from "../desktop-client";
import type { DesktopStoreSnapshot } from "../desktop-store";
import { selectGit, useDesktop } from "../use-desktop";
import { DiffView, type HunkActionRequest } from "./DiffView";

export interface GitPanelProps {
	client: DesktopClient;
	workspaceId: WorkspaceId;
	onOpenGraph?: (kind: "git") => void;
}

export interface GitFileGroups {
	conflicts: GitFileState[];
	staged: GitFileState[];
	changes: GitFileState[];
	untracked: GitFileState[];
}

interface SelectedDiff {
	path: string;
	staged: boolean;
}

export function groupGitFiles(files: readonly GitFileState[]): GitFileGroups {
	const conflicts: GitFileState[] = [];
	const staged: GitFileState[] = [];
	const changes: GitFileState[] = [];
	const untracked: GitFileState[] = [];
	for (const file of files) {
		const conflicted = file.staged === "unmerged" || file.unstaged === "unmerged";
		if (conflicted) conflicts.push(file);
		else if (file.untracked) untracked.push(file);
		else {
			if (file.staged.length > 0) staged.push(file);
			if (file.unstaged.length > 0) changes.push(file);
		}
	}
	const byPath = (left: GitFileState, right: GitFileState) => left.path.localeCompare(right.path);
	conflicts.sort(byPath);
	staged.sort(byPath);
	changes.sort(byPath);
	untracked.sort(byPath);
	return { conflicts, staged, changes, untracked };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "The desktop Git service returned an unknown error.";
}

function statusLabel(file: GitFileState, staged: boolean): string {
	if (file.untracked) return "U";
	const status = staged ? file.staged : file.unstaged;
	return status === "type-changed" ? "T" : status.slice(0, 1).toUpperCase();
}

function GitFileGroup({
	title,
	files,
	staged,
	busy,
	selected,
	onSelect,
	onAction,
	actionLabel,
}: {
	title: string;
	files: readonly GitFileState[];
	staged: boolean;
	busy: boolean;
	selected: SelectedDiff | null;
	onSelect(file: GitFileState, staged: boolean): void;
	onAction(path: string): void;
	actionLabel: "Stage" | "Unstage";
}) {
	if (files.length === 0) return null;
	return (
		<section className="git-file-group" aria-labelledby={`git-group-${title.toLowerCase().replaceAll(" ", "-")}`}>
			<header className="git-section-header">
				<h3 id={`git-group-${title.toLowerCase().replaceAll(" ", "-")}`}>{title}</h3>
				<span>{files.length}</span>
			</header>
			<ul className="git-file-list">
				{files.map(file => {
					const active = selected?.path === file.path && selected.staged === staged;
					return (
						<li
							className={active ? "git-file-row git-file-row--selected" : "git-file-row"}
							key={`${staged ? "s" : "w"}:${file.path}`}
						>
							<button
								type="button"
								className="git-file-row__path"
								aria-pressed={active}
								onClick={() => onSelect(file, staged)}
							>
								<span className="git-status-mark" aria-label={staged ? file.staged : file.unstaged}>
									{statusLabel(file, staged)}
								</span>
								<span title={file.path}>{file.path}</span>
							</button>
							<button
								type="button"
								className="git-file-row__action"
								disabled={busy}
								aria-label={`${actionLabel} ${file.path}`}
								onClick={() => onAction(file.path)}
							>
								{actionLabel}
							</button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

export function GitPanel({ client, workspaceId, onOpenGraph }: GitPanelProps) {
	const selectWorkspaceGit = useCallback(
		(store: DesktopStoreSnapshot) => selectGit(store, workspaceId),
		[workspaceId],
	);
	const liveSnapshot = useDesktop(client, selectWorkspaceGit);
	const [fallbackSnapshot, setFallbackSnapshot] = useState<GitSnapshot | null>(null);
	const snapshot = fallbackSnapshot ?? liveSnapshot;
	const [branches, setBranches] = useState<readonly GitBranch[]>([]);
	const [remotes, setRemotes] = useState<readonly GitRemote[]>([]);
	const [selectedRemote, setSelectedRemote] = useState("");
	const [selectedDiff, setSelectedDiff] = useState<SelectedDiff | null>(null);
	const [unified, setUnified] = useState("");
	const [diffRevision, setDiffRevision] = useState(0);
	const [diffError, setDiffError] = useState<string | null>(null);
	const [commitMessage, setCommitMessage] = useState("");
	const [branchName, setBranchName] = useState("");
	const [checkoutNewBranch, setCheckoutNewBranch] = useState(true);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (liveSnapshot) setFallbackSnapshot(liveSnapshot);
	}, [liveSnapshot]);

	const groups = useMemo(() => groupGitFiles(snapshot?.files ?? []), [snapshot?.files]);
	const dirtyCount = snapshot?.files.length ?? 0;
	const stagedCount = groups.staged.length;
	const conflictCount = groups.conflicts.length;

	const load = useCallback(async (): Promise<void> => {
		setLoading(true);
		setError(null);
		try {
			const [snapshotResult, branchResult, remoteResult] = await Promise.all([
				client.request("git.snapshot", { workspaceId }),
				client.request("git.branches", { workspaceId }),
				client.request("git.remotes", { workspaceId }),
			]);
			setFallbackSnapshot(snapshotResult.snapshot);
			setBranches(branchResult.branches);
			setRemotes(remoteResult.remotes);
			setSelectedRemote(current => current || remoteResult.remotes[0]?.name || "");
		} catch (requestError) {
			setError(errorMessage(requestError));
		} finally {
			setLoading(false);
		}
	}, [client, workspaceId]);

	useEffect(() => {
		setFallbackSnapshot(null);
		setSelectedDiff(null);
		setUnified("");
		void load();
	}, [load]);

	const loadDiff = useCallback(
		async (selection: SelectedDiff): Promise<void> => {
			setSelectedDiff(selection);
			setDiffError(null);
			try {
				const result = await client.request("git.diff", {
					workspaceId,
					path: selection.path,
					staged: selection.staged,
				});
				setUnified(result.unified);
				setDiffRevision(value => value + 1);
			} catch (requestError) {
				setUnified("");
				setDiffError(errorMessage(requestError));
			}
		},
		[client, workspaceId],
	);

	async function runSnapshotAction(label: string, request: () => Promise<{ snapshot: GitSnapshot }>): Promise<void> {
		setBusy(label);
		setError(null);
		try {
			const result = await request();
			setFallbackSnapshot(result.snapshot);
			if (selectedDiff) await loadDiff(selectedDiff);
		} catch (requestError) {
			setError(errorMessage(requestError));
		} finally {
			setBusy(null);
		}
	}

	function stage(paths: string[]): void {
		void runSnapshotAction(paths.length === 0 ? "stage-all" : `stage:${paths[0]}`, () =>
			client.request("git.stage", { workspaceId, paths }),
		);
	}

	function unstage(paths: string[]): void {
		void runSnapshotAction(paths.length === 0 ? "unstage-all" : `unstage:${paths[0]}`, () =>
			client.request("git.unstage", { workspaceId, paths }),
		);
	}

	async function commit(): Promise<void> {
		const message = commitMessage.trim();
		if (message.length === 0 || stagedCount === 0 || conflictCount > 0) return;
		setBusy("commit");
		setError(null);
		try {
			const result = await client.request("git.commit", { workspaceId, message });
			setFallbackSnapshot(result.snapshot);
			setCommitMessage("");
			if (selectedDiff?.staged) await loadDiff(selectedDiff);
		} catch (requestError) {
			setError(errorMessage(requestError));
		} finally {
			setBusy(null);
		}
	}

	async function createBranch(): Promise<void> {
		const name = branchName.trim();
		if (!name) return;
		await runSnapshotAction("branch-create", async () => {
			const result = await client.request("git.branch.create", {
				workspaceId,
				name,
				checkout: checkoutNewBranch,
			});
			const branchResult = await client.request("git.branches", { workspaceId });
			setBranches(branchResult.branches);
			setBranchName("");
			return result;
		});
	}

	async function checkout(ref: string): Promise<void> {
		await runSnapshotAction(`checkout:${ref}`, async () => {
			const result = await client.request("git.checkout", { workspaceId, ref });
			const branchResult = await client.request("git.branches", { workspaceId });
			setBranches(branchResult.branches);
			return result;
		});
	}

	async function hunkAction(request: HunkActionRequest): Promise<void> {
		setBusy(`hunk:${request.hunkId}`);
		setError(null);
		try {
			const result = await client.request("git.hunk", { workspaceId, ...request });
			setFallbackSnapshot(result.snapshot);
			if (selectedDiff) await loadDiff(selectedDiff);
		} catch (requestError) {
			const message = errorMessage(requestError);
			setError(message);
			throw new Error(message);
		} finally {
			setBusy(null);
		}
	}

	async function initializeRepository(): Promise<void> {
		await runSnapshotAction("init", () => client.request("git.init", { workspaceId }));
		await load();
	}

	const commitDisabledReason =
		commitMessage.trim().length === 0
			? "Enter a commit message."
			: conflictCount > 0
				? "Resolve working-tree conflicts before committing."
				: stagedCount === 0
					? "Stage at least one change before committing."
					: null;
	const remoteParams = selectedRemote ? { workspaceId, remote: selectedRemote } : { workspaceId };

	if (loading && (snapshot === null || snapshot === undefined)) {
		return (
			<section className="git-panel git-state git-state--loading" aria-busy="true">
				<strong>Loading Source Control</strong>
				<span>Waiting for the local Git service.</span>
			</section>
		);
	}
	if (error && (snapshot === null || snapshot === undefined)) {
		return (
			<section className="git-panel git-state git-state--error" role="alert">
				<strong>Source Control unavailable</strong>
				<span>Local Git service: {error}</span>
				<div className="git-state__actions">
					<button type="button" onClick={() => void load()}>
						Retry
					</button>
					<button type="button" onClick={() => void initializeRepository()}>
						Initialize repository
					</button>
				</div>
			</section>
		);
	}

	return (
		<section className="git-panel" aria-label="Source Control">
			<header className="git-panel__titlebar">
				<div>
					<h2>Source Control</h2>
					<p>
						{snapshot?.branch || "Detached HEAD"}
						{snapshot?.upstream ? ` · ${snapshot.upstream}` : ""}
					</p>
				</div>
				<div className="git-toolbar">
					{onOpenGraph && (
						<button type="button" onClick={() => onOpenGraph("git")}>
							Open commit graph
						</button>
					)}
					<button type="button" disabled={busy !== null} onClick={() => void load()}>
						Refresh
					</button>
				</div>
			</header>

			{error && snapshot && (
				<div className="git-inline-error" role="alert">
					<strong>Git operation failed:</strong> {error}
				</div>
			)}
			{conflictCount > 0 && (
				<div className="git-conflict-warning" role="alert">
					<strong>
						{conflictCount} unresolved {conflictCount === 1 ? "conflict" : "conflicts"}
					</strong>
					<span>
						Resolve both sides, then stage the files. Pull, checkout, and commit are disabled until the working
						tree is resolved.
					</span>
				</div>
			)}
			{conflictCount === 0 && dirtyCount > 0 && (
				<div className="git-working-warning" role="note">
					The working tree has {dirtyCount} changed {dirtyCount === 1 ? "file" : "files"}. Branch checkout or pull
					may be refused if changes overlap.
				</div>
			)}

			<div className="git-panel__body">
				<aside className="git-changes" aria-label="Working tree changes">
					<section className="git-commit-box">
						<label htmlFor={`git-commit-${workspaceId}`}>Commit message</label>
						<textarea
							id={`git-commit-${workspaceId}`}
							value={commitMessage}
							onChange={event => setCommitMessage(event.target.value)}
							placeholder="Describe the staged changes"
							rows={3}
						/>
						<button
							type="button"
							disabled={busy !== null || commitDisabledReason !== null}
							title={commitDisabledReason ?? undefined}
							onClick={() => void commit()}
						>
							Commit{" "}
							{stagedCount > 0 ? `${stagedCount} ${stagedCount === 1 ? "file" : "files"}` : "staged changes"}
						</button>
					</section>

					{snapshot && snapshot.files.length === 0 ? (
						<div className="git-state git-state--empty">
							<strong>Working tree clean</strong>
							<span>There are no staged or unstaged changes.</span>
						</div>
					) : (
						<>
							<GitFileGroup
								title="Conflicts"
								files={groups.conflicts}
								staged={false}
								busy={busy !== null}
								selected={selectedDiff}
								onSelect={(file, staged) => void loadDiff({ path: file.path, staged })}
								onAction={path => stage([path])}
								actionLabel="Stage"
							/>
							{groups.staged.length > 0 && (
								<button
									type="button"
									className="git-group-action"
									disabled={busy !== null}
									onClick={() => unstage([])}
								>
									Unstage all
								</button>
							)}
							<GitFileGroup
								title="Staged Changes"
								files={groups.staged}
								staged={true}
								busy={busy !== null}
								selected={selectedDiff}
								onSelect={(file, staged) => void loadDiff({ path: file.path, staged })}
								onAction={path => unstage([path])}
								actionLabel="Unstage"
							/>
							{groups.changes.length + groups.untracked.length > 0 && (
								<button
									type="button"
									className="git-group-action"
									disabled={busy !== null}
									onClick={() => stage([])}
								>
									Stage all
								</button>
							)}
							<GitFileGroup
								title="Changes"
								files={groups.changes}
								staged={false}
								busy={busy !== null}
								selected={selectedDiff}
								onSelect={(file, staged) => void loadDiff({ path: file.path, staged })}
								onAction={path => stage([path])}
								actionLabel="Stage"
							/>
							<GitFileGroup
								title="Untracked"
								files={groups.untracked}
								staged={false}
								busy={busy !== null}
								selected={selectedDiff}
								onSelect={(file, staged) => void loadDiff({ path: file.path, staged })}
								onAction={path => stage([path])}
								actionLabel="Stage"
							/>
						</>
					)}
				</aside>

				<main className="git-diff-pane" aria-label="Selected file diff">
					<header className="git-section-header">
						<h3>{selectedDiff?.path ?? "Diff"}</h3>
						{selectedDiff && <span>{selectedDiff.staged ? "staged" : "working tree"}</span>}
					</header>
					{selectedDiff ? (
						groups.untracked.some(file => file.path === selectedDiff.path) &&
						unified.length === 0 &&
						!diffError ? (
							<div className="git-state git-state--empty">
								<strong>Untracked file</strong>
								<span>Stage this file before asking Git for a textual diff.</span>
							</div>
						) : (
							<DiffView
								unified={unified}
								path={selectedDiff.path}
								staged={selectedDiff.staged}
								revision={diffRevision}
								busy={busy !== null}
								error={diffError}
								hunkActionsAvailable={!groups.conflicts.some(file => file.path === selectedDiff.path)}
								onHunkAction={hunkAction}
							/>
						)
					) : (
						<div className="git-state git-state--empty">
							<strong>Select a changed file</strong>
							<span>Its parsed unified diff and safe hunk actions will appear here.</span>
						</div>
					)}
				</main>
			</div>

			<div className="git-repository-sections">
				<section className="git-repository-card">
					<header className="git-section-header">
						<h3>Branches</h3>
						<span>{branches.length}</span>
					</header>
					<div className="git-branch-create">
						<label htmlFor={`git-branch-${workspaceId}`}>New branch</label>
						<input
							id={`git-branch-${workspaceId}`}
							value={branchName}
							onChange={event => setBranchName(event.target.value)}
							placeholder="feature/name"
						/>
						<label className="git-check">
							<input
								type="checkbox"
								checked={checkoutNewBranch}
								onChange={event => setCheckoutNewBranch(event.target.checked)}
							/>{" "}
							Check out after creating
						</label>
						<button
							type="button"
							disabled={busy !== null || branchName.trim().length === 0 || conflictCount > 0}
							onClick={() => void createBranch()}
						>
							Create branch
						</button>
					</div>
					<ul className="git-branch-list">
						{branches.map(branch => (
							<li key={`${branch.remote ? "remote" : "local"}:${branch.name}`}>
								<div>
									<strong>{branch.name}</strong>
									<span>
										{branch.current ? "current" : branch.remote ? "remote" : (branch.upstream ?? "local")}
									</span>
								</div>
								{branch.ahead || branch.behind ? (
									<span className="git-ahead-behind">
										↑{branch.ahead ?? 0} ↓{branch.behind ?? 0}
									</span>
								) : null}
								<button
									type="button"
									disabled={busy !== null || branch.current || conflictCount > 0}
									onClick={() => void checkout(branch.name)}
								>
									Checkout
								</button>
							</li>
						))}
					</ul>
				</section>

				<section className="git-repository-card">
					<header className="git-section-header">
						<h3>Remotes</h3>
						<span>{remotes.length}</span>
					</header>
					{remotes.length === 0 ? (
						<div className="git-state git-state--empty">
							<strong>No remotes</strong>
							<span>Add a remote with Git before fetching, pulling, or pushing.</span>
						</div>
					) : (
						<>
							<label htmlFor={`git-remote-${workspaceId}`}>Active remote</label>
							<select
								id={`git-remote-${workspaceId}`}
								value={selectedRemote}
								onChange={event => setSelectedRemote(event.target.value)}
							>
								{remotes.map(remote => (
									<option key={remote.name} value={remote.name}>
										{remote.name}
									</option>
								))}
							</select>
							<div className="git-remote-actions">
								<button
									type="button"
									disabled={busy !== null}
									onClick={() =>
										void runSnapshotAction("fetch", () => client.request("git.fetch", remoteParams))
									}
								>
									Fetch
								</button>
								<button
									type="button"
									disabled={busy !== null || conflictCount > 0}
									onClick={() =>
										void runSnapshotAction("pull", () => client.request("git.pull", remoteParams))
									}
								>
									Pull
								</button>
								<button
									type="button"
									disabled={busy !== null}
									onClick={() =>
										void runSnapshotAction("push", () =>
											client.request(
												"git.push",
												snapshot?.upstream
													? remoteParams
													: { ...remoteParams, branch: snapshot?.branch, setUpstream: true },
											),
										)
									}
								>
									Push
								</button>
							</div>
							<ul className="git-remote-list">
								{remotes.map(remote => (
									<li key={remote.name}>
										<strong>{remote.name}</strong>
										<span>
											fetch <code>{remote.fetchUrl}</code>
										</span>
										<span>
											push <code>{remote.pushUrl}</code>
										</span>
									</li>
								))}
							</ul>
						</>
					)}
				</section>

				<section className="git-repository-card git-history-card">
					<header className="git-section-header">
						<h3>History</h3>
						<span>{snapshot?.commits.length ?? 0}</span>
					</header>
					{snapshot?.commits.length ? (
						<ol className="git-history">
							{snapshot.commits.map(commit => (
								<li key={commit.hash}>
									<span className="git-history__node" aria-hidden="true" />
									<div>
										<strong>{commit.subject}</strong>
										<span>
											{commit.author} · {new Date(commit.timestampMs).toLocaleString()}
										</span>
									</div>
									<code title={commit.hash}>{commit.hash.slice(0, 8)}</code>
									{commit.refs.length > 0 && (
										<div className="git-history__refs">
											{commit.refs.map(ref => (
												<span key={ref}>{ref}</span>
											))}
										</div>
									)}
								</li>
							))}
						</ol>
					) : (
						<div className="git-state git-state--empty">
							<strong>No commits</strong>
							<span>Commit staged changes to begin repository history.</span>
						</div>
					)}
				</section>
			</div>
		</section>
	);
}
