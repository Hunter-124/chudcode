import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	applyContentChanges,
	canonicalizeDocumentUri,
	canonicalizeWorkspaceRoot,
	LspBroker,
	toDesktopDiagnostics,
} from "../src/services/lsp-broker";
import { LspClient } from "../src/services/lsp-client";
import type { LspClientNotification, PublishDiagnosticsParams, TrustedLspServerSpec } from "../src/services/lsp-types";

const FAKE_SERVER_SOURCE = String.raw`
import fs from "node:fs";
const logPath = process.argv[2];
let bytes = Buffer.alloc(0);
let hovers = [];
function record(message) {
  fs.appendFileSync(logPath, JSON.stringify(message) + "\n");
}
function frame(message) {
  const json = JSON.stringify(message);
  return Buffer.from("Content-Length: " + Buffer.byteLength(json, "utf8") + "\r\n\r\n" + json);
}
function send(message) {
  process.stdout.write(frame(message));
}
function sendSplitBatch(messages) {
  const payload = Buffer.concat(messages.map(frame));
  const first = Math.min(13, payload.length - 1);
  const second = Math.min(first + 19, payload.length - 1);
  process.stdout.write(payload.subarray(0, first));
  setImmediate(() => {
    process.stdout.write(payload.subarray(first, second));
    setImmediate(() => process.stdout.write(payload.subarray(second)));
  });
}
function handle(message) {
  record(message);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { textDocumentSync: 2 } } });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") {
    setImmediate(() => process.exit(0));
    return;
  }
  if (message.method === "$/cancelRequest") {
    send({ jsonrpc: "2.0", method: "test/cancelled", params: message.params });
    return;
  }
  if (message.method === "textDocument/completion") {
    send({ jsonrpc: "2.0", method: "test/completion-received", params: { id: message.id } });
    return;
  }
  if (message.method === "textDocument/hover") {
    hovers.push(message);
    if (hovers.length === 2) {
      const first = hovers[0];
      const second = hovers[1];
      hovers = [];
      sendSplitBatch([
        {
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: {
            uri: first.params.textDocument.uri,
            version: 1,
            diagnostics: [{
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 2,
              source: "fake",
              message: "interleaved diagnostic"
            }]
          }
        },
        { jsonrpc: "2.0", id: second.id, result: { requestId: second.id, character: second.params.position.character } },
        { jsonrpc: "2.0", id: first.id, result: { requestId: first.id, character: first.params.position.character } }
      ]);
    }
    return;
  }
  if (message.method === "textDocument/definition") {
    if (message.params.position.line === 9) {
      process.stderr.write("fake crash on definition\n");
      setImmediate(() => process.exit(9));
    } else {
      send({ jsonrpc: "2.0", id: message.id, result: null });
    }
    return;
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: null });
}
process.stdin.on("data", chunk => {
  bytes = Buffer.concat([bytes, chunk]);
  while (true) {
    const headerEnd = bytes.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const match = /Content-Length:\s*(\d+)/i.exec(bytes.toString("utf8", 0, headerEnd));
    if (!match) {
      bytes = bytes.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (bytes.length < bodyStart + length) return;
    const body = bytes.toString("utf8", bodyStart, bodyStart + length);
    bytes = bytes.subarray(bodyStart + length);
    handle(JSON.parse(body));
  }
});
`;

interface Fixture {
	directory: string;
	root: string;
	documentPath: string;
	documentUri: string;
	logPath: string;
	spec: TrustedLspServerSpec;
}

async function createFixture(restart?: TrustedLspServerSpec["restart"]): Promise<Fixture> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-lsp-"));
	const root = path.join(directory, "workspace");
	await fs.mkdir(root);
	const documentPath = path.join(root, "sample file.ts");
	await fs.writeFile(documentPath, "const oldName = 1;\n");
	const scriptPath = path.join(directory, "fake-lsp.mjs");
	const logPath = path.join(directory, "messages.jsonl");
	await fs.writeFile(scriptPath, FAKE_SERVER_SOURCE);
	return {
		directory,
		root,
		documentPath,
		documentUri: pathToFileURL(documentPath).href,
		logPath,
		spec: {
			id: "fake-typescript",
			command: process.execPath,
			args: [scriptPath, logPath],
			languages: [{ languageId: "typescript", extensions: [".ts"] }],
			requestTimeoutMs: 1_000,
			initializeTimeoutMs: 1_000,
			restart,
		},
	};
}

async function readLog(logPath: string): Promise<Array<{ method: string; id?: number; params?: unknown }>> {
	const text = await fs.readFile(logPath, "utf8");
	return text
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { method: string; id?: number; params?: unknown });
}

describe("direct LSP JSON-RPC client", () => {
	test("handles split and batched frames, interleaved diagnostics, ordered ids, document sync, and shutdown", async () => {
		const fixture = await createFixture();
		const diagnostics: PublishDiagnosticsParams[] = [];
		const root = await canonicalizeWorkspaceRoot(fixture.root);
		const client = await LspClient.start(fixture.spec, root, pathToFileURL(root).href, params => {
			diagnostics.push(params);
		});
		try {
			await client.didOpen({ uri: fixture.documentUri, languageId: "typescript", text: "const oldName = 1;\n" });
			const first = client.hover(fixture.documentUri, { line: 0, character: 1 }) as Promise<{
				requestId: number;
				character: number;
			}>;
			const second = client.hover(fixture.documentUri, { line: 0, character: 2 }) as Promise<{
				requestId: number;
				character: number;
			}>;
			const [firstResult, secondResult] = await Promise.all([first, second]);
			expect(firstResult).toEqual({ requestId: 2, character: 1 });
			expect(secondResult).toEqual({ requestId: 3, character: 2 });
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]?.diagnostics[0]?.message).toBe("interleaved diagnostic");
			expect(toDesktopDiagnostics(diagnostics[0]!)[0]).toMatchObject({
				uri: fixture.documentUri,
				severity: 2,
				startLine: 0,
				startColumn: 0,
				endLine: 0,
				endColumn: 1,
			});

			await client.didChange(fixture.documentUri, [
				{
					range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
					rangeLength: 7,
					text: "newName",
				},
			]);
			await client.didSave(fixture.documentUri, "const newName = 1;\n");
			await client.didClose(fixture.documentUri);
		} finally {
			await client.shutdown();
		}

		const methods = (await readLog(fixture.logPath)).map(message => message.method);
		expect(methods).toEqual([
			"initialize",
			"initialized",
			"textDocument/didOpen",
			"textDocument/hover",
			"textDocument/hover",
			"textDocument/didChange",
			"textDocument/didSave",
			"textDocument/didClose",
			"shutdown",
			"exit",
		]);
		await fs.rm(fixture.directory, { recursive: true, force: true });
	});

	test("sends $/cancelRequest and surfaces caller cancellation", async () => {
		const fixture = await createFixture();
		const root = await canonicalizeWorkspaceRoot(fixture.root);
		const client = await LspClient.start(fixture.spec, root, pathToFileURL(root).href);
		const completionReceived = Promise.withResolvers<number>();
		const cancelled = Promise.withResolvers<number>();
		client.onNotification((notification: LspClientNotification) => {
			const params = notification.params;
			if (
				(notification.method === "test/completion-received" || notification.method === "test/cancelled") &&
				params !== null &&
				typeof params === "object" &&
				"id" in params &&
				typeof params.id === "number"
			) {
				if (notification.method === "test/completion-received") completionReceived.resolve(params.id);
				else cancelled.resolve(params.id);
			}
		});
		try {
			const controller = new AbortController();
			const completion = client.completion(fixture.documentUri, { line: 0, character: 0 }, undefined, {
				signal: controller.signal,
			});
			expect(await completionReceived.promise).toBe(2);
			controller.abort(new Error("cancelled by test"));
			await expect(completion).rejects.toThrow("cancelled by test");
			expect(await cancelled.promise).toBe(2);
		} finally {
			await client.shutdown();
			await fs.rm(fixture.directory, { recursive: true, force: true });
		}
	});

	test("fails pending requests with captured stderr and bounds crash restarts", async () => {
		const fixture = await createFixture({ maxRestarts: 1, windowMs: 10_000, backoffMs: 0 });
		const broker = new LspBroker({ loadServerSpecs: () => [fixture.spec] });
		await broker.openWorkspace("workspace", fixture.root);
		await broker.openDocument("workspace", {
			uri: fixture.documentPath,
			languageId: "typescript",
			text: "const oldName = 1;\n",
		});
		const crashingRequest = {
			workspaceId: "workspace",
			method: "textDocument/definition",
			uri: fixture.documentPath,
			position: { line: 9, column: 0 },
		};
		await expect(broker.requestFromProtocol(crashingRequest)).rejects.toThrow("fake crash on definition");
		await expect(broker.requestFromProtocol(crashingRequest)).rejects.toThrow("fake crash on definition");
		await expect(broker.requestFromProtocol(crashingRequest)).rejects.toThrow("exceeded 1 restarts");
		await broker.shutdown();
		const starts = (await readLog(fixture.logPath)).filter(message => message.method === "initialize");
		expect(starts).toHaveLength(2);
		await fs.rm(fixture.directory, { recursive: true, force: true });
	});

	test("canonicalizes workspace document URIs and rejects symlink escapes", async () => {
		const fixture = await createFixture();
		const outside = path.join(fixture.directory, "outside.ts");
		await fs.writeFile(outside, "export {};\n");
		await fs.symlink(outside, path.join(fixture.root, "escape.ts"));
		const root = await canonicalizeWorkspaceRoot(path.join(fixture.root, "."));
		expect(await canonicalizeDocumentUri("sample file.ts", root)).toBe(pathToFileURL(fixture.documentPath).href);
		await expect(canonicalizeDocumentUri("escape.ts", root)).rejects.toThrow("outside workspace root");
		await expect(canonicalizeDocumentUri("https://example.test/file.ts", root)).rejects.toThrow("Unsupported");
		expect(
			applyContentChanges("a😀b\n", [
				{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, rangeLength: 2, text: "x" },
			]),
		).toBe("axb\n");
		await fs.rm(fixture.directory, { recursive: true, force: true });
	});
});
