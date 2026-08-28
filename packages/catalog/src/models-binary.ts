import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { MappedModelCatalog } from "@chudware/natives";
import { getCatalogCacheDir } from "@chudware/utils/dirs";
import modelsAsset from "./models.bin" with { type: "file" };
import {
	BUNDLED_MODELS_BIN_BYTES,
	BUNDLED_MODELS_BIN_SCHEMA_VERSION,
	BUNDLED_MODELS_BIN_SHA256,
} from "./models-bin-meta";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function openCurrentCacheTarget(targetPath: string): MappedModelCatalog | null {
	try {
		const stat = fs.statSync(targetPath);
		if (!stat.isFile() || stat.size !== BUNDLED_MODELS_BIN_BYTES) return null;
		return new MappedModelCatalog(targetPath);
	} catch {
		return null;
	}
}

function stageCatalog(cacheRoot: string, bytes: Uint8Array): MappedModelCatalog {
	const targetDir = path.join(cacheRoot, BUNDLED_MODELS_BIN_SHA256);
	const targetPath = path.join(targetDir, "models.bin");
	fs.mkdirSync(targetDir, { recursive: true });
	const current = openCurrentCacheTarget(targetPath);
	if (current !== null) return current;

	fs.rmSync(targetPath, { force: true });
	const temporaryPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
	try {
		fs.writeFileSync(temporaryPath, bytes, { flag: "wx", mode: 0o644 });
		try {
			fs.renameSync(temporaryPath, targetPath);
		} catch (renameError) {
			const concurrentWinner = openCurrentCacheTarget(targetPath);
			if (concurrentWinner !== null) return concurrentWinner;
			throw renameError;
		}
		return new MappedModelCatalog(targetPath);
	} finally {
		// A successful rename already consumed this path. Concurrent losers remove
		// only their own uniquely named temporary file.
		fs.rmSync(temporaryPath, { force: true });
	}
}

/** Open the generated catalog synchronously for import-time bundled model access. */
export function openBundledModelCatalog(): MappedModelCatalog {
	const assetPath = path.isAbsolute(modelsAsset)
		? modelsAsset
		: url.fileURLToPath(new URL(modelsAsset, import.meta.url));
	const attempts: string[] = [];
	try {
		const stat = fs.statSync(assetPath);
		if (stat.isFile()) {
			try {
				return new MappedModelCatalog(assetPath);
			} catch (error) {
				attempts.push(`direct file '${assetPath}': ${errorMessage(error)}`);
			}
		}
	} catch (error) {
		attempts.push(`asset stat '${assetPath}': ${errorMessage(error)}`);
	}

	let bytes: Uint8Array;
	try {
		bytes = fs.readFileSync(assetPath);
	} catch (error) {
		throw new Error(
			`Could not read bundled model catalog asset '${assetPath}' for schema ${BUNDLED_MODELS_BIN_SCHEMA_VERSION}: ${errorMessage(error)}`,
		);
	}
	if (bytes.byteLength !== BUNDLED_MODELS_BIN_BYTES) {
		throw new Error(
			`Bundled model catalog asset '${assetPath}' has ${bytes.byteLength} bytes; expected ${BUNDLED_MODELS_BIN_BYTES} for schema ${BUNDLED_MODELS_BIN_SCHEMA_VERSION}`,
		);
	}

	const cacheRoots = [getCatalogCacheDir(), path.join(os.tmpdir(), "chudcode-catalog")];
	for (const cacheRoot of cacheRoots) {
		try {
			return stageCatalog(cacheRoot, bytes);
		} catch (error) {
			attempts.push(`cache '${cacheRoot}': ${errorMessage(error)}`);
		}
	}

	try {
		return MappedModelCatalog.fromBytes(bytes);
	} catch (error) {
		attempts.push(`owned-memory fallback: ${errorMessage(error)}`);
		throw new Error(
			`Could not open bundled model catalog asset '${assetPath}' (schema ${BUNDLED_MODELS_BIN_SCHEMA_VERSION}): ${attempts.join("; ")}`,
		);
	}
}
