#include "chud_hash.h"

#include <string.h>

/*
 * wyhash final version 3 (public domain, Wang Yi). Kept in C so the digest is
 * identical everywhere the repo runs, including a future non-JS host.
 *
 * Portability: the 64x64->128 multiply uses __uint128_t where available and
 * falls back to a 32-bit limb decomposition otherwise, so the result is
 * identical on MSVC and on targets without native 128-bit math.
 */

static const uint64_t CHUDCODE_WY_SECRET[4] = {
	0xa0761d6478bd642full,
	0xe7037ed1a0b428dbull,
	0x8ebc6af09c88c6e3ull,
	0x589965cc75374cc3ull,
};

static void wymum(uint64_t *lhs, uint64_t *rhs) {
#if defined(__SIZEOF_INT128__)
	__uint128_t product = (__uint128_t)*lhs * (__uint128_t)*rhs;
	*lhs = (uint64_t)product;
	*rhs = (uint64_t)(product >> 64);
#else
	uint64_t leftHigh = *lhs >> 32, leftLow = (uint32_t)*lhs;
	uint64_t rightHigh = *rhs >> 32, rightLow = (uint32_t)*rhs;
	uint64_t highHigh = leftHigh * rightHigh;
	uint64_t highLow = leftHigh * rightLow;
	uint64_t lowHigh = leftLow * rightHigh;
	uint64_t lowLow = leftLow * rightLow;
	uint64_t cross = (lowLow >> 32) + (uint32_t)highLow + (uint32_t)lowHigh;
	*lhs = (cross << 32) | (uint32_t)lowLow;
	*rhs = highHigh + (cross >> 32) + (highLow >> 32) + (lowHigh >> 32);
#endif
}

static uint64_t wymix(uint64_t lhs, uint64_t rhs) {
	wymum(&lhs, &rhs);
	return lhs ^ rhs;
}

static uint64_t wyread8(const uint8_t *data) {
	uint64_t value;
	memcpy(&value, data, 8);
	return value;
}

static uint64_t wyread4(const uint8_t *data) {
	uint32_t value;
	memcpy(&value, data, 4);
	return value;
}

static uint64_t wyread3(const uint8_t *data, size_t length) {
	return (((uint64_t)data[0]) << 16) | (((uint64_t)data[length >> 1]) << 8) | data[length - 1];
}

uint64_t chudcode_hash_wyhash64(const uint8_t *data, size_t length, uint64_t seed) {
	const uint8_t *cursor = data;
	uint64_t a;
	uint64_t b;

	seed ^= wymix(seed ^ CHUDCODE_WY_SECRET[0], CHUDCODE_WY_SECRET[1]);
	if (length <= 16) {
		if (length >= 4) {
			a = (wyread4(cursor) << 32) | wyread4(cursor + ((length >> 3) << 2));
			b = (wyread4(cursor + length - 4) << 32) | wyread4(cursor + length - 4 - ((length >> 3) << 2));
		} else if (length > 0) {
			a = wyread3(cursor, length);
			b = 0;
		} else {
			a = 0;
			b = 0;
		}
	} else {
		size_t remaining = length;
		if (remaining > 48) {
			uint64_t seed1 = seed;
			uint64_t seed2 = seed;
			do {
				seed = wymix(wyread8(cursor) ^ CHUDCODE_WY_SECRET[1], wyread8(cursor + 8) ^ seed);
				seed1 = wymix(wyread8(cursor + 16) ^ CHUDCODE_WY_SECRET[2], wyread8(cursor + 24) ^ seed1);
				seed2 = wymix(wyread8(cursor + 32) ^ CHUDCODE_WY_SECRET[3], wyread8(cursor + 40) ^ seed2);
				cursor += 48;
				remaining -= 48;
			} while (remaining > 48);
			seed ^= seed1 ^ seed2;
		}
		while (remaining > 16) {
			seed = wymix(wyread8(cursor) ^ CHUDCODE_WY_SECRET[1], wyread8(cursor + 8) ^ seed);
			remaining -= 16;
			cursor += 16;
		}
		a = wyread8(cursor + remaining - 16);
		b = wyread8(cursor + remaining - 8);
	}

	a ^= CHUDCODE_WY_SECRET[1];
	b ^= seed;
	wymum(&a, &b);
	return wymix(a ^ CHUDCODE_WY_SECRET[0] ^ length, b ^ CHUDCODE_WY_SECRET[1]);
}
