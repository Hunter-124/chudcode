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
 * Import this as a namespace (`import * as fsx from "@oh-my-pi/pi-utils/fsx"`):
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

/** Read a UTF-8 text file. */
export function readText(file: PathLike): Promise<string> {
	return fs.readFile(file, "utf8");
}

/** Read and parse a JSON file. */
export async function readJson<T = unknown>(file: PathLike): Promise<T> {
	return JSON.parse(await fs.readFile(file, "utf8")) as T;
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
