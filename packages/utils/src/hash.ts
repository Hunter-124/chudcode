import * as zlib from "node:zlib";

/**
 * Non-cryptographic checksums that do not depend on the native addon.
 *
 * This module stays free of `@oh-my-pi/pi-natives` on purpose: it sits on the
 * CLI's cold-start path, and the startup contract (asserted by the
 * profile-bootstrap and computer-worker laziness probes) is that ordinary CLI
 * paths never `dlopen` the addon. The 64-bit hashes still needed by call sites
 * live in the addon as `hashWyhash64` / `hashXxhash64` for callers that already
 * load it — and in `native/hash/omp_hash.c` for the native host.
 */

export type HashInput = string | Uint8Array;

/**
 * CRC-32 (IEEE), matching `Bun.hash.crc32()`.
 *
 * `previous` continues a running checksum, so chunked archive checksums chain
 * exactly as they did before. It is forwarded only when supplied: `zlib.crc32`
 * rejects an explicit `undefined`.
 */
export function crc32(data: HashInput, previous?: number): number {
	return previous === undefined ? zlib.crc32(data) : zlib.crc32(data, previous);
}
