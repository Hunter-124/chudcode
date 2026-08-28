import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	type DiffFile,
	type DiffHunk,
	type DiffLine,
	parseUnifiedDiff,
	type UnifiedDiff,
} from "../../services/git-diff";
import "./git.css";

export type HunkAction = "stage" | "unstage" | "revert";

export interface HunkActionRequest {
	path: string;
	hunkId: string;
	action: HunkAction;
}

export interface DiffViewProps {
	unified: string;
	path?: string;
	staged?: boolean;
	revision?: number;
	busy?: boolean;
	error?: string | null;
	hunkActionsAvailable?: boolean;
	reducedMotion?: boolean;
	onHunkAction?: (request: HunkActionRequest) => void | Promise<void>;
	confirmRevert?: (path: string, hunk: DiffHunk) => boolean | Promise<boolean>;
}

interface DiffTransition {
	entered: ReadonlySet<string>;
	changed: ReadonlySet<string>;
	removed: readonly DiffLine[];
}

const EMPTY_TRANSITION: DiffTransition = {
	entered: new Set(),
	changed: new Set(),
	removed: [],
};

function lineAnchor(file: DiffFile, line: DiffLine): string {
	return `${file.id}:${line.oldLine ?? "-"}:${line.newLine ?? "-"}:${line.kind === "no-newline" ? line.id : ""}`;
}

function indexedLines(diff: UnifiedDiff): Array<{ anchor: string; line: DiffLine }> {
	return diff.files.flatMap(file =>
		file.hunks.flatMap(hunk => hunk.lines.map(line => ({ anchor: lineAnchor(file, line), line }))),
	);
}

export function diffTransition(previous: UnifiedDiff | null, current: UnifiedDiff): DiffTransition {
	if (previous === null) return EMPTY_TRANSITION;
	const before = new Map(indexedLines(previous).map(item => [item.anchor, item.line]));
	const after = new Map(indexedLines(current).map(item => [item.anchor, item.line]));
	const entered = new Set<string>();
	const changed = new Set<string>();
	for (const [anchor, line] of after) {
		const old = before.get(anchor);
		if (old === undefined) entered.add(line.id);
		else if (old.kind !== line.kind || old.content !== line.content) changed.add(line.id);
	}
	const removed = [...before].filter(([anchor]) => !after.has(anchor)).map(([, line]) => line);
	return { entered, changed, removed };
}

/** The backend applies ordinary textual hunks only. Keep unsafe Git object changes whole-file. */
export function hunkUnsupportedReason(file: DiffFile): string | null {
	if (file.binary) return "Binary files do not have textual hunks that Git can apply safely.";
	if (file.status === "renamed" || file.status === "copied") {
		return "Rename and copy changes must be staged or reverted as a whole file.";
	}
	if (file.headers.some(line => line.startsWith("old mode ") || line.startsWith("new mode "))) {
		return "File-mode changes must be staged or reverted as a whole file.";
	}
	if (
		file.headers.some(line => line.includes("160000")) ||
		file.hunks.some(hunk => hunk.lines.some(line => line.content.startsWith("Subproject commit ")))
	) {
		return "Submodule pointer changes must be staged or reverted as a whole file.";
	}
	if (
		file.headers.some(line => line.startsWith("deleted file mode ") || line.startsWith("new file mode ")) &&
		file.hunks.length > 1
	) {
		return "Multi-hunk added and deleted files must be handled as a whole file.";
	}
	if (!file.headers.some(line => line.startsWith("--- ")) || !file.headers.some(line => line.startsWith("+++ "))) {
		return "This diff is missing the file markers required for a safe hunk operation.";
	}
	return null;
}

function parseDiff(unified: string): { diff: UnifiedDiff; error: string | null } {
	try {
		return { diff: parseUnifiedDiff(unified), error: null };
	} catch (error) {
		return {
			diff: { files: [] },
			error: error instanceof Error ? error.message : "The Git diff could not be parsed.",
		};
	}
}

function linePrefix(kind: DiffLine["kind"]): string {
	if (kind === "addition") return "+";
	if (kind === "deletion") return "−";
	if (kind === "no-newline") return "\\";
	return " ";
}

function defaultRevertConfirmation(path: string): boolean {
	if (typeof window === "undefined" || typeof window.confirm !== "function") return false;
	return window.confirm(`Discard this hunk from ${path}? This cannot be undone.`);
}

function pathFor(file: DiffFile, fallback?: string): string {
	return file.newPath ?? file.oldPath ?? fallback ?? "";
}

export function DiffView({
	unified,
	path,
	staged = false,
	revision,
	busy = false,
	error,
	hunkActionsAvailable,
	reducedMotion = false,
	onHunkAction,
	confirmRevert,
}: DiffViewProps) {
	const parsed = useMemo(() => parseDiff(unified), [unified]);
	const previousRef = useRef<UnifiedDiff | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const pendingScroll = (() => {
		const container = scrollRef.current;
		if (!container) return null;
		const containerTop = container.getBoundingClientRect().top;
		const anchor = [...container.querySelectorAll<HTMLElement>("[data-line-anchor]")].find(
			line => line.getBoundingClientRect().bottom >= containerTop,
		);
		return {
			anchor: anchor?.dataset.lineAnchor,
			offset: anchor ? anchor.getBoundingClientRect().top - containerTop : 0,
			left: container.scrollLeft,
			top: container.scrollTop,
		};
	})();
	const nextTransition = useMemo(() => diffTransition(previousRef.current, parsed.diff), [parsed.diff]);
	const [activeTransition, setActiveTransition] = useState<DiffTransition>(EMPTY_TRANSITION);
	const [selectedHunk, setSelectedHunk] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	useLayoutEffect(() => {
		setActiveTransition(nextTransition);
		previousRef.current = parsed.diff;
		if (pendingScroll && scrollRef.current) {
			const container = scrollRef.current;
			container.scrollLeft = pendingScroll.left;
			container.scrollTop = pendingScroll.top;
			if (pendingScroll.anchor) {
				const anchoredLine = [...container.querySelectorAll<HTMLElement>("[data-line-anchor]")].find(
					line => line.dataset.lineAnchor === pendingScroll.anchor,
				);
				if (anchoredLine) {
					const nextOffset = anchoredLine.getBoundingClientRect().top - container.getBoundingClientRect().top;
					container.scrollTop += nextOffset - pendingScroll.offset;
				}
			}
		}
	}, [parsed.diff, revision]);

	useEffect(() => {
		if (selectedHunk !== null && !parsed.diff.files.some(file => file.hunks.some(hunk => hunk.id === selectedHunk))) {
			setSelectedHunk(null);
		}
	}, [parsed.diff, selectedHunk]);

	useEffect(() => {
		if (
			activeTransition.entered.size === 0 &&
			activeTransition.changed.size === 0 &&
			activeTransition.removed.length === 0
		) {
			return;
		}
		const timer = globalThis.setTimeout(() => setActiveTransition(EMPTY_TRANSITION), reducedMotion ? 0 : 420);
		return () => globalThis.clearTimeout(timer);
	}, [activeTransition, reducedMotion]);

	const transition = previousRef.current === parsed.diff ? activeTransition : nextTransition;
	const canRequestHunks = (hunkActionsAvailable ?? onHunkAction !== undefined) && onHunkAction !== undefined;

	async function requestHunk(file: DiffFile, hunk: DiffHunk, action: HunkAction): Promise<void> {
		const targetPath = pathFor(file, path);
		if (!targetPath || !onHunkAction) return;
		setActionError(null);
		if (action === "revert") {
			const accepted = await (confirmRevert?.(targetPath, hunk) ?? defaultRevertConfirmation(targetPath));
			if (!accepted) return;
		}
		try {
			await onHunkAction({ path: targetPath, hunkId: hunk.id, action });
		} catch (requestError) {
			setActionError(requestError instanceof Error ? requestError.message : "The Git hunk operation failed.");
		}
	}

	const parseError = error ?? parsed.error ?? actionError;
	if (parseError) {
		return (
			<div className="git-state git-state--error" role="alert">
				<strong>Git diff unavailable</strong>
				<span>{parseError}</span>
			</div>
		);
	}
	if (parsed.diff.files.length === 0) {
		return (
			<div className="git-state git-state--empty">
				<strong>No textual diff</strong>
				<span>
					{path
						? `Git reported no ${staged ? "staged" : "working-tree"} patch for ${path}.`
						: "There are no changes to display."}
				</span>
			</div>
		);
	}

	let motionIndex = 0;
	return (
		<div
			className={`git-diff motion-diff-navigate${reducedMotion ? " git-diff--reduced-motion" : ""}`}
			data-reduced-motion={reducedMotion ? "true" : "false"}
			data-revision={revision}
			ref={scrollRef}
			tabIndex={0}
			aria-label={path ? `Diff for ${path}` : "Git diff"}
		>
			{parsed.diff.files.map(file => {
				const unsupported = hunkUnsupportedReason(file);
				const targetPath = pathFor(file, path);
				return (
					<section className="git-diff-file" key={file.id}>
						<header className="git-diff-file__header">
							<strong>{targetPath || "Unknown path"}</strong>
							<span className={`git-badge git-badge--${file.status}`}>{file.status}</span>
						</header>
						{file.headers
							.filter(
								line => !line.startsWith("diff --git ") && !line.startsWith("--- ") && !line.startsWith("+++ "),
							)
							.map((line, index) => (
								<div className="git-diff-meta" key={`${file.id}:header:${index}`}>
									{line}
								</div>
							))}
						{unsupported && (
							<p className="git-hunk-note" role="note">
								Hunk actions unavailable: {unsupported}
							</p>
						)}
						{!unsupported && !canRequestHunks && file.hunks.length > 0 && (
							<p className="git-hunk-note" role="note">
								Hunk actions are not supported by this connection.
							</p>
						)}
						{file.hunks.map(hunk => {
							const selected = selectedHunk === hunk.id;
							return (
								<section
									className={`git-hunk motion-diff-hunk${selected ? " git-hunk--selected" : ""}`}
									key={hunk.id}
								>
									<header className="git-hunk__header">
										<button
											type="button"
											className="git-hunk__select"
											aria-pressed={selected}
											onClick={() => setSelectedHunk(selected ? null : hunk.id)}
										>
											{hunk.header}
										</button>
										{selected && !unsupported && canRequestHunks && (
											<div className="git-hunk__actions" aria-label="Selected hunk actions">
												<button
													type="button"
													disabled={busy}
													onClick={() => requestHunk(file, hunk, staged ? "unstage" : "stage")}
												>
													{staged ? "Unstage hunk" : "Stage hunk"}
												</button>
												{!staged && (
													<button
														type="button"
														className="git-button--danger"
														disabled={busy}
														onClick={() => requestHunk(file, hunk, "revert")}
													>
														Revert hunk…
													</button>
												)}
											</div>
										)}
									</header>
									<div className="git-hunk__lines">
										{hunk.lines.map(line => {
											const entered = transition.entered.has(line.id);
											const changed = transition.changed.has(line.id);
											const animate = entered || changed;
											const style = animate
												? ({
														"--motion-index": motionIndex++,
														"--motion-diff-wash": `var(--color-diff-${line.kind === "addition" ? "add" : line.kind === "deletion" ? "delete" : "hunk"}-wash)`,
													} as CSSProperties)
												: undefined;
											return (
												<div
													className={`git-diff-line git-diff-line--${line.kind}${animate ? " motion-diff-line-enter" : ""}`}
													data-line-id={line.id}
													data-line-anchor={lineAnchor(file, line)}
													data-motion-state={entered ? "new" : changed ? "changed" : "stable"}
													key={lineAnchor(file, line)}
													style={style}
												>
													<span className="git-diff-line__number" aria-hidden="true">
														{line.oldLine ?? ""}
													</span>
													<span className="git-diff-line__number" aria-hidden="true">
														{line.newLine ?? ""}
													</span>
													<span className="git-diff-line__prefix" aria-hidden="true">
														{linePrefix(line.kind)}
													</span>
													<code>{line.content || " "}</code>
												</div>
											);
										})}
									</div>
								</section>
							);
						})}
					</section>
				);
			})}
			{transition.removed.length > 0 && (
				<div className="git-diff-departures" aria-hidden="true">
					{transition.removed.map(line => (
						<div
							className={`git-diff-line git-diff-line--${line.kind} git-diff-line--leaving`}
							key={`leaving:${line.id}`}
						>
							<span className="git-diff-line__number">{line.oldLine ?? ""}</span>
							<span className="git-diff-line__number">{line.newLine ?? ""}</span>
							<span className="git-diff-line__prefix">{linePrefix(line.kind)}</span>
							<code>{line.content || " "}</code>
						</div>
					))}
				</div>
			)}
			<span className="git-sr-only" aria-live="polite">
				{transition.entered.size + transition.changed.size + transition.removed.length > 0
					? `Diff updated: ${transition.entered.size} new, ${transition.changed.size} changed, ${transition.removed.length} removed lines.`
					: ""}
			</span>
		</div>
	);
}
