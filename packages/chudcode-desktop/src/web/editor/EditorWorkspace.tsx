import { Search, X } from "lucide-react";
import type * as MonacoModule from "monaco-editor";
import { type FormEvent, forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
// @ts-expect-error Bun's file loader returns the emitted asset URL for JavaScript inputs.
import cssWorkerUrl from "../../../../../node_modules/monaco-editor/min/vs/assets/css.worker-URu8fCFR.js" with { type: "file" };
// @ts-expect-error Bun's file loader returns the emitted asset URL for JavaScript inputs.
import editorWorkerUrl from "../../../../../node_modules/monaco-editor/min/vs/assets/editor.worker-lj3bdIIn.js" with { type: "file" };
// @ts-expect-error Bun's file loader returns the emitted asset URL for JavaScript inputs.
import htmlWorkerUrl from "../../../../../node_modules/monaco-editor/min/vs/assets/html.worker-D1SL3iM8.js" with { type: "file" };
// @ts-expect-error Bun's file loader returns the emitted asset URL for JavaScript inputs.
import jsonWorkerUrl from "../../../../../node_modules/monaco-editor/min/vs/assets/json.worker-CoJx_OPf.js" with { type: "file" };
// @ts-expect-error Bun's file loader returns the emitted asset URL for JavaScript inputs.
import typescriptWorkerUrl from "../../../../../node_modules/monaco-editor/min/vs/assets/ts.worker-BWKtMYOk.js" with { type: "file" };
import type {
	DocumentSnapshot,
	DocumentUri,
	FileStamp,
	LspDiagnostic,
	SearchResult,
	WorkspaceDescriptor,
} from "../../protocol";
import type { DesktopClient } from "../desktop-client";
import type { DesktopStoreSnapshot } from "../desktop-store";
import {
	desktopSelectors,
	selectDiagnostics,
	selectWorkspace,
	selectWorkspaceChanges,
	useDesktop,
} from "../use-desktop";
import { type EditorTab, EditorTabs } from "./EditorTabs";
import { FileTree } from "./FileTree";
import "./editor.css";

type Monaco = typeof MonacoModule;
type MonacoEditor = MonacoModule.editor.IStandaloneCodeEditor;
type MonacoModel = MonacoModule.editor.ITextModel;
type MonacoViewState = MonacoModule.editor.ICodeEditorViewState;

export interface EditorDocumentState {
	snapshot: DocumentSnapshot;
	text: string;
	dirty: boolean;
	conflict: boolean;
	viewState?: MonacoViewState | null;
}

export interface ExternalDocumentResolution {
	state: EditorDocumentState;
	replaceModel: boolean;
	changedLine?: number;
}

export interface EditorWorkspaceHandle {
	openLocation(uri: DocumentUri, line?: number, column?: number): Promise<void>;
	focus(): void;
}

interface EditorWorkspaceProps {
	client: DesktopClient;
	workspace?: WorkspaceDescriptor;
	recentWorkspaces?: readonly WorkspaceDescriptor[];
	onWorkspaceChange?(workspace: WorkspaceDescriptor): void;
	onCompareConflict?(local: DocumentSnapshot, disk: DocumentSnapshot): void;
}

export function firstChangedLine(before: string, after: string): number | undefined {
	if (before === after) return undefined;
	const oldLines = before.split("\n");
	const newLines = after.split("\n");
	const length = Math.max(oldLines.length, newLines.length);
	for (let index = 0; index < length; index++) if (oldLines[index] !== newLines[index]) return index + 1;
	return 1;
}

export function openDocumentState(snapshot: DocumentSnapshot): EditorDocumentState {
	return { snapshot, text: snapshot.text, dirty: snapshot.dirty, conflict: snapshot.conflict };
}

export function applyLocalEdit(state: EditorDocumentState, text: string): EditorDocumentState {
	return { ...state, text, dirty: text !== state.snapshot.text };
}

export function applySavedStamp(state: EditorDocumentState, stamp: FileStamp): EditorDocumentState {
	return {
		...state,
		snapshot: { ...state.snapshot, text: state.text, stamp, dirty: false, conflict: false },
		dirty: false,
		conflict: false,
	};
}

export function resolveExternalDocument(
	state: EditorDocumentState,
	disk: DocumentSnapshot,
): ExternalDocumentResolution {
	if (state.dirty) return { state: { ...state, conflict: true }, replaceModel: false };
	return {
		state: { ...openDocumentState(disk), viewState: state.viewState },
		replaceModel: true,
		changedLine: firstChangedLine(state.text, disk.text),
	};
}

export interface SaveDocumentResolution {
	state: EditorDocumentState;
	error?: unknown;
}

export async function saveEditorDocument(
	client: DesktopClient,
	workspaceId: string,
	state: EditorDocumentState,
	text: string,
): Promise<SaveDocumentResolution> {
	const edited = applyLocalEdit(state, text);
	try {
		const result = await client.request("workspace.write", {
			workspaceId,
			uri: state.snapshot.uri,
			text,
			expectedSha256: state.snapshot.stamp.sha256,
		});
		return { state: applySavedStamp(edited, result.stamp) };
	} catch (error) {
		return { state: { ...edited, conflict: true }, error };
	}
}

export function isPromptLikeTarget(target: EventTarget | null): boolean {
	const candidate = target as { matches?(selectors: string): boolean } | null;
	return candidate?.matches?.("input, textarea, select, [contenteditable='true'], [role='textbox']") ?? false;
}

function basename(uri: DocumentUri): string {
	const part = uri.slice(uri.lastIndexOf("/") + 1);
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function lspRange(monaco: Monaco, value: unknown): MonacoModule.IRange | undefined {
	const range = asRecord(value);
	const start = asRecord(range?.start);
	const end = asRecord(range?.end);
	if (
		typeof start?.line !== "number" ||
		typeof start.character !== "number" ||
		typeof end?.line !== "number" ||
		typeof end.character !== "number"
	)
		return undefined;
	return new monaco.Range(start.line + 1, start.character + 1, end.line + 1, end.character + 1);
}

function lspLocation(monaco: Monaco, value: unknown): MonacoModule.languages.Location | undefined {
	const location = asRecord(value);
	const uri =
		typeof location?.uri === "string"
			? location.uri
			: typeof location?.targetUri === "string"
				? location.targetUri
				: undefined;
	const range = lspRange(monaco, location?.range ?? location?.targetSelectionRange);
	return uri && range ? { uri: monaco.Uri.parse(uri), range } : undefined;
}

function lspLocations(monaco: Monaco, value: unknown): MonacoModule.languages.Location[] {
	return (Array.isArray(value) ? value : value ? [value] : [])
		.map(item => lspLocation(monaco, item))
		.filter((item): item is MonacoModule.languages.Location => Boolean(item));
}

function diagnosticAt(diagnostics: readonly LspDiagnostic[], uri: string, range: MonacoModule.IRange): LspDiagnostic[] {
	return diagnostics.filter(
		item =>
			item.uri === uri && item.startLine <= range.endLineNumber - 1 && item.endLine >= range.startLineNumber - 1,
	);
}

function lspWorkspaceEdits(monaco: Monaco, value: unknown): MonacoModule.languages.IWorkspaceTextEdit[] {
	const edit = asRecord(value);
	const changes = asRecord(edit?.changes);
	const edits: MonacoModule.languages.IWorkspaceTextEdit[] = [];
	if (!changes) return edits;
	for (const [uri, raw] of Object.entries(changes)) {
		for (const item of Array.isArray(raw) ? raw : []) {
			const textEdit = asRecord(item);
			const range = lspRange(monaco, textEdit?.range);
			if (range) {
				edits.push({
					resource: monaco.Uri.parse(uri),
					textEdit: { range, text: String(textEdit?.newText ?? "") },
					versionId: undefined,
				});
			}
		}
	}
	return edits;
}

function syncModelDiagnostics(
	monaco: Monaco,
	models: ReadonlyMap<DocumentUri, MonacoModel>,
	diagnostics: readonly LspDiagnostic[],
): void {
	for (const [uri, model] of models) {
		monaco.editor.setModelMarkers(
			model,
			"desktop-lsp",
			diagnostics
				.filter(item => item.uri === uri)
				.map(item => ({
					severity:
						item.severity === 1
							? monaco.MarkerSeverity.Error
							: item.severity === 2
								? monaco.MarkerSeverity.Warning
								: item.severity === 3
									? monaco.MarkerSeverity.Info
									: monaco.MarkerSeverity.Hint,
					message: item.message,
					source: item.source,
					startLineNumber: item.startLine + 1,
					startColumn: item.startColumn + 1,
					endLineNumber: item.endLine + 1,
					endColumn: item.endColumn + 1,
				})),
		);
	}
}

function installMonacoWorkers(): void {
	const scope = globalThis as typeof globalThis & {
		MonacoEnvironment?: { getWorker(moduleId: string, label: string): Worker };
	};
	if (scope.MonacoEnvironment) return;
	scope.MonacoEnvironment = {
		getWorker(_moduleId, label) {
			let url: URL;
			if (label === "json") url = new URL(jsonWorkerUrl, import.meta.url);
			else if (label === "css" || label === "scss" || label === "less") url = new URL(cssWorkerUrl, import.meta.url);
			else if (label === "html" || label === "handlebars" || label === "razor")
				url = new URL(htmlWorkerUrl, import.meta.url);
			else if (label === "typescript" || label === "javascript") url = new URL(typescriptWorkerUrl, import.meta.url);
			else url = new URL(editorWorkerUrl, import.meta.url);
			return new Worker(url, { type: "module", name: `monaco-${label || "editor"}` });
		},
	};
}

function registerLspProviders(
	monaco: Monaco,
	language: string,
	client: DesktopClient,
	workspaceId: string,
	diagnostics: () => readonly LspDiagnostic[],
): MonacoModule.IDisposable[] {
	const position = (value: MonacoModule.Position) => ({ line: value.lineNumber - 1, column: value.column - 1 });
	const request = async (method: string, uri: string, at?: MonacoModule.Position) =>
		(await client.request("lsp.request", { workspaceId, method, uri, ...(at ? { position: position(at) } : {}) }))
			.value;
	const selector = { language, scheme: "file" };
	return [
		monaco.languages.registerDefinitionProvider(selector, {
			provideDefinition: async (model, at) =>
				lspLocations(monaco, await request("textDocument/definition", model.uri.toString(), at)),
		}),
		monaco.languages.registerReferenceProvider(selector, {
			provideReferences: async (model, at) =>
				lspLocations(
					monaco,
					await client
						.request("lsp.request", {
							workspaceId,
							method: "textDocument/references",
							uri: model.uri.toString(),
							position: position(at),
							includeDeclaration: true,
						})
						.then(result => result.value),
				),
		}),
		monaco.languages.registerHoverProvider(selector, {
			provideHover: async (model, at) => {
				const hover = asRecord(await request("textDocument/hover", model.uri.toString(), at));
				if (!hover) return null;
				const values = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
				const contents = values.map(item =>
					typeof item === "string" ? { value: item } : { value: String(asRecord(item)?.value ?? "") },
				);
				return { contents, range: lspRange(monaco, hover.range) };
			},
		}),
		monaco.languages.registerCompletionItemProvider(selector, {
			triggerCharacters: [".", ":", "/", '"', "'", "<"],
			provideCompletionItems: async (model, at) => {
				const value = await request("textDocument/completion", model.uri.toString(), at);
				const raw = Array.isArray(value)
					? value
					: Array.isArray(asRecord(value)?.items)
						? (asRecord(value)?.items as unknown[])
						: [];
				const word = model.getWordUntilPosition(at);
				const fallbackRange = new monaco.Range(at.lineNumber, word.startColumn, at.lineNumber, word.endColumn);
				return {
					suggestions: raw.map(item => {
						const record = asRecord(item) ?? {};
						const textEdit = asRecord(record.textEdit);
						return {
							label: String(record.label ?? ""),
							kind: typeof record.kind === "number" ? record.kind : monaco.languages.CompletionItemKind.Text,
							insertText: String(textEdit?.newText ?? record.insertText ?? record.label ?? ""),
							detail: typeof record.detail === "string" ? record.detail : undefined,
							documentation: typeof record.documentation === "string" ? record.documentation : undefined,
							range: lspRange(monaco, textEdit?.range) ?? fallbackRange,
						};
					}),
				};
			},
		}),
		monaco.languages.registerCodeActionProvider(selector, {
			provideCodeActions: async (model, range) => {
				const uri = model.uri.toString();
				const relevant = diagnosticAt(diagnostics(), uri, range);
				const result = await client.request("lsp.request", {
					workspaceId,
					method: "textDocument/codeAction",
					uri,
					range: {
						start: { line: range.startLineNumber - 1, column: range.startColumn - 1 },
						end: { line: range.endLineNumber - 1, column: range.endColumn - 1 },
					},
					context: { diagnostics: relevant },
				});
				const raw = Array.isArray(result.value) ? result.value : [];
				const actions: MonacoModule.languages.CodeAction[] = [];
				for (const item of raw) {
					const action = asRecord(item) ?? {};
					const edits = lspWorkspaceEdits(monaco, action.edit);
					if (edits.length === 0) continue;
					actions.push({
						title: String(action.title ?? "Code action"),
						kind: typeof action.kind === "string" ? action.kind : undefined,
						isPreferred: action.isPreferred === true,
						diagnostics: [],
						edit: { edits },
					});
				}
				return { actions, dispose() {} };
			},
		}),
		monaco.languages.registerRenameProvider(selector, {
			provideRenameEdits: async (model, at, newName) => {
				const result = await client.request("lsp.request", {
					workspaceId,
					method: "textDocument/rename",
					uri: model.uri.toString(),
					position: position(at),
					newName,
				});
				const edits = lspWorkspaceEdits(monaco, result.value);
				return { edits };
			},
			resolveRenameLocation: (model, at) => ({
				range: model.getWordAtPosition(at)
					? new monaco.Range(
							at.lineNumber,
							model.getWordAtPosition(at)!.startColumn,
							at.lineNumber,
							model.getWordAtPosition(at)!.endColumn,
						)
					: new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column),
				text: model.getWordAtPosition(at)?.word ?? "",
			}),
		}),
	];
}

export const EditorWorkspace = forwardRef<EditorWorkspaceHandle, EditorWorkspaceProps>(function EditorWorkspace(
	{ client, workspace: controlledWorkspace, recentWorkspaces, onWorkspaceChange, onCompareConflict },
	ref,
) {
	const [openedWorkspace, setOpenedWorkspace] = useState<WorkspaceDescriptor>();
	const workspace = controlledWorkspace ?? openedWorkspace;
	const workspaceId = workspace?.id ?? "";
	const storeWorkspace = useDesktop(
		client,
		useCallback((state: DesktopStoreSnapshot) => selectWorkspace(state, workspaceId), [workspaceId]),
	);
	const changes = useDesktop(
		client,
		useCallback((state: DesktopStoreSnapshot) => selectWorkspaceChanges(state, workspaceId), [workspaceId]),
	);
	const diagnostics = useDesktop(
		client,
		useCallback((state: DesktopStoreSnapshot) => selectDiagnostics(state, workspaceId), [workspaceId]),
	);
	const storedWorkspaces = useDesktop(client, desktopSelectors.workspaces);
	const currentWorkspace = controlledWorkspace ?? storeWorkspace ?? openedWorkspace;
	const recents = recentWorkspaces ?? [...storedWorkspaces.values()];
	const [rootPath, setRootPath] = useState("");
	const [sessions, setSessions] = useState<Map<DocumentUri, EditorDocumentState>>(new Map());
	const sessionsRef = useRef(sessions);
	const [order, setOrder] = useState<DocumentUri[]>([]);
	const [activeUri, setActiveUri] = useState<DocumentUri>();
	const [error, setError] = useState<string>();
	const [announcement, setAnnouncement] = useState("");
	const [searchMode, setSearchMode] = useState<"files" | "content">();
	const [searchText, setSearchText] = useState("");
	const [searchResults, setSearchResults] = useState<readonly SearchResult[]>();
	const [compare, setCompare] = useState<{ local: DocumentSnapshot; disk: DocumentSnapshot }>();
	const editorHostRef = useRef<HTMLDivElement>(null);
	const editorRef = useRef<MonacoEditor | null>(null);
	const monacoRef = useRef<Monaco | null>(null);
	const modelsRef = useRef(new Map<DocumentUri, MonacoModel>());
	const lspRef = useRef(new Map<string, MonacoModule.IDisposable[]>());
	const diagnosticsRef = useRef<readonly LspDiagnostic[]>(diagnostics);
	const suppressChangeRef = useRef(false);
	const processedChangeKeysRef = useRef(new Set<string>());
	const decorationRef = useRef(new Map<DocumentUri, string[]>());

	const commitSessions = useCallback(
		(update: (current: Map<DocumentUri, EditorDocumentState>) => Map<DocumentUri, EditorDocumentState>) => {
			setSessions(current => {
				const next = update(current);
				sessionsRef.current = next;
				return next;
			});
		},
		[],
	);

	useEffect(() => {
		diagnosticsRef.current = diagnostics;
	}, [diagnostics]);

	useEffect(() => {
		processedChangeKeysRef.current.clear();
		const empty = new Map<DocumentUri, EditorDocumentState>();
		sessionsRef.current = empty;
		setSessions(empty);
		setOrder([]);
		setActiveUri(undefined);
		for (const model of modelsRef.current.values()) model.dispose();
		modelsRef.current.clear();
	}, [workspaceId]);

	const ensureLanguage = useCallback(
		(language: string) => {
			const monaco = monacoRef.current;
			if (!monaco || !currentWorkspace || lspRef.current.has(language)) return;
			lspRef.current.set(
				language,
				registerLspProviders(monaco, language, client, currentWorkspace.id, () => diagnosticsRef.current),
			);
		},
		[client, currentWorkspace],
	);

	const openDocument = useCallback(
		async (uri: DocumentUri, line?: number, column?: number) => {
			if (!currentWorkspace) return;
			let state = sessionsRef.current.get(uri);
			if (!state) {
				try {
					const result = await client.request("workspace.read", { workspaceId: currentWorkspace.id, uri });
					state = openDocumentState(result.document);
					commitSessions(current => new Map(current).set(uri, state!));
					setOrder(current => (current.includes(uri) ? current : [...current, uri]));
					const monaco = monacoRef.current;
					if (monaco) {
						const model =
							monaco.editor.getModel(monaco.Uri.parse(uri)) ??
							monaco.editor.createModel(result.document.text, result.document.language, monaco.Uri.parse(uri));
						modelsRef.current.set(uri, model);
						ensureLanguage(result.document.language);
					}
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
					return;
				}
			}
			setActiveUri(uri);
			queueMicrotask(() => {
				const editor = editorRef.current;
				if (line && editor) editor.setPosition({ lineNumber: line, column: column ?? 1 });
				if (line && editor) editor.revealLineInCenter(line);
				editor?.focus();
			});
		},
		[client, commitSessions, currentWorkspace, ensureLanguage],
	);

	useImperativeHandle(ref, () => ({ openLocation: openDocument, focus: () => editorRef.current?.focus() }), [
		openDocument,
	]);

	useEffect(() => {
		let disposed = false;
		let contentDisposable: MonacoModule.IDisposable | undefined;
		installMonacoWorkers();
		void import("monaco-editor").then(monaco => {
			if (disposed || !editorHostRef.current) return;
			monacoRef.current = monaco;
			const editor = monaco.editor.create(editorHostRef.current, {
				automaticLayout: true,
				fontFamily: "var(--font-code)",
				fontSize: 15.5,
				tabSize: 4,
				minimap: { enabled: true },
				smoothScrolling: false,
				mouseWheelZoom: true,
				cursorBlinking: "smooth",
				cursorSmoothCaretAnimation: "off",
				renderWhitespace: "selection",
				accessibilitySupport: "auto",
				theme: document.documentElement.dataset.theme === "light" ? "vs" : "vs-dark",
			});
			editorRef.current = editor;
			for (const [uri, state] of sessionsRef.current) {
				const model =
					monaco.editor.getModel(monaco.Uri.parse(uri)) ??
					monaco.editor.createModel(state.text, state.snapshot.language, monaco.Uri.parse(uri));
				modelsRef.current.set(uri, model);
				ensureLanguage(state.snapshot.language);
			}
			syncModelDiagnostics(monaco, modelsRef.current, diagnosticsRef.current);
			contentDisposable = editor.onDidChangeModelContent(() => {
				if (suppressChangeRef.current) return;
				const model = editor.getModel();
				if (!model) return;
				const uri = model.uri.toString();
				commitSessions(current => {
					const state = current.get(uri);
					return state ? new Map(current).set(uri, applyLocalEdit(state, model.getValue())) : current;
				});
			});
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
				const uri = editor.getModel()?.uri.toString();
				if (uri) void saveDocument(uri);
			});
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => setSearchMode("files"));
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () =>
				setSearchMode("content"),
			);
		});
		return () => {
			disposed = true;
			contentDisposable?.dispose();
			editorRef.current?.dispose();
			editorRef.current = null;
			for (const model of modelsRef.current.values()) model.dispose();
			modelsRef.current.clear();
			for (const values of lspRef.current.values())
				values.forEach(value => {
					value.dispose();
				});
			lspRef.current.clear();
		};
	}, [commitSessions, ensureLanguage]);

	useEffect(() => {
		const editor = editorRef.current;
		const model = activeUri ? modelsRef.current.get(activeUri) : undefined;
		if (!editor || !model) return;
		const previous = editor.getModel()?.uri.toString();
		if (previous)
			commitSessions(current => {
				const state = current.get(previous);
				return state ? new Map(current).set(previous, { ...state, viewState: editor.saveViewState() }) : current;
			});
		editor.setModel(model);
		const state = sessionsRef.current.get(activeUri!);
		if (state?.viewState) editor.restoreViewState(state.viewState);
		editor.focus();
	}, [activeUri, commitSessions]);

	async function saveDocument(uri: DocumentUri) {
		if (!currentWorkspace) return;
		const state = sessionsRef.current.get(uri);
		const model = modelsRef.current.get(uri);
		if (!state || !model || !state.dirty || state.conflict) return;
		const result = await saveEditorDocument(client, currentWorkspace.id, state, model.getValue());
		commitSessions(current => (current.has(uri) ? new Map(current).set(uri, result.state) : current));
		if (result.error) setError(result.error instanceof Error ? result.error.message : String(result.error));
	}

	const replaceCleanModel = useCallback(
		(uri: DocumentUri, disk: DocumentSnapshot, agent: boolean, force = false) => {
			const state = sessionsRef.current.get(uri);
			if (!state) return;
			const resolution = force
				? {
						state: { ...openDocumentState(disk), viewState: state.viewState },
						replaceModel: true,
						changedLine: firstChangedLine(state.text, disk.text),
					}
				: resolveExternalDocument(state, disk);
			commitSessions(current => new Map(current).set(uri, resolution.state));
			if (!resolution.replaceModel) return;
			const editor = editorRef.current;
			const model = modelsRef.current.get(uri);
			if (!model) return;
			const view = editor?.getModel() === model ? editor.saveViewState() : state.viewState;
			suppressChangeRef.current = true;
			model.setValue(disk.text);
			suppressChangeRef.current = false;
			if (editor?.getModel() === model && view) editor.restoreViewState(view);
			if (agent && resolution.changedLine) {
				const ids = model.deltaDecorations(decorationRef.current.get(uri) ?? [], [
					{
						range: new monacoRef.current!.Range(resolution.changedLine, 1, resolution.changedLine, 1),
						options: {
							isWholeLine: true,
							className: "agent-line-change motion-file-modified",
							linesDecorationsClassName: "agent-line-glyph",
						},
					},
				]);
				decorationRef.current.set(uri, ids);
				setTimeout(() => {
					if (!model.isDisposed())
						decorationRef.current.set(uri, model.deltaDecorations(decorationRef.current.get(uri) ?? [], []));
				}, 4_800);
			}
		},
		[commitSessions],
	);

	useEffect(() => {
		if (!currentWorkspace) return;
		const retainedKeys = new Set<string>();
		for (const change of changes) {
			const key = `${change.kind}\0${change.uri}\0${change.oldUri ?? ""}\0${change.origin}\0${change.stamp?.generation ?? ""}\0${change.stamp?.sha256 ?? ""}`;
			retainedKeys.add(key);
			if (processedChangeKeysRef.current.has(key)) continue;
			processedChangeKeysRef.current.add(key);
			if (change.origin === "agent") {
				setAnnouncement(`Agent ${change.kind} ${basename(change.uri)}`);
			}
			const uri = change.oldUri && sessionsRef.current.has(change.oldUri) ? change.oldUri : change.uri;
			const state = sessionsRef.current.get(uri);
			if (!state) continue;
			if (change.kind === "deleted") {
				commitSessions(current => new Map(current).set(uri, { ...state, conflict: true }));
				continue;
			}
			void client
				.request("workspace.read", { workspaceId: currentWorkspace.id, uri: change.uri })
				.then(result => {
					if (change.oldUri && change.oldUri !== change.uri) {
						const old = sessionsRef.current.get(change.oldUri);
						if (!old) return;
						if (old.dirty) {
							commitSessions(current => new Map(current).set(change.oldUri!, { ...old, conflict: true }));
							return;
						}
						const oldModel = modelsRef.current.get(change.oldUri);
						const monaco = monacoRef.current;
						if (oldModel && monaco) {
							const next = monaco.editor.createModel(
								result.document.text,
								result.document.language,
								monaco.Uri.parse(change.uri),
							);
							modelsRef.current.set(change.uri, next);
							modelsRef.current.delete(change.oldUri);
							oldModel.dispose();
						}
						commitSessions(current => {
							const next = new Map(current);
							next.delete(change.oldUri!);
							next.set(change.uri, openDocumentState(result.document));
							return next;
						});
						setOrder(current => current.map(value => (value === change.oldUri ? change.uri : value)));
						setActiveUri(current => (current === change.oldUri ? change.uri : current));
					} else replaceCleanModel(uri, result.document, change.origin === "agent");
				})
				.catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
		}
		processedChangeKeysRef.current = new Set(
			[...processedChangeKeysRef.current].filter(key => retainedKeys.has(key)),
		);
	}, [changes, client, commitSessions, currentWorkspace, replaceCleanModel]);

	useEffect(() => {
		const monaco = monacoRef.current;
		if (monaco) syncModelDiagnostics(monaco, modelsRef.current, diagnostics);
	}, [diagnostics]);

	const closeDocument = (uri: DocumentUri) => {
		const state = sessionsRef.current.get(uri);
		if (state?.dirty && !globalThis.confirm(`Close ${basename(uri)} without saving?`)) return;
		commitSessions(current => {
			const next = new Map(current);
			next.delete(uri);
			return next;
		});
		setOrder(current => {
			const index = current.indexOf(uri);
			const next = current.filter(value => value !== uri);
			if (activeUri === uri) setActiveUri(next[Math.min(index, next.length - 1)]);
			return next;
		});
		modelsRef.current.get(uri)?.dispose();
		modelsRef.current.delete(uri);
	};

	const reload = async (uri: DocumentUri) => {
		if (!currentWorkspace) return;
		try {
			const result = await client.request("workspace.read", { workspaceId: currentWorkspace.id, uri });
			replaceCleanModel(uri, result.document, false, true);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	const compareConflict = async (uri: DocumentUri) => {
		if (!currentWorkspace) return;
		const state = sessionsRef.current.get(uri);
		if (!state) return;
		try {
			const result = await client.request("workspace.read", { workspaceId: currentWorkspace.id, uri });
			const local = { ...state.snapshot, text: state.text, dirty: state.dirty, conflict: state.conflict };
			if (onCompareConflict) onCompareConflict(local, result.document);
			else setCompare({ local, disk: result.document });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	const runSearch = async (event: FormEvent) => {
		event.preventDefault();
		if (!currentWorkspace || !searchMode) return;
		try {
			const result = await client.request("workspace.search", {
				workspaceId: currentWorkspace.id,
				query: { text: searchText, kind: searchMode, maxResults: 100 },
			});
			setSearchResults(result.results);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	const openWorkspace = async (event?: FormEvent, recentPath?: string) => {
		event?.preventDefault();
		const path = recentPath ?? rootPath.trim();
		if (!path) return;
		try {
			const result = await client.request("workspace.open", { rootPath: path });
			setOpenedWorkspace(result.workspace);
			onWorkspaceChange?.(result.workspace);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	const tabItems: EditorTab[] = order.flatMap(uri => {
		const state = sessions.get(uri);
		return state ? [{ uri, label: basename(uri), dirty: state.dirty, conflict: state.conflict }] : [];
	});

	if (!currentWorkspace)
		return (
			<section className="editor-workspace editor-workspace--welcome" aria-label="Open workspace">
				<h2>Open a project</h2>
				<form onSubmit={openWorkspace}>
					<label htmlFor="workspace-path">Workspace path</label>
					<input
						id="workspace-path"
						value={rootPath}
						onChange={event => setRootPath(event.currentTarget.value)}
						placeholder="/path/to/project"
					/>
					<button type="submit">Open</button>
				</form>
				{recents.length ? (
					<div className="recent-workspaces">
						<h3>Recent projects</h3>
						{recents.map(item => (
							<button type="button" key={item.id} onClick={() => void openWorkspace(undefined, item.rootPath)}>
								<strong>{item.displayName}</strong>
								<span>{item.rootPath}</span>
							</button>
						))}
					</div>
				) : null}
				{error ? (
					<p role="alert" className="editor-error">
						{error}
					</p>
				) : null}
			</section>
		);

	return (
		<section
			className="editor-workspace"
			aria-label="Editor workspace"
			onKeyDown={event => {
				if (isPromptLikeTarget(event.target)) return;
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
					event.preventDefault();
					setSearchMode("files");
				}
				if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
					event.preventDefault();
					setSearchMode("content");
				}
			}}
		>
			<FileTree
				client={client}
				workspace={currentWorkspace}
				activeUri={activeUri}
				changes={changes}
				onOpen={uri => void openDocument(uri)}
				onQuickOpen={() => setSearchMode("files")}
				onError={setError}
			/>
			<div className="editor-workspace__main">
				<EditorTabs
					tabs={tabItems}
					activeUri={activeUri}
					onSelect={setActiveUri}
					onClose={closeDocument}
					onSave={uri => void saveDocument(uri)}
					onReload={uri => void reload(uri)}
					onCompare={uri => void compareConflict(uri)}
				/>
				<div
					className="editor-workspace__editor motion-tab-content-enter"
					ref={editorHostRef}
					aria-label="Code editor"
				/>
				{order.length === 0 ? (
					<div className="editor-workspace__empty">
						<p>Open a file from the Explorer or press Ctrl/Cmd+P.</p>
					</div>
				) : null}
			</div>
			<div className="sr-only" aria-live="polite" aria-atomic="true">
				{announcement}
			</div>
			{error ? (
				<div role="alert" className="editor-error editor-error--floating">
					<span>{error}</span>
					<button type="button" aria-label="Dismiss error" onClick={() => setError(undefined)}>
						<X size={14} />
					</button>
				</div>
			) : null}
			{searchMode ? (
				<div
					className="editor-overlay"
					role="dialog"
					aria-modal="true"
					aria-label={searchMode === "files" ? "Quick Open" : "Search in files"}
				>
					<form className="editor-search" onSubmit={runSearch}>
						<Search size={16} />
						<input
							autoFocus
							aria-label={searchMode === "files" ? "Quick Open" : "Search in files"}
							value={searchText}
							onChange={event => setSearchText(event.currentTarget.value)}
							placeholder={searchMode === "files" ? "Type a file name" : "Search workspace contents"}
						/>
						<button
							type="button"
							aria-label="Close search"
							onClick={() => {
								setSearchMode(undefined);
								setSearchResults(undefined);
							}}
						>
							<X size={15} />
						</button>
					</form>
					<div className="editor-search__results">
						{searchResults?.map((result, index) => (
							<button
								type="button"
								key={`${result.uri}:${result.line ?? 0}:${index}`}
								onClick={() => {
									setSearchMode(undefined);
									void openDocument(
										result.uri,
										result.line === undefined ? undefined : result.line + 1,
										result.column === undefined ? undefined : result.column + 1,
									);
								}}
							>
								<strong>{basename(result.uri)}</strong>
								<span>{result.preview}</span>
								{result.line !== undefined ? <small>Line {result.line + 1}</small> : null}
							</button>
						))}
					</div>
				</div>
			) : null}
			{compare ? (
				<div
					className="editor-overlay editor-overlay--compare"
					role="dialog"
					aria-modal="true"
					aria-label="Conflict comparison"
				>
					<header>
						<strong>Local changes compared with disk</strong>
						<button type="button" onClick={() => setCompare(undefined)}>
							<X size={15} /> Close
						</button>
					</header>
					<div className="conflict-compare">
						<section>
							<h3>Local, unsaved</h3>
							<pre>{compare.local.text}</pre>
						</section>
						<section>
							<h3>On disk</h3>
							<pre>{compare.disk.text}</pre>
						</section>
					</div>
				</div>
			) : null}
		</section>
	);
});
