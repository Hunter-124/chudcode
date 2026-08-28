import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { isEacces, isEnoent, isEnotdir } from "./fs-error";

/**
 * Host-agnostic file helpers with the semantics call sites were written
 * against, so the repo can leave `Bun.file` / `Bun.write` without auditing every
 * one of them:
 *
 * - {@link write} creates missing parent directories, which `Bun.write` did and
 *   `fs.writeFile` does not.
 * - {@link exists} answers `false` for a missing path instead of throwing, and
 *   for a directory, matching `BunFile.exists()`.
 *
 * Import this as a namespace (`import * as fsx from "@chudware/utils/fsx"`):
 * the short names collide with local helpers across the repo, and a namespace
 * also gives tests one object to stub.
 */

export type PathLike = string | URL;
export type WritableData = string | Uint8Array | ArrayBuffer | DataView | Blob;

async function toBuffer(data: WritableData): Promise<string | Uint8Array> {
	if (typeof data === "string" || data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function toPath(file: PathLike): string {
	return typeof file === "string" ? file : url.fileURLToPath(file);
}

/**
 * Read a UTF-8 text file.
 *
 * A leading byte-order mark is stripped, as `BunFile.text()` did: callers feed
 * the result straight into `JSON.parse` (notebook documents, manifests), which
 * rejects a BOM.
 */
export async function readText(file: PathLike): Promise<string> {
	const text = await fs.readFile(file, "utf8");
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Read and parse a JSON file.
 *
 * The default type parameter is `any`, matching `BunFile.json()` which this
 * replaced: the ~60 call sites inherited from it destructure the result
 * immediately, and `unknown` would demand a hand-written shape at each one
 * without adding any real check. Pass an explicit `T` for new code.
 */
// biome-ignore lint/suspicious/noExplicitAny: parity with the BunFile.json() contract this replaces.
export async function readJson<T = any>(file: PathLike): Promise<T> {
	return JSON.parse(await readText(file)) as T;
}

/** Read a file's bytes. */
export async function readBytes(file: PathLike): Promise<Uint8Array> {
	return new Uint8Array(await fs.readFile(file));
}

/**
 * Whether `file` exists and is a regular file.
 *
 * Matches `BunFile.exists()`, which answered `false` — rather than throwing —
 * for a missing path, an unreadable one (`EACCES`), and one whose parent is a
 * file rather than a directory (`ENOTDIR`).
 */
export async function exists(file: PathLike): Promise<boolean> {
	try {
		return (await fs.stat(file)).isFile();
	} catch (error) {
		if (isEnoent(error) || isEnotdir(error) || isEacces(error)) return false;
		throw error;
	}
}

/** Byte length of `file`, or `undefined` when it does not exist. */
export async function size(file: PathLike): Promise<number | undefined> {
	try {
		return (await fs.stat(file)).size;
	} catch (error) {
		if (isEnoent(error) || isEnotdir(error) || isEacces(error)) return undefined;
		throw error;
	}
}

/** `fs.stat` for a file, mirroring `BunFile.stat()`. */
export function stat(file: PathLike): Promise<Stats> {
	return fs.stat(file);
}

/**
 * Write `data` to `file`, creating parent directories, and return the number of
 * bytes written.
 *
 * When the directory cannot be created, the rejection is the original
 * "destination missing" error with the recovery failure as its `cause` — the
 * shape `Bun.write` produced, which the write-fallback broker branches on to
 * report the underlying denial.
 */
export async function write(file: PathLike, data: WritableData): Promise<number> {
	const bytes = await toBuffer(data);
	try {
		await fs.writeFile(file, bytes);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		try {
			await fs.mkdir(path.dirname(toPath(file)), { recursive: true });
			await fs.writeFile(file, bytes);
		} catch (retryError) {
			throw Object.assign(error, { cause: retryError });
		}
	}
	return typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength;
}

/** Copy `source` to `destination`, creating parent directories. */
export async function copy(source: PathLike, destination: PathLike): Promise<void> {
	try {
		await fs.copyFile(source, destination);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		// A missing source is a real error; only a missing destination directory
		// is recoverable, so re-check the source before creating anything.
		await fs.stat(source);
		await fs.mkdir(path.dirname(toPath(destination)), { recursive: true });
		await fs.copyFile(source, destination);
	}
}
