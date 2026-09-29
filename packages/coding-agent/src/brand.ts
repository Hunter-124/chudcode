export const PRODUCT_NAME = "Chudcode";
export const PRODUCT_CLI_NAME = "chud";
export const PRODUCT_COMPATIBILITY_CLI_NAMES = ["chudcode"] as const;
/** This product's release line. `chud update` compares it against GitHub releases. */
export const PRODUCT_SEMVER = "0.3.1";
/** GitHub repository publishing this product's release binaries. */
export const PRODUCT_RELEASE_REPO = "Hunter-124/chudcode";
/** Release tags are namespaced so the `0.x` line cannot collide with inherited `v0.*` tags. */
export const PRODUCT_RELEASE_TAG_PREFIX = "chudcode-v";
export const PRODUCT_VERSION = `${PRODUCT_NAME} v${PRODUCT_SEMVER}`;
export const PRODUCT_CLI_VERSION = PRODUCT_SEMVER;
