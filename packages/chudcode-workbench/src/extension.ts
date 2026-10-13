import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import * as vscode from "vscode";
import * as serviceClient from "./service-client";
import type { BridgeSocket, ServiceClient, ServiceState } from "./service-client";

type AgentView = "chat" | "sessions" | "tasks" | "graphs";
type HostMessage =
	| { type: "open"; connectionId: string; rootPath: string }
	| { type: "message"; connectionId: string; data: string }
	| { type: "close"; connectionId: string; code: number; reason: string }
	| { type: "error"; connectionId?: string; message: string }
	| { type: "view"; view: AgentView };

export interface WorkbenchApi {
	whenReady(): Promise<void>;
	request(method: string, params: unknown): Promise<unknown>;
	readonly serviceState: ServiceState;
}

class Workbench implements vscode.WebviewViewProvider {
	readonly #context: vscode.ExtensionContext;
	#view: vscode.WebviewView | undefined;
	#selection: AgentView = "chat";
	#service: ServiceClient | undefined;
	#serviceWorkspace: string | undefined;
	#bridge: BridgeSocket | undefined;
	#connectionId: string | undefined;
	#generation = 0;
	#disposed = false;
	#resetting: Promise<void> | undefined;
	#posts = 0;
	#postBytes = 0;

	constructor(context: vscode.ExtensionContext) {
		this.#context = context;
	}

	get serviceState(): ServiceState {
		return this.#service?.state ?? (this.#disposed ? "stopped" : "idle");
	}

	#workspace(): string {
		if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before starting the ChudCode agent");
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) throw new Error("Open Folder to start the ChudCode agent");
		if (folder.uri.scheme !== "file") throw new Error("ChudCode requires a local filesystem workspace");
		return folder.uri.fsPath;
	}

	async #client(): Promise<ServiceClient> {
		if (this.#disposed) throw new Error("ChudCode workbench is stopped");
		if (this.#resetting) await this.#resetting;
		if (this.#disposed) throw new Error("ChudCode workbench is stopped");
		const workspace = this.#workspace();
		if (this.#service && this.#serviceWorkspace !== workspace) throw new Error("ChudCode workspace is changing");
		if (!this.#service) {
			const executable = process.env.CHUDCODE_WORKBENCH_SERVICE;
			if (!executable || !path.isAbsolute(executable))
				throw new Error(
					"Launch ChudCode using its native desktop launcher to configure the trusted service executable",
				);
			let args: string[] = [];
			const encoded = process.env.CHUDCODE_WORKBENCH_SERVICE_ARGS;
			if (encoded) {
				let parsed: unknown;
				try {
					parsed = JSON.parse(encoded);
				} catch {
					throw new Error("Service development arguments must be a JSON string array");
				}
				if (
					!Array.isArray(parsed) ||
					parsed.length > 32 ||
					!parsed.every((item: unknown) => typeof item === "string" && item.length <= 4096 && !item.includes("\0"))
				) {
					throw new Error("Service development arguments must be a bounded JSON string array");
				}
				args = parsed as string[];
			}
			this.#serviceWorkspace = workspace;
			this.#service = new serviceClient.ServiceClient({
				workspace,
				executable,
				args,
				onFailure: message => this.#post({ type: "error", message }),
			});
		}
		const client = this.#service;
		await client.whenReady();
		if (this.#disposed || this.#service !== client || workspace !== this.#workspace())
			throw new Error("ChudCode workspace changed while starting service");
		return client;
	}

	async whenReady(): Promise<void> {
		await this.#client();
	}

	async request(method: string, params: unknown): Promise<unknown> {
		const client = await this.#client();
		this.#workspace();
		return client.request(method, params);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.#closeBridge();
		this.#view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.#context.extensionUri, "dist", "webview")],
		};
		view.webview.html = this.#html(view.webview);
		const subscription = view.webview.onDidReceiveMessage((message: unknown) => {
			void this.#receive(message).catch(error =>
				this.#post({ type: "error", message: error instanceof Error ? error.message : "Workbench request failed" }),
			);
		});
		view.onDidDispose(
			() => {
				subscription.dispose();
				if (this.#view === view) {
					this.#closeBridge();
					this.#view = undefined;
				}
			},
			undefined,
			this.#context.subscriptions,
		);
	}

	#html(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(24).toString("base64");
		const script = webview.asWebviewUri(
			vscode.Uri.joinPath(this.#context.extensionUri, "dist", "webview", "index.js"),
		);
		const style = webview.asWebviewUri(
			vscode.Uri.joinPath(this.#context.extensionUri, "dist", "webview", "index.css"),
		);
		return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource} data:; connect-src 'none';"><link rel="stylesheet" href="${style}"><title>ChudCode Agent</title></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
	}

	#post(message: HostMessage): void {
		const view = this.#view;
		if (!view || this.#disposed) return;
		const bytes = Buffer.byteLength(JSON.stringify(message));
		if (this.#posts >= 1024 || this.#postBytes + bytes > serviceClient.MAX_FRAME_BYTES) {
			const connectionId = this.#connectionId;
			this.#closeBridge();
			if (connectionId)
				void view.webview.postMessage({
					type: "close",
					connectionId,
					code: 1013,
					reason: "Workbench message buffer exceeded; reconnect for a fresh snapshot",
				});
			return;
		}
		this.#posts += 1;
		this.#postBytes += bytes;
		const generation = this.#generation;
		void view.webview.postMessage(message).then(
			accepted => {
				this.#posts -= 1;
				this.#postBytes -= bytes;
				if (!accepted && view === this.#view && generation === this.#generation) this.#closeBridge();
			},
			() => {
				this.#posts -= 1;
				this.#postBytes -= bytes;
				if (view === this.#view && generation === this.#generation) this.#closeBridge();
			},
		);
	}

	async #receive(message: unknown): Promise<void> {
		if (typeof message !== "object" || message === null || !("type" in message))
			throw new Error("Invalid workbench message");
		switch (message.type) {
			case "connect": {
				if (
					!("connectionId" in message) ||
					typeof message.connectionId !== "string" ||
					!/^[A-Za-z0-9_.:-]{1,128}$/.test(message.connectionId)
				)
					throw new Error("Invalid connection ID");
				this.#closeBridge();
				const connectionId = message.connectionId;
				this.#connectionId = connectionId;
				const generation = this.#generation;
				this.#post({ type: "view", view: this.#selection });
				try {
					const client = await this.#client();
					if (generation !== this.#generation || this.#disposed) return;
					const rootPath = this.#workspace();
					const bridge = await client.bridge({
						open: () => {
							if (generation === this.#generation) this.#post({ type: "open", connectionId, rootPath });
						},
						message: data => {
							if (generation === this.#generation) this.#post({ type: "message", connectionId, data });
						},
						close: (code, reason) => {
							if (generation === this.#generation) {
								this.#bridge = undefined;
								this.#post({ type: "close", connectionId, code, reason });
							}
						},
						error: error => {
							if (generation === this.#generation) this.#post({ type: "error", connectionId, message: error });
						},
					});
					if (generation !== this.#generation || this.#disposed) bridge.close();
					else this.#bridge = bridge;
				} catch (error) {
					if (generation !== this.#generation) return;
					const reason = error instanceof Error ? error.message : "Could not connect to service";
					this.#post({ type: "error", connectionId, message: reason });
					this.#post({ type: "close", connectionId, code: 1011, reason });
				}
				return;
			}
			case "send":
				this.#workspace();
				if (
					!("connectionId" in message) ||
					message.connectionId !== this.#connectionId ||
					!("data" in message) ||
					typeof message.data !== "string" ||
					!this.#bridge
				)
					throw new Error("Service bridge is not connected");
				this.#bridge.send(message.data);
				return;
			case "close":
				if ("connectionId" in message && message.connectionId === this.#connectionId) this.#closeBridge();
				return;
			case "openFolder":
				await vscode.commands.executeCommand("workbench.action.files.openFolder");
				return;
			case "openFile":
				if (!("path" in message) || typeof message.path !== "string" || message.path.length > 32_768)
					throw new Error("Invalid file path");
				await this.#openFile(
					message.path,
					"line" in message ? message.line : undefined,
					"column" in message ? message.column : undefined,
				);
				return;
			default:
				throw new Error("Unsupported workbench message");
		}
	}

	async #openFile(filename: string, line: unknown, column: unknown): Promise<void> {
		const workspace = this.#workspace();
		let requested: string;
		if (filename.startsWith("file:")) {
			try {
				requested = url.fileURLToPath(filename);
			} catch {
				throw new Error("Invalid local file URI");
			}
		} else {
			if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(filename) && !path.isAbsolute(filename))
				throw new Error("Only workspace files can be opened");
			requested = path.resolve(workspace, filename);
		}
		const root = await fs.realpath(workspace);
		const resolved = await fs.realpath(requested);
		const relative = path.relative(root, resolved);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
			throw new Error("File is outside the active workspace");
		if (!(await fs.stat(resolved)).isFile()) throw new Error("Requested path is not a file");
		const validCoordinate = (value: unknown) =>
			value === undefined ||
			(typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 10_000_000);
		if (!validCoordinate(line) || !validCoordinate(column)) throw new Error("Invalid file position");
		if (workspace !== this.#workspace()) throw new Error("Workspace changed while opening file");
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
		const editor = await vscode.window.showTextDocument(document, { preview: false });
		if (typeof line === "number" || typeof column === "number") {
			const row = Math.min(typeof line === "number" ? line - 1 : 0, document.lineCount - 1);
			const col = Math.min(typeof column === "number" ? column - 1 : 0, document.lineAt(row).text.length);
			const position = new vscode.Position(row, col);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position));
		}
	}

	#closeBridge(): void {
		this.#generation += 1;
		this.#bridge?.close();
		this.#bridge = undefined;
		this.#connectionId = undefined;
	}

	async show(view: AgentView): Promise<void> {
		this.#selection = view;
		await vscode.commands.executeCommand("chudcode.chat.focus");
		this.#post({ type: "view", view });
	}

	reset(start: boolean): Promise<void> {
		if (this.#resetting) return this.#resetting;
		this.#closeBridge();
		const service = this.#service;
		this.#resetting = (async () => {
			await service?.stop();
			this.#service = undefined;
			this.#serviceWorkspace = undefined;
		})().finally(() => {
			this.#resetting = undefined;
		});
		return this.#resetting.then(async () => {
			if (start) await this.whenReady();
			// Recreate the client after an intentional lifecycle change, never a hidden service retry.
			if (this.#view && !this.#disposed) this.#view.webview.html = this.#html(this.#view.webview);
		});
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		this.#closeBridge();
		await this.#resetting;
		await this.#service?.stop();
	}
}

let workbench: Workbench | undefined;

export function activate(context: vscode.ExtensionContext): WorkbenchApi {
	const host = new Workbench(context);
	workbench = host;
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider("chudcode.chat", host, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);
	for (const [command, view] of [
		["chudcode.openChat", "chat"],
		["chudcode.showSessions", "sessions"],
		["chudcode.showTasks", "tasks"],
		["chudcode.showGraphs", "graphs"],
	] as const)
		context.subscriptions.push(vscode.commands.registerCommand(command, () => host.show(view)));
	context.subscriptions.push(
		vscode.commands.registerCommand("chudcode.newSession", async () => {
			await host.whenReady();
			const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			const result = await host.request("session.new", { cwd });
			await host.show("chat");
			return result;
		}),
		vscode.commands.registerCommand("chudcode.restartService", () => host.reset(true)),
		vscode.workspace.onDidGrantWorkspaceTrust(() => {
			void host
				.reset(true)
				.catch(error =>
					vscode.window.showErrorMessage(error instanceof Error ? error.message : "Service startup failed"),
				);
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			void host
				.reset(false)
				.catch(() => vscode.window.showErrorMessage("Could not stop the previous ChudCode workspace service"));
		}),
	);
	// Trust is checked again at every service/bridge/request boundary, not just activation.
	if (vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.length) {
		void host
			.whenReady()
			.catch(error =>
				vscode.window.showErrorMessage(error instanceof Error ? error.message : "Service startup failed"),
			);
	}
	return {
		whenReady: () => host.whenReady(),
		request: (method, params) => host.request(method, params),
		get serviceState() {
			return host.serviceState;
		},
	};
}

export async function deactivate(): Promise<void> {
	const host = workbench;
	workbench = undefined;
	await host?.dispose();
}
