export const PRODUCT_NAME = "Chudcode";
export const PRODUCT_CLI_NAME = "chudcode";
export const PRODUCT_COMPATIBILITY_CLI_NAMES = ["chudware-code", "chcode", "omp"] as const;
/**
 * This fork's own release line. Deliberately independent of the workspace
 * package version, which keeps tracking the upstream omp release the fork is
 * based on. `chudcode update` compares this against the fork's GitHub releases.
 */
export const PRODUCT_SEMVER = "0.2.0";
/** Upstream omp release this fork is based on. */
export const PRODUCT_UPSTREAM_BASE = "18.0.8";
/**
 * GitHub repository publishing this fork's release binaries. The updater reads
 * releases from here — never from upstream, whose assets are named `omp-*` and
 * whose versions live on a different line entirely.
 */
export const PRODUCT_RELEASE_REPO = "Hunter-124/chudcode";
/**
 * Release tags are namespaced. This fork's `0.x` line collides with 193
 * inherited upstream `v0.*` tags (upstream ran 0.0.1 through 0.50.1 before
 * moving to 18.x), so a bare `v0.2.0` tag would have to overwrite upstream
 * history to be published at all.
 */
export const PRODUCT_RELEASE_TAG_PREFIX = "chudcode-v";
export const PRODUCT_VERSION = `${PRODUCT_NAME} v${PRODUCT_SEMVER} (based on omp ${PRODUCT_UPSTREAM_BASE})`;
export const PRODUCT_CLI_VERSION = PRODUCT_VERSION.slice(`${PRODUCT_NAME} v`.length);
