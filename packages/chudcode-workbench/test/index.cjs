"use strict";

// Loaded by Code-OSS's actual --extensionTestsPath runner, not node:test.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

const sha256 = text => crypto.createHash("sha256").update(text, "utf8").digest("hex");

async function run() {
	const evidencePath = process.env.CHUDCODE_QUALIFICATION_EVIDENCE;
	const isolatedRoot = process.env.CHUDCODE_QUALIFICATION_ROOT;
	assert.ok(
		evidencePath && isolatedRoot,
		"Use test/run_extension_host.py so the host and service have isolated state",
	);
	assert.equal(
		process.env.BUN_BE_BUN,
		undefined,
		"Native launcher must remove inherited Bun runtime overrides before starting the editor",
	);
	assert.equal(vscode.workspace.isTrusted, true, "Integration workspace must be explicitly trusted");
	assert.equal(vscode.workspace.workspaceFolders?.length, 1, "Exactly one isolated workspace is required");
	const folder = vscode.workspace.workspaceFolders[0];
	const cwd = await fs.realpath(folder.uri.fsPath);
	const root = await fs.realpath(isolatedRoot);
	assert.equal(cwd, path.join(root, "workspace"), "Never run qualification against a user workspace");

	const evidence = {
		qualification: "real-code-oss-extension-host-only",
		stable_ready: false,
		provider_turns: 0,
		checks: [],
		request_ms: [],
		timing_policy: "observations only; no performance threshold",
	};
	const extension = vscode.extensions.getExtension("chudware.chudcode-workbench");
	assert.ok(extension, "Candidate built-in chudware.chudcode-workbench extension is missing");
	const started = performance.now();
	const api = await extension.activate();
	assert.ok(
		api && typeof api.whenReady === "function" && typeof api.request === "function",
		"Extension does not expose its real service consumer API",
	);
	await api.whenReady();
	evidence.ready_ms = performance.now() - started;
	assert.equal(api.serviceState, "ready", "Real desktop service did not become ready");
	evidence.checks.push("real service activation and readiness");

	async function request(method, params) {
		const requested = performance.now();
		try {
			return await api.request(method, params);
		} finally {
			evidence.request_ms.push({ method, ms: performance.now() - requested });
		}
	}

	assert.deepEqual(await request("runtime.hello", { protocol: 1 }), { protocol: 1, product: "Chudcode" });
	await assert.rejects(request("runtime.hello", { protocol: 999 }), /protocol/i);
	assert.equal(api.serviceState, "ready", "Protocol rejection must not hide a service crash");
	evidence.checks.push("real Desktop protocol handshake and incompatible protocol rejection");

	const opened = await request("workspace.open", { rootPath: cwd });
	assert.equal(await fs.realpath(opened.workspace.rootPath), cwd);
	assert.ok(typeof opened.workspace.id === "string" && opened.workspace.id.length > 0);
	const workspaceId = opened.workspace.id;
	const file = vscode.Uri.file(path.join(cwd, "qualification.txt"));
	const initial = "Real isolated Code-OSS workspace\n";
	const saved = "Saved through the native workbench document API\n";
	const written = "Written through the real desktop service\n";
	const external = "External update that must not be overwritten\n";
	assert.equal(await fs.readFile(file.fsPath, "utf8"), initial);
	const document = await vscode.workspace.openTextDocument(file);
	await vscode.window.showTextDocument(document, { preview: false });
	const edit = new vscode.WorkspaceEdit();
	edit.replace(file, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), saved);
	assert.equal(await vscode.workspace.applyEdit(edit), true);
	assert.equal(await document.save(), true, "Native editor must save the real file");
	assert.equal(await fs.readFile(file.fsPath, "utf8"), saved);
	evidence.checks.push("native Code-OSS document edit and save");

	const read = await request("workspace.read", { workspaceId, uri: file.toString() });
	assert.equal(read.document.text, saved);
	assert.equal(read.document.stamp.sha256, sha256(saved));
	const write = await request("workspace.write", {
		workspaceId,
		uri: file.toString(),
		text: written,
		expectedSha256: read.document.stamp.sha256,
	});
	assert.equal(write.stamp.sha256, sha256(written));
	assert.equal(await fs.readFile(file.fsPath, "utf8"), written, "Service write must affect the actual workspace file");
	await fs.writeFile(file.fsPath, external, "utf8");
	await assert.rejects(
		request("workspace.write", {
			workspaceId,
			uri: file.toString(),
			text: "Must not overwrite a stale read\n",
			expectedSha256: write.stamp.sha256,
		}),
		/changed since it was read/i,
	);
	assert.equal(await fs.readFile(file.fsPath, "utf8"), external, "Hash conflict must leave external data untouched");
	const refreshed = await request("workspace.read", { workspaceId, uri: file.toString() });
	assert.equal(refreshed.document.text, external);
	assert.equal(refreshed.document.stamp.sha256, sha256(external));
	const outside = vscode.Uri.file(path.join(root, "outside.txt"));
	await assert.rejects(request("workspace.read", { workspaceId, uri: outside.toString() }), /outside the workspace/i);
	assert.equal(await fs.readFile(outside.fsPath, "utf8"), "Outside workspace sentinel\n");
	assert.equal(api.serviceState, "ready");
	evidence.checks.push("real workspace read/write hashes, stale-write rejection, and path containment");

	const first = (await vscode.commands.executeCommand("chudcode.newSession")).session;
	assert.ok(
		first && typeof first.id === "string" && path.isAbsolute(first.path),
		"New Session command must return a real service-created session",
	);
	assert.equal(await fs.realpath(first.cwd), cwd);
	const firstRelative = path.relative(root, await fs.realpath(first.path));
	assert.ok(
		firstRelative && !path.isAbsolute(firstRelative) && !firstRelative.startsWith(".."),
		"Session must live only in isolated state",
	);
	await fs.access(first.path);
	const selected = await request("session.select", { path: first.path });
	assert.equal(selected.header.id, first.id);
	assert.ok(Array.isArray(selected.entries));
	const firstDraft = await request("session.tab.draft", { path: first.path, dirty: true });
	assert.equal(firstDraft.tabs.find(tab => tab.path === first.path).draftDirty, true);
	const second = (await request("session.new", { cwd })).session;
	assert.notEqual(second.id, first.id);
	assert.notEqual(second.path, first.path);
	const secondRelative = path.relative(root, await fs.realpath(second.path));
	assert.ok(
		secondRelative && !path.isAbsolute(secondRelative) && !secondRelative.startsWith(".."),
		"Second session must live only in isolated state",
	);
	await fs.access(second.path);
	let tabs = (await request("session.tabs", {})).tabs;
	assert.equal(tabs.find(tab => tab.path === second.path).active, true);
	assert.equal(
		tabs.find(tab => tab.path === first.path).draftDirty,
		true,
		"Switching sessions must preserve dirty draft state",
	);
	assert.equal(tabs.find(tab => tab.path === first.path).active, false);
	const blocked = await request("session.tab.close", { path: first.path });
	assert.equal(blocked.closed, false);
	assert.equal(blocked.blockedReason, "dirty-draft");
	tabs = (await request("session.activate", { path: first.path })).tabs;
	assert.equal(tabs.find(tab => tab.path === first.path).active, true);
	assert.equal(tabs.find(tab => tab.path === first.path).draftDirty, true);
	const sessions = (await request("session.list", { cwd })).sessions;
	assert.ok(sessions.some(session => session.path === first.path));
	assert.ok(sessions.some(session => session.path === second.path));
	await request("session.tab.draft", { path: first.path, dirty: false });
	assert.equal((await request("session.tab.close", { path: first.path })).closed, true);
	await request("session.activate", { path: first.path });
	assert.equal(
		(await request("session.select", { path: first.path })).header.id,
		first.id,
		"Closed persisted session must reopen with its original identity",
	);
	evidence.checks.push("real session creation, persisted selection, dirty drafts, switch, guarded close, and reopen");

	// Empty tabs are a session state transition, not a disconnected workspace.
	tabs = (await request("session.tabs", {})).tabs;
	for (const tab of tabs) {
		await request("session.tab.draft", { path: tab.path, dirty: false });
		const closed = await request("session.tab.close", { path: tab.path });
		assert.equal(closed.closed, true);
		assert.equal(
			closed.tabs.some(candidate => candidate.path === tab.path),
			false,
		);
	}
	assert.deepEqual((await request("session.tabs", {})).tabs, [], "The last close must leave zero active tabs");
	assert.equal(api.serviceState, "ready", "Closing the last session must not disconnect the workspace service");
	assert.deepEqual(await request("runtime.hello", { protocol: 1 }), { protocol: 1, product: "Chudcode" });
	const emptyWorkspace = (await request("workspace.open", { rootPath: cwd })).workspace;
	assert.equal(emptyWorkspace.id, workspaceId, "The open workspace must outlive its last session");
	assert.equal(await fs.realpath(emptyWorkspace.rootPath), cwd);
	const emptyCatalog = (await request("session.list", { cwd })).sessions;
	assert.ok(emptyCatalog.some(session => session.path === first.path));
	assert.ok(emptyCatalog.some(session => session.path === second.path));
	const emptyGraph = (await request("graph.snapshot", { workspaceId, kind: "agent" })).graph;
	assert.ok(Number.isInteger(emptyGraph.revision) && emptyGraph.revision > 0);
	assert.ok(Array.isArray(emptyGraph.nodes) && Array.isArray(emptyGraph.edges));
	assert.deepEqual((await request("session.tabs", {})).tabs, [], "Graph queries must not manufacture a session");

	const afterEmpty = (await vscode.commands.executeCommand("chudcode.newSession")).session;
	assert.notEqual(afterEmpty.path, first.path);
	assert.notEqual(afterEmpty.path, second.path);
	assert.equal(await fs.realpath(afterEmpty.cwd), cwd);
	tabs = (await request("session.tabs", {})).tabs;
	assert.equal(tabs.length, 1, "New Session must work with no existing tabs");
	assert.equal(tabs[0].path, afterEmpty.path);
	assert.equal(tabs[0].active, true);
	assert.equal((await request("session.tab.close", { path: afterEmpty.path })).closed, true);
	assert.deepEqual((await request("session.tabs", {})).tabs, []);
	const afterEmptySelection = await request("session.select", { path: first.path });
	assert.equal(afterEmptySelection.header.id, first.id);
	tabs = (await request("session.tabs", {})).tabs;
	assert.equal(tabs.length, 1, "Selecting a persisted session must work with no existing tabs");
	assert.equal(tabs[0].path, first.path);
	assert.equal(tabs[0].active, true);
	const reopenedGraph = (await request("graph.snapshot", { workspaceId, kind: "agent" })).graph;
	assert.ok(reopenedGraph.revision > emptyGraph.revision, "The same workspace graph must continue advancing");
	evidence.checks.push("last-tab close preserves workspace/catalog/graph and permits new and persisted sessions");

	await vscode.commands.executeCommand("chudcode.showSessions");
	await vscode.commands.executeCommand("chudcode.showTasks");
	await vscode.commands.executeCommand("chudcode.showGraphs");
	await vscode.commands.executeCommand("chudcode.openChat");
	evidence.checks.push("registered workbench chat/sessions/tasks/graphs view commands");
	assert.equal(api.serviceState, "ready");
	assert.equal((await request("session.tab.close", { path: first.path })).closed, true);
	assert.deepEqual((await request("session.tabs", {})).tabs, [], "Reconnect coverage must begin with zero tabs");
	await vscode.commands.executeCommand("chudcode.restartService");
	await api.whenReady();
	assert.equal(api.serviceState, "ready", "Explicit restart must start a new real service");
	assert.deepEqual(await request("runtime.hello", { protocol: 1 }), { protocol: 1, product: "Chudcode" });
	const restored = (await request("session.list", { cwd })).sessions;
	assert.ok(
		restored.some(session => session.path === first.path),
		"Real sessions must survive service replacement",
	);
	assert.ok(restored.some(session => session.path === second.path));
	assert.ok(restored.some(session => session.path === afterEmpty.path));
	const restartedWorkspace = (await request("workspace.open", { rootPath: cwd })).workspace;
	assert.equal(await fs.realpath(restartedWorkspace.rootPath), cwd);
	const restartedGraph = (await request("graph.snapshot", { workspaceId: restartedWorkspace.id, kind: "agent" }))
		.graph;
	assert.ok(Number.isInteger(restartedGraph.revision) && restartedGraph.revision > 0);
	assert.equal((await request("session.select", { path: first.path })).header.id, first.id);
	const restartedTabs = (await request("session.tabs", {})).tabs;
	assert.equal(restartedTabs.find(tab => tab.path === first.path).active, true);
	assert.equal(await fs.readFile(file.fsPath, "utf8"), external);
	evidence.checks.push(
		"explicit real service restart from zero tabs, persisted catalog, workspace graph, and selection",
	);
	await fs.writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { encoding: "utf8", flag: "wx" });
}

module.exports = { run };
