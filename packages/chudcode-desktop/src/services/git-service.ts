import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { GitBranch, GitCommit, GitFileState, GitRemote, GitSnapshot } from "../protocol";
import { type DiffFile, parseUnifiedDiff, patchForHunk, type UnifiedDiff } from "./git-diff";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT = 16 * 1024 * 1024;
const STATUS_CODE: Record<string, string> = {
	".": "",
	M: "modified",
	T: "type-changed",
	A: "added",
	D: "deleted",
	R: "renamed",
	C: "copied",
	U: "unmerged",
};

export interface GitServiceOptions {
	gitPath?: string;
	timeoutMs?: number;
	outputLimitBytes?: number;
}

export interface GitOperationOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface GitCommandFailure {
	code: "GIT_COMMAND_FAILED" | "GIT_CANCELLED" | "GIT_TIMEOUT" | "GIT_OUTPUT_LIMIT";
	command: string[];
	exitCode: number | null;
	stderrTail: string;
}

export class GitCommandError extends Error implements GitCommandFailure {
	readonly code: GitCommandFailure["code"];
	readonly command: string[];
	readonly exitCode: number | null;
	readonly stderrTail: string;

	constructor(message: string, failure: GitCommandFailure) {
		super(message);
		this.name = "GitCommandError";
		this.code = failure.code;
		this.command = failure.command;
		this.exitCode = failure.exitCode;
		this.stderrTail = failure.stderrTail;
	}
}

interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface RunnerOptions extends GitOperationOptions {
	stdin?: string;
	acceptedExitCodes?: readonly number[];
}

function redactSecrets(value: string): string {
	return value
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1<redacted>@")
		.replace(/(\b(?:access_token|token|auth|password|oauth2)=)[^\s&]+/gi, "$1<redacted>")
		.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, match => `${match.split(/\s/, 1)[0]} <redacted>`);
}

function safeCommand(gitPath: string, args: readonly string[]): string[] {
	return [gitPath, ...args.map(redactSecrets)];
}

function resolveGitExecutable(explicit?: string): string {
	const candidate = explicit ?? Bun.which("git");
	if (candidate === null || candidate === undefined || candidate.length === 0) {
		throw new Error("Git executable was not found on PATH");
	}
	if (!isAbsolute(candidate)) throw new Error("Git executable path must be absolute");
	return candidate;
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, onLimit: () => void): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const item = await reader.read();
			if (item.done) break;
			length += item.value.byteLength;
			if (length > limit) {
				onLimit();
				throw new Error("GIT_OUTPUT_LIMIT");
			}
			chunks.push(item.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

function processEnvWithoutGitPrompts(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	return env;
}

async function executeGit(
	gitPath: string,
	cwd: string,
	args: readonly string[],
	defaults: Required<Pick<GitServiceOptions, "timeoutMs" | "outputLimitBytes">>,
	options: RunnerOptions = {},
): Promise<CommandResult> {
	const timeoutMs = options.timeoutMs ?? defaults.timeoutMs;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Git timeout must be a positive integer");
	if (!Number.isSafeInteger(defaults.outputLimitBytes) || defaults.outputLimitBytes <= 0) {
		throw new Error("Git output limit must be a positive integer");
	}
	const command = safeCommand(gitPath, args);
	if (options.signal?.aborted) {
		throw new GitCommandError("Git command was cancelled", {
			code: "GIT_CANCELLED",
			command,
			exitCode: null,
			stderrTail: "",
		});
	}

	const controller = new AbortController();
	let timedOut = false;
	let outputLimited = false;
	const cancel = (): void => controller.abort();
	options.signal?.addEventListener("abort", cancel, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	let subprocess: Bun.ReadableSubprocess;
	try {
		subprocess = Bun.spawn({
			cmd: [gitPath, ...args],
			cwd,
			env: {
				...processEnvWithoutGitPrompts(),
				GIT_TERMINAL_PROMPT: "0",
				GCM_INTERACTIVE: "Never",
				GIT_OPTIONAL_LOCKS: "0",
			},
			stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
			stdout: "pipe",
			stderr: "pipe",
			signal: controller.signal,
		});
	} catch (error) {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", cancel);
		const stderrTail = redactSecrets(error instanceof Error ? error.message : String(error)).slice(-4096);
		throw new GitCommandError(stderrTail || "Git process could not be started", {
			code: options.signal?.aborted ? "GIT_CANCELLED" : "GIT_COMMAND_FAILED",
			command,
			exitCode: null,
			stderrTail,
		});
	}

	const stopForLimit = (): void => {
		outputLimited = true;
		subprocess.kill();
	};
	const stdoutPromise = readBounded(subprocess.stdout, defaults.outputLimitBytes, stopForLimit);
	const stderrPromise = readBounded(subprocess.stderr, defaults.outputLimitBytes, stopForLimit);
	const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
		stdoutPromise,
		stderrPromise,
		subprocess.exited,
	]);
	clearTimeout(timeout);
	options.signal?.removeEventListener("abort", cancel);

	const stdout = stdoutResult.status === "fulfilled" ? stdoutResult.value : "";
	const stderr = stderrResult.status === "fulfilled" ? stderrResult.value : "";
	const exitCode = exitResult.status === "fulfilled" ? exitResult.value : null;
	const stderrTail = redactSecrets(stderr).slice(-4096);
	if (outputLimited || stdoutResult.status === "rejected" || stderrResult.status === "rejected") {
		throw new GitCommandError("Git output exceeded the configured limit", {
			code: "GIT_OUTPUT_LIMIT",
			command,
			exitCode,
			stderrTail,
		});
	}
	if (timedOut) {
		throw new GitCommandError(`Git command timed out after ${timeoutMs}ms`, {
			code: "GIT_TIMEOUT",
			command,
			exitCode,
			stderrTail,
		});
	}
	if (options.signal?.aborted) {
		throw new GitCommandError("Git command was cancelled", {
			code: "GIT_CANCELLED",
			command,
			exitCode,
			stderrTail,
		});
	}
	const acceptedExitCodes = options.acceptedExitCodes ?? [0];
	if (exitCode === null || !acceptedExitCodes.includes(exitCode)) {
		throw new GitCommandError(stderrTail || `Git exited with status ${exitCode ?? "unknown"}`, {
			code: "GIT_COMMAND_FAILED",
			command,
			exitCode,
			stderrTail,
		});
	}
	return { stdout, stderr, exitCode };
}

function assertRepoPath(path: string): void {
	if (path.length === 0 || path.includes("\0") || isAbsolute(path)) throw new Error(`Unsafe repository path: ${path}`);
	const components = path.replaceAll("\\", "/").split("/");
	if (components.some(component => component === "..") || components[0] === ".git") {
		throw new Error(`Repository path escapes the worktree: ${path}`);
	}
}

function assertRef(ref: string, kind = "Git ref"): void {
	if (ref.length === 0 || ref.startsWith("-") || ref.includes("\0") || /[\r\n]/.test(ref)) {
		throw new Error(`Unsafe ${kind}: ${ref}`);
	}
}

function assertBranchName(name: string): void {
	assertRef(name, "branch");
	if (
		name === "@" ||
		name.startsWith("/") ||
		name.endsWith("/") ||
		name.endsWith(".") ||
		name.endsWith(".lock") ||
		name.includes("..") ||
		name.includes("@{") ||
		name.includes("//") ||
		/[\x00-\x20\x7f~^:?*[\]\\]/.test(name)
	) {
		throw new Error(`Unsafe branch name: ${name}`);
	}
}

function assertRemote(remote: string): void {
	assertRef(remote, "remote");
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote)) throw new Error(`Unsafe remote name: ${remote}`);
}

function splitStatusRecord(record: string): { fields: string[]; path: string } {
	const fieldCount = record.startsWith("1 ") ? 8 : record.startsWith("2 ") ? 9 : record.startsWith("u ") ? 10 : 0;
	if (fieldCount === 0) throw new Error(`Unsupported porcelain-v2 status record: ${record.slice(0, 120)}`);
	const fields: string[] = [];
	let offset = 0;
	for (let index = 0; index < fieldCount; index += 1) {
		const separator = record.indexOf(" ", offset);
		if (separator < 0) throw new Error(`Malformed porcelain-v2 status record: ${record.slice(0, 120)}`);
		fields.push(record.slice(offset, separator));
		offset = separator + 1;
	}
	return { fields, path: record.slice(offset) };
}

function parseStatus(output: string): Omit<GitSnapshot, "root" | "commits"> {
	let branch = "";
	let upstream: string | undefined;
	let ahead = 0;
	let behind = 0;
	const files: GitFileState[] = [];
	const records = output.split("\0");
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index]!;
		if (record.startsWith("# branch.head ")) {
			branch = record.slice("# branch.head ".length);
			continue;
		}
		if (record.startsWith("# branch.upstream ")) {
			upstream = record.slice("# branch.upstream ".length);
			continue;
		}
		if (record.startsWith("# branch.ab ")) {
			const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
			if (match !== null) {
				ahead = Number(match[1]);
				behind = Number(match[2]);
			}
			continue;
		}
		if (record.startsWith("? ")) {
			files.push({ path: record.slice(2), staged: "", unstaged: "untracked", untracked: true });
			continue;
		}
		if (record.startsWith("! ") || record.startsWith("# ") || record.length === 0) continue;

		const parsed = splitStatusRecord(record);
		const xy = parsed.fields[1]!;
		const path = parsed.path;
		files.push({
			path,
			staged: STATUS_CODE[xy[0]!] ?? xy[0]!,
			unstaged: STATUS_CODE[xy[1]!] ?? xy[1]!,
			untracked: false,
		});
		if (record.startsWith("2 ")) index += 1; // The following NUL field is the original rename/copy path.
	}
	if (branch === "(detached)") branch = "HEAD";
	return upstream === undefined ? { branch, ahead, behind, files } : { branch, upstream, ahead, behind, files };
}

function parseLog(output: string): GitCommit[] {
	if (output.length === 0) return [];
	const fields = output.split("\0");
	const commits: GitCommit[] = [];
	for (let index = 0; index + 5 < fields.length; index += 6) {
		const hash = fields[index]!.replace(/^\n+/, "");
		if (hash.length === 0) continue;
		const parents = fields[index + 1]!.split(" ").filter(Boolean);
		const refs = fields[index + 5]!.split(",")
			.map(ref => ref.trim())
			.filter(Boolean);
		commits.push({
			hash,
			parents,
			author: fields[index + 2]!,
			timestampMs: Number(fields[index + 3]!) * 1000,
			subject: fields[index + 4]!,
			refs,
		});
	}
	return commits;
}

function parseBranches(output: string): GitBranch[] {
	if (output.length === 0) return [];
	const fields = output.split("\0");
	const branches: GitBranch[] = [];
	for (let index = 0; index + 4 < fields.length; index += 5) {
		const name = fields[index]!.replace(/^\n+/, "");
		const fullRef = fields[index + 3]!;
		if (name.length === 0 || fullRef.endsWith("/HEAD")) continue;
		const upstream = fields[index + 1]!;
		const tracking = fields[index + 4]!;
		const aheadMatch = /ahead (\d+)/.exec(tracking);
		const behindMatch = /behind (\d+)/.exec(tracking);
		const branch: GitBranch = {
			name,
			current: fields[index + 2]!.trim() === "*",
			remote: fullRef.startsWith("refs/remotes/"),
		};
		if (upstream.length > 0) branch.upstream = upstream;
		if (aheadMatch !== null) branch.ahead = Number(aheadMatch[1]);
		if (behindMatch !== null) branch.behind = Number(behindMatch[1]);
		branches.push(branch);
	}
	return branches;
}

function fileForPath(diff: UnifiedDiff, path: string): DiffFile {
	const file = diff.files.find(candidate => candidate.oldPath === path || candidate.newPath === path);
	if (file === undefined) throw new Error("Selected hunk is stale or the file no longer has a diff");
	return file;
}

export class GitService {
	readonly root: string;
	readonly gitPath: string;
	readonly #defaults: Required<Pick<GitServiceOptions, "timeoutMs" | "outputLimitBytes">>;

	constructor(root: string, options: GitServiceOptions = {}) {
		if (!isAbsolute(root)) throw new Error("Git repository root must be absolute");
		this.root = resolve(root);
		this.gitPath = resolveGitExecutable(options.gitPath);
		this.#defaults = {
			timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			outputLimitBytes: options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT,
		};
	}

	static async discover(
		startPath: string,
		options: GitServiceOptions = {},
		operation: GitOperationOptions = {},
	): Promise<GitService> {
		const gitPath = resolveGitExecutable(options.gitPath);
		const start = await realpath(resolve(startPath));
		const defaults = {
			timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			outputLimitBytes: options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT,
		};
		const result = await executeGit(gitPath, start, ["rev-parse", "--show-toplevel"], defaults, operation);
		return new GitService(await realpath(result.stdout.trim()), { ...options, gitPath });
	}

	static async init(
		rootPath: string,
		initialBranch = "main",
		options: GitServiceOptions = {},
		operation: GitOperationOptions = {},
	): Promise<GitService> {
		assertBranchName(initialBranch);
		const root = resolve(rootPath);
		await mkdir(root, { recursive: true });
		const gitPath = resolveGitExecutable(options.gitPath);
		const defaults = {
			timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			outputLimitBytes: options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT,
		};
		await executeGit(gitPath, root, ["init", `--initial-branch=${initialBranch}`], defaults, operation);
		return new GitService(await realpath(root), { ...options, gitPath });
	}

	async #run(args: readonly string[], options: RunnerOptions = {}): Promise<CommandResult> {
		return executeGit(this.gitPath, this.root, args, this.#defaults, options);
	}

	async snapshot(options: GitOperationOptions = {}): Promise<GitSnapshot> {
		const statusResult = await this.#run(["status", "--porcelain=v2", "--branch", "-z"], options);
		const status = parseStatus(statusResult.stdout);
		const hasHead = await this.#run(["rev-parse", "--verify", "--quiet", "HEAD"], {
			...options,
			acceptedExitCodes: [0, 1],
		});
		const commits = hasHead.exitCode === 0 ? await this.log(100, options) : [];
		return { root: this.root, ...status, commits };
	}

	async log(limit = 100, options: GitOperationOptions = {}): Promise<GitCommit[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
			throw new Error("Git log limit must be between 1 and 10000");
		const result = await this.#run(
			[
				"log",
				`-n${limit}`,
				"--topo-order",
				"--decorate=full",
				"--format=format:%H%x00%P%x00%an%x00%at%x00%s%x00%D%x00",
			],
			options,
		);
		return parseLog(result.stdout);
	}

	async branches(options: GitOperationOptions = {}): Promise<GitBranch[]> {
		const result = await this.#run(
			[
				"for-each-ref",
				"--sort=-committerdate",
				"--format=%(refname:short)%00%(upstream:short)%00%(HEAD)%00%(refname)%00%(upstream:track,nobracket)%00",
				"refs/heads",
				"refs/remotes",
			],
			options,
		);
		return parseBranches(result.stdout);
	}

	async remotes(options: GitOperationOptions = {}): Promise<GitRemote[]> {
		const result = await this.#run(["remote"], options);
		const names = result.stdout.split("\n").filter(Boolean);
		const remotes: GitRemote[] = [];
		for (const name of names) {
			assertRemote(name);
			const [fetch, push] = await Promise.all([
				this.#run(["remote", "get-url", "--all", name], options),
				this.#run(["remote", "get-url", "--push", "--all", name], options),
			]);
			const fetchUrl = fetch.stdout.split("\n").find(Boolean);
			const pushUrl = push.stdout.split("\n").find(Boolean);
			if (fetchUrl === undefined || pushUrl === undefined) throw new Error(`Remote ${name} has no usable URL`);
			remotes.push({ name, fetchUrl: redactSecrets(fetchUrl), pushUrl: redactSecrets(pushUrl) });
		}
		return remotes;
	}

	async diff(path?: string, staged = false, options: GitOperationOptions = {}): Promise<string> {
		if (path !== undefined) assertRepoPath(path);
		const args = ["diff", "--no-ext-diff", "--no-color", "--unified=3", "--src-prefix=a/", "--dst-prefix=b/"];
		if (staged) args.push("--cached");
		args.push("--");
		if (path !== undefined) args.push(path);
		return (await this.#run(args, options)).stdout;
	}

	async parsedDiff(path?: string, staged = false, options: GitOperationOptions = {}): Promise<UnifiedDiff> {
		return parseUnifiedDiff(await this.diff(path, staged, options));
	}

	async stage(paths: readonly string[], options: GitOperationOptions = {}): Promise<GitSnapshot> {
		if (paths.length === 0) return this.stageAll(options);
		paths.forEach(assertRepoPath);
		await this.#run(["add", "--", ...paths], options);
		return this.snapshot(options);
	}

	async stageAll(options: GitOperationOptions = {}): Promise<GitSnapshot> {
		await this.#run(["add", "-A", "--", "."], options);
		return this.snapshot(options);
	}

	async unstage(paths: readonly string[], options: GitOperationOptions = {}): Promise<GitSnapshot> {
		if (paths.length === 0) return this.unstageAll(options);
		paths.forEach(assertRepoPath);
		const hasHead = await this.#run(["rev-parse", "--verify", "--quiet", "HEAD"], {
			...options,
			acceptedExitCodes: [0, 1],
		});
		if (hasHead.exitCode === 0) await this.#run(["restore", "--staged", "--", ...paths], options);
		else await this.#run(["rm", "--cached", "-r", "--ignore-unmatch", "--", ...paths], options);
		return this.snapshot(options);
	}

	async unstageAll(options: GitOperationOptions = {}): Promise<GitSnapshot> {
		const hasHead = await this.#run(["rev-parse", "--verify", "--quiet", "HEAD"], {
			...options,
			acceptedExitCodes: [0, 1],
		});
		if (hasHead.exitCode === 0) await this.#run(["reset", "--mixed", "--quiet", "HEAD"], options);
		else await this.#run(["rm", "--cached", "-r", "--ignore-unmatch", "--", "."], options);
		return this.snapshot(options);
	}

	async commit(
		message: string,
		options: GitOperationOptions = {},
	): Promise<{ commit: GitCommit; snapshot: GitSnapshot }> {
		if (message.trim().length === 0 || message.includes("\0")) throw new Error("Commit message must not be empty");
		await this.#run(["commit", "--no-gpg-sign", "-m", message], options);
		const [commit] = await this.log(1, options);
		if (commit === undefined) throw new Error("Commit succeeded but HEAD could not be read");
		return { commit, snapshot: await this.snapshot(options) };
	}

	async fetch(remote?: string, options: GitOperationOptions = {}): Promise<GitSnapshot> {
		if (remote !== undefined) assertRemote(remote);
		await this.#run(remote === undefined ? ["fetch", "--prune"] : ["fetch", "--prune", remote], options);
		return this.snapshot(options);
	}

	async pull(remote?: string, branch?: string, options: GitOperationOptions = {}): Promise<GitSnapshot> {
		if (remote !== undefined) assertRemote(remote);
		if (branch !== undefined) assertBranchName(branch);
		if (branch !== undefined && remote === undefined)
			throw new Error("A remote is required when a pull branch is specified");
		const args = ["pull", "--ff-only"];
		if (remote !== undefined) args.push(remote);
		if (branch !== undefined) args.push(branch);
		await this.#run(args, options);
		return this.snapshot(options);
	}

	async push(
		remote?: string,
		branch?: string,
		setUpstream = false,
		options: GitOperationOptions = {},
	): Promise<GitSnapshot> {
		if (remote !== undefined) assertRemote(remote);
		if (branch !== undefined) assertBranchName(branch);
		if (setUpstream && (remote === undefined || branch === undefined)) {
			throw new Error("Setting an upstream requires both remote and branch");
		}
		const args = ["push"];
		if (setUpstream) args.push("--set-upstream");
		if (remote !== undefined) args.push(remote);
		if (branch !== undefined) args.push(branch);
		await this.#run(args, options);
		return this.snapshot(options);
	}

	async checkout(ref: string, options: GitOperationOptions = {}): Promise<GitSnapshot> {
		assertRef(ref);
		await this.#run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], options);
		await this.#run(["checkout", "--no-guess", ref], options);
		return this.snapshot(options);
	}

	async createBranch(
		name: string,
		startPoint?: string,
		checkout = true,
		options: GitOperationOptions = {},
	): Promise<GitSnapshot> {
		assertBranchName(name);
		if (startPoint !== undefined) assertRef(startPoint, "start point");
		const args = checkout ? ["checkout", "-b", name] : ["branch", name];
		if (startPoint !== undefined) args.push(startPoint);
		await this.#run(args, options);
		return this.snapshot(options);
	}

	async stageHunk(path: string, hunkId: string, options: GitOperationOptions = {}): Promise<GitSnapshot> {
		assertRepoPath(path);
		const file = fileForPath(await this.parsedDiff(path, false, options), path);
		await this.#run(["apply", "--cached", "--whitespace=nowarn", "-"], {
			...options,
			stdin: patchForHunk(file, hunkId),
		});
		return this.snapshot(options);
	}

	async unstageHunk(path: string, hunkId: string, options: GitOperationOptions = {}): Promise<GitSnapshot> {
		assertRepoPath(path);
		const file = fileForPath(await this.parsedDiff(path, true, options), path);
		await this.#run(["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"], {
			...options,
			stdin: patchForHunk(file, hunkId),
		});
		return this.snapshot(options);
	}

	async revertHunk(path: string, hunkId: string, options: GitOperationOptions = {}): Promise<GitSnapshot> {
		assertRepoPath(path);
		const file = fileForPath(await this.parsedDiff(path, false, options), path);
		await this.#run(["apply", "--reverse", "--whitespace=nowarn", "-"], {
			...options,
			stdin: patchForHunk(file, hunkId),
		});
		return this.snapshot(options);
	}

	async hunk(
		path: string,
		hunkId: string,
		action: "stage" | "unstage" | "revert",
		options: GitOperationOptions = {},
	): Promise<GitSnapshot> {
		if (action === "stage") return this.stageHunk(path, hunkId, options);
		if (action === "unstage") return this.unstageHunk(path, hunkId, options);
		return this.revertHunk(path, hunkId, options);
	}
}
