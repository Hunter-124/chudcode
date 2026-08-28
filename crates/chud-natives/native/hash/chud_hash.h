#ifndef CHUDCODE_HASH_H
#define CHUDCODE_HASH_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * wyhash final version 3 with the reference default secret.
 *
 * Byte-for-byte compatible with the `Bun.hash()` / `Bun.hash.wyhash()` this
 * replaces, which matters because the digests name persisted artifacts: the
 * launch broker's runtime directory, the LSP multiplexer socket, the composer
 * cache directory, and synthesized provider message ids inside stored
 * transcripts. A different hash would orphan all of them.
 */
uint64_t chudcode_hash_wyhash64(const uint8_t *data, size_t length, uint64_t seed);

#ifdef __cplusplus
}
#endif

#endif
