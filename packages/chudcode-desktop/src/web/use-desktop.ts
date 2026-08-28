import { useSyncExternalStore } from "react";
import type { DocumentUri, FileChange, LspDiagnostic, TerminalId, WorkspaceEntry, WorkspaceId } from "../protocol";
import type { DesktopClient } from "./desktop-client";
import type { DesktopStoreSnapshot, TerminalSnapshot } from "./desktop-store";

const EMPTY_WORKSPACE_ENTRIES: readonly WorkspaceEntry[] = [];
const EMPTY_FILE_CHANGES: readonly FileChange[] = [];
const EMPTY_DIAGNOSTICS: readonly LspDiagnostic[] = [];

export type DesktopSelector<T> = (snapshot: DesktopStoreSnapshot) => T;

export function useDesktop<T>(client: DesktopClient, selector: DesktopSelector<T>): T {
	const snapshot = useSyncExternalStore(client.subscribe, client.getDesktopSnapshot, client.getDesktopSnapshot);
	return selector(snapshot);
}

export const desktopSelectors = {
	revision: (snapshot: DesktopStoreSnapshot) => snapshot.revision,
	session: (snapshot: DesktopStoreSnapshot) => snapshot.session,
	activeSessionPath: (snapshot: DesktopStoreSnapshot) => snapshot.activeSessionPath,
	sessionTabs: (snapshot: DesktopStoreSnapshot) => snapshot.sessionTabs,
	sessionSnapshots: (snapshot: DesktopStoreSnapshot) => snapshot.sessionSnapshots,
	sessions: (snapshot: DesktopStoreSnapshot) => snapshot.sessions,
	workspaces: (snapshot: DesktopStoreSnapshot) => snapshot.workspaces,
	workspaceEntries: (snapshot: DesktopStoreSnapshot) => snapshot.workspaceEntries,
	workspaceChanges: (snapshot: DesktopStoreSnapshot) => snapshot.workspaceChanges,
	documents: (snapshot: DesktopStoreSnapshot) => snapshot.documents,
	git: (snapshot: DesktopStoreSnapshot) => snapshot.git,
	terminals: (snapshot: DesktopStoreSnapshot) => snapshot.terminals,
	diagnostics: (snapshot: DesktopStoreSnapshot) => snapshot.diagnostics,
	graphs: (snapshot: DesktopStoreSnapshot) => snapshot.graphs,
	lastError: (snapshot: DesktopStoreSnapshot) => snapshot.lastError,
} as const;

export function selectWorkspace(snapshot: DesktopStoreSnapshot, workspaceId: WorkspaceId) {
	return snapshot.workspaces.get(workspaceId);
}

export function selectWorkspaceEntries(
	snapshot: DesktopStoreSnapshot,
	workspaceId: WorkspaceId,
): readonly WorkspaceEntry[] {
	return snapshot.workspaceEntries.get(workspaceId) ?? EMPTY_WORKSPACE_ENTRIES;
}

export function selectWorkspaceChanges(
	snapshot: DesktopStoreSnapshot,
	workspaceId: WorkspaceId,
): readonly FileChange[] {
	return snapshot.workspaceChanges.get(workspaceId) ?? EMPTY_FILE_CHANGES;
}

export function selectDocument(snapshot: DesktopStoreSnapshot, uri: DocumentUri) {
	return snapshot.documents.get(uri);
}

export function selectGit(snapshot: DesktopStoreSnapshot, workspaceId: WorkspaceId) {
	return snapshot.git.get(workspaceId);
}

export function selectTerminal(snapshot: DesktopStoreSnapshot, terminalId: TerminalId): TerminalSnapshot | undefined {
	return snapshot.terminals.get(terminalId);
}

export function selectDiagnostics(snapshot: DesktopStoreSnapshot, workspaceId: WorkspaceId): readonly LspDiagnostic[] {
	return snapshot.diagnostics.get(workspaceId) ?? EMPTY_DIAGNOSTICS;
}

export function selectGraph(snapshot: DesktopStoreSnapshot, workspaceId: WorkspaceId, kind: "code" | "git" | "agent") {
	return snapshot.graphs.get(`${workspaceId}:${kind}`);
}
