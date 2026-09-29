export const PRODUCT_NAME = "Chudcode";
export const PRODUCT_CLI_NAME = "chud";
export const PRODUCT_COMPATIBILITY_CLI_NAMES = ["chudcode"] as const;
/** This product's release line. `chud update` compares it against GitHub releases. */
export const PRODUCT_SEMVER = "0.3.3";
/** GitHub repository publishing this product's release binaries. */
export const PRODUCT_RELEASE_REPO = "Hunter-124/chudcode";
/** Release tags are namespaced so the `0.x` line cannot collide with inherited `v0.*` tags. */
export const PRODUCT_RELEASE_TAG_PREFIX = "chudcode-v";
/**
 * Basename prefix of the CLI binaries published as GitHub release assets.
 *
 * Deliberately independent of {@link PRODUCT_CLI_NAME}. The command was renamed
 * `chudcode` → `chud`, but every release — v0.1.0 through v0.3.0 — publishes
 * `chudcode-<os>-<arch>`, and so do `scripts/ci-release-build-binaries.ts`,
 * `.github/workflows/ci.yml` and `scripts/install.sh`. While the updater
 * derived the asset name from the command name, every shipped binary asked
 * GitHub for `chud-linux-x64` and failed self-update with
 * `has 0 assets named chud-linux-x64`.
 */
export const PRODUCT_RELEASE_ASSET_PREFIX = "chudcode";

/** Build target a release binary is published for. */
export interface ReleaseBinaryTarget {
	/** `process.platform` value. */
	platform: string;
	/** `process.arch` value. */
	arch: string;
	/** Linux only: the musl-libc build rather than the glibc one. */
	musl?: boolean;
}

/**
 * Release asset basename for a build target, e.g. `chudcode-linux-x64`.
 *
 * The single source of truth shared by the updater's download and the release
 * pipeline's outfiles; a rename on one side without the other strands every
 * installed binary on its current version.
 */
export function releaseBinaryName(target: ReleaseBinaryTarget): string {
	let os: string;
	switch (target.platform) {
		case "linux":
			os = target.musl ? "linux-musl" : "linux";
			break;
		case "darwin":
			os = "darwin";
			break;
		case "win32":
			os = "windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${target.platform}`);
	}
	if (target.arch !== "x64" && target.arch !== "arm64") {
		throw new Error(`Unsupported architecture: ${target.arch}`);
	}
	const suffix = os === "windows" ? ".exe" : "";
	return `${PRODUCT_RELEASE_ASSET_PREFIX}-${os}-${target.arch}${suffix}`;
}

export const PRODUCT_VERSION = `${PRODUCT_NAME} v${PRODUCT_SEMVER}`;
export const PRODUCT_CLI_VERSION = PRODUCT_SEMVER;
