import { AlertCircle, AlertTriangle, Braces, CircleCheck, Info, LoaderCircle, Search, Waypoints } from "lucide-react";
import { useMemo, useState } from "react";
import type { DesktopRequestMap, DocumentUri, LspDiagnostic, LspPosition, WorkspaceId } from "../../protocol";
import type { DesktopClient } from "../desktop-client";
import { selectDiagnostics, useDesktop } from "../use-desktop";

export type LspServerState = "starting" | "ready" | "error" | "stopped";

export interface LspServerSummary {
	id: string;
	name: string;
	language?: string;
	state: LspServerState;
	message?: string;
}

export type LspNavigationMethod = "textDocument/definition" | "textDocument/references" | "workspace/symbol";

export interface LspStatusProps {
	client: DesktopClient;
	workspaceId: WorkspaceId;
	servers?: readonly LspServerSummary[];
	activeUri?: DocumentUri;
	position?: LspPosition;
	onOpenDiagnostic?: (uri: DocumentUri, line: number, column: number) => void;
	onResult?: (method: LspNavigationMethod, value: unknown) => void;
	onError?: (method: LspNavigationMethod, error: Error) => void;
	className?: string;
}

const SEVERITY_META = {
	1: { label: "Error", className: "is-error", Icon: AlertCircle },
	2: { label: "Warning", className: "is-warning", Icon: AlertTriangle },
	3: { label: "Information", className: "is-info", Icon: Info },
	4: { label: "Hint", className: "is-hint", Icon: Info },
} as const;

function compareDiagnostics(left: LspDiagnostic, right: LspDiagnostic): number {
	return (
		left.severity - right.severity ||
		left.uri.localeCompare(right.uri) ||
		left.startLine - right.startLine ||
		left.startColumn - right.startColumn
	);
}

function diagnosticName(uri: string): string {
	try {
		const path = new URL(uri).pathname;
		return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)) || uri;
	} catch {
		return uri.slice(uri.lastIndexOf("/") + 1) || uri;
	}
}

export function LspStatus({
	client,
	workspaceId,
	servers = [],
	activeUri,
	position,
	onOpenDiagnostic,
	onResult,
	onError,
	className = "",
}: LspStatusProps) {
	const diagnostics = useDesktop(client, store => selectDiagnostics(store, workspaceId));
	const sortedDiagnostics = useMemo(() => [...diagnostics].sort(compareDiagnostics), [diagnostics]);
	const [symbolQuery, setSymbolQuery] = useState("");
	const [pending, setPending] = useState<LspNavigationMethod | null>(null);
	const [requestError, setRequestError] = useState<string | null>(null);

	const request = (method: LspNavigationMethod): void => {
		if (pending) return;
		const params: DesktopRequestMap["lsp.request"]["params"] = { workspaceId, method };
		if (method === "workspace/symbol") params.query = symbolQuery;
		else {
			if (!activeUri || !position) return;
			params.uri = activeUri;
			params.position = position;
			if (method === "textDocument/references") params.includeDeclaration = true;
		}
		setPending(method);
		setRequestError(null);
		void client
			.request("lsp.request", params)
			.then(({ value }) => onResult?.(method, value))
			.catch(cause => {
				const error = cause instanceof Error ? cause : new Error(String(cause));
				setRequestError(error.message);
				onError?.(method, error);
			})
			.finally(() => setPending(null));
	};

	const errorCount = diagnostics.filter(item => item.severity === 1).length;
	const warningCount = diagnostics.filter(item => item.severity === 2).length;
	const readyCount = servers.filter(server => server.state === "ready").length;

	return (
		<section className={`lsp-status ${className}`.trim()} aria-label="Language services">
			<header className="lsp-status-header">
				<div>
					<h2>Language services</h2>
					<p>
						{readyCount}/{servers.length} servers ready · {errorCount} errors · {warningCount} warnings
					</p>
				</div>
				<div className="lsp-actions" aria-label="Language navigation">
					<button
						type="button"
						onClick={() => request("textDocument/definition")}
						disabled={!activeUri || !position || pending !== null}
					>
						{pending === "textDocument/definition" ? (
							<LoaderCircle className="lsp-spinner" aria-hidden="true" size={14} />
						) : (
							<Waypoints aria-hidden="true" size={14} />
						)}
						Definition
					</button>
					<button
						type="button"
						onClick={() => request("textDocument/references")}
						disabled={!activeUri || !position || pending !== null}
					>
						{pending === "textDocument/references" ? (
							<LoaderCircle className="lsp-spinner" aria-hidden="true" size={14} />
						) : (
							<Braces aria-hidden="true" size={14} />
						)}
						References
					</button>
					<label className="lsp-symbol-search">
						<span className="sr-only">Workspace symbol query</span>
						<input
							value={symbolQuery}
							onChange={event => setSymbolQuery(event.target.value)}
							placeholder="Workspace symbols"
						/>
						<button
							type="button"
							aria-label="Search workspace symbols"
							onClick={() => request("workspace/symbol")}
							disabled={pending !== null}
						>
							{pending === "workspace/symbol" ? (
								<LoaderCircle className="lsp-spinner" aria-hidden="true" size={14} />
							) : (
								<Search aria-hidden="true" size={14} />
							)}
						</button>
					</label>
				</div>
			</header>

			{requestError ? (
				<div className="lsp-request-error" role="alert">
					{requestError}
				</div>
			) : null}

			<div className="lsp-server-list" aria-label="Language servers">
				{servers.map(server => (
					<div className={`lsp-server is-${server.state}`} key={server.id}>
						{server.state === "ready" ? (
							<CircleCheck aria-hidden="true" size={14} />
						) : server.state === "starting" ? (
							<LoaderCircle className="lsp-spinner" aria-hidden="true" size={14} />
						) : (
							<AlertCircle aria-hidden="true" size={14} />
						)}
						<span>{server.name}</span>
						{server.language ? <small>{server.language}</small> : null}
						<strong>{server.state}</strong>
						{server.message ? <span className="lsp-server-message">{server.message}</span> : null}
					</div>
				))}
				{servers.length === 0 ? <p className="lsp-empty">No language servers reported.</p> : null}
			</div>

			<div className="lsp-diagnostics" aria-label="Diagnostics">
				<h3>
					Problems <span>{diagnostics.length}</span>
				</h3>
				<ul>
					{sortedDiagnostics.map((diagnostic, index) => {
						const severity = SEVERITY_META[diagnostic.severity];
						const Icon = severity.Icon;
						return (
							<li key={`${diagnostic.uri}:${diagnostic.startLine}:${diagnostic.startColumn}:${index}`}>
								<button
									type="button"
									className={`lsp-diagnostic ${severity.className}`}
									onClick={() =>
										// LSP ranges are zero-based; Monaco editor navigation is one-based.
										onOpenDiagnostic?.(diagnostic.uri, diagnostic.startLine + 1, diagnostic.startColumn + 1)
									}
									disabled={!onOpenDiagnostic}
								>
									<Icon aria-label={severity.label} size={15} />
									<span className="lsp-diagnostic-message">{diagnostic.message}</span>
									<span className="lsp-diagnostic-location">
										{diagnosticName(diagnostic.uri)}:{diagnostic.startLine + 1}:{diagnostic.startColumn + 1}
									</span>
									{diagnostic.source ? (
										<span className="lsp-diagnostic-source">{diagnostic.source}</span>
									) : null}
								</button>
							</li>
						);
					})}
				</ul>
				{diagnostics.length === 0 ? <p className="lsp-empty">No diagnostics.</p> : null}
			</div>
		</section>
	);
}
