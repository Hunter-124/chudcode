import * as fs from "node:fs/promises";
import packageJson from "../../package.json" with { type: "json" };

export const VERSION = packageJson.version;
export const getLastChangelogVersionPath = (): string => "";
export const getChangelogPath = (): string | undefined => undefined;
export const isEnoent = (error: unknown): boolean =>
	typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
export const logger = { error: () => {}, warn: () => {} };

/** Namespace-import shape of `@chudware/utils/fsx` used by the changelog module. */
export const readText = (file: string | URL): Promise<string> => fs.readFile(file, "utf8");
