export const PRODUCT_NAME = "Chudcode";
export const PRODUCT_CLI_NAME = "chud";
/** This product's release line; upstream's runtime VERSION is independent. */
export const PRODUCT_SEMVER = "0.4.4";
export const PRODUCT_VERSION = `${PRODUCT_NAME} v${PRODUCT_SEMVER}`;
export const PRODUCT_RELEASE_REPO = "Hunter-124/chudcode";
export const PRODUCT_RELEASE_TAG_PREFIX = "chudcode-v";
/** Release asset names are independent of the installed CLI command name. */
export const PRODUCT_RELEASE_ASSET_PREFIX = "chudcode";

export interface ReleaseBinaryTarget {
	platform: string;
	arch: string;
	musl?: boolean;
}

export function releaseBinaryName(target: ReleaseBinaryTarget): string {
	if (target.arch !== "x64") throw new Error(`Unsupported release architecture: ${target.arch}`);
	let os: string;
	switch (target.platform) {
		case "linux":
			if (target.musl) throw new Error("No musl Linux release binary is published");
			os = "linux";
			break;
		case "darwin":
			os = "darwin";
			break;
		case "win32":
			os = "windows";
			break;
		default:
			throw new Error(`Unsupported release platform: ${target.platform}`);
	}
	return `${PRODUCT_RELEASE_ASSET_PREFIX}-${os}-x64${os === "windows" ? ".exe" : ""}`;
}
