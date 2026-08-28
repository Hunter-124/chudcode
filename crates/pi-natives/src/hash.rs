use napi::bindgen_prelude::{Either, Uint8Array};
use napi_derive::napi;
use xxhash_rust::{xxh32::xxh32, xxh64::xxh64};

unsafe extern "C" {
	fn omp_hash_wyhash64(data: *const u8, length: usize, seed: u64) -> u64;
}

/// Bytes of a string or byte-array argument, matching what `Bun.hash` accepted.
enum HashInput<'a> {
	Borrowed(&'a [u8]),
	Owned(Vec<u8>),
}

impl HashInput<'_> {
	fn bytes(&self) -> &[u8] {
		match self {
			HashInput::Borrowed(bytes) => bytes,
			HashInput::Owned(bytes) => bytes,
		}
	}
}

fn input_bytes(value: &Either<String, Uint8Array>) -> HashInput<'_> {
	match value {
		Either::A(text) => HashInput::Owned(text.as_bytes().to_vec()),
		Either::B(bytes) => HashInput::Borrowed(bytes.as_ref()),
	}
}

/// wyhash-64 of `data`, byte-for-byte identical to `Bun.hash()`.
///
/// Returned as a hex string rather than a JS number: the digest is 64-bit and
/// its consumers embed it in persisted names (broker runtime directory, LSP mux
/// socket, composer cache) where a float would lose the low bits.
#[napi]
pub fn hash_wyhash64(
	data: Either<String, Uint8Array>,
	seed: Option<String>,
) -> napi::Result<String> {
	let seed = match seed {
		Some(text) => u64::from_str_radix(
			text.trim_start_matches("0x"),
			if text.starts_with("0x") { 16 } else { 10 },
		)
		.map_err(|error| napi::Error::from_reason(format!("Invalid hash seed '{text}': {error}")))?,
		None => 0,
	};
	let input = input_bytes(&data);
	let bytes = input.bytes();
	// SAFETY: The slice is non-null for a non-empty input and the C reader only
	// reads `length` bytes; an empty input passes a dangling-but-unread pointer,
	// which the length-0 branch never dereferences.
	let digest = unsafe { omp_hash_wyhash64(bytes.as_ptr(), bytes.len(), seed) };
	Ok(format!("{digest:016x}"))
}

/// xxHash64 of `data`, matching `Bun.hash.xxHash64()`.
#[napi]
pub fn hash_xxhash64(
	data: Either<String, Uint8Array>,
	seed: Option<String>,
) -> napi::Result<String> {
	let seed = match seed {
		Some(text) => text.parse::<u64>().map_err(|error| {
			napi::Error::from_reason(format!("Invalid hash seed '{text}': {error}"))
		})?,
		None => 0,
	};
	let input = input_bytes(&data);
	Ok(format!("{:016x}", xxh64(input.bytes(), seed)))
}

/// xxHash32 of `data`, matching `Bun.hash.xxHash32()`.
#[napi]
pub fn hash_xxhash32(data: Either<String, Uint8Array>, seed: Option<u32>) -> u32 {
	let input = input_bytes(&data);
	xxh32(input.bytes(), seed.unwrap_or(0))
}

#[cfg(test)]
mod tests {
	use super::*;

	/// `(input, wyhash seed 0, wyhash seed 7, xxHash64, xxHash32)` as produced
	/// by the Bun builtins these replace. Byte-compatibility is the entire
	/// contract: the digests name persisted directories and stored message ids,
	/// so a regression here silently orphans them rather than failing loudly.
	const BUN_VECTORS: &[(&str, u64, u64, u64, u32)] = &[
		("", 290873116282709081, 12545685757154757589, 17241709254077376921, 46947589),
		("a", 2941419223392617777, 12542608980472701455, 15154266338359012955, 1426945110),
		("abc", 190542993387777138, 11816648454253072001, 4952883123889572249, 852579327),
		("hello world", 7389666205914310003, 3615351916183604134, 5020219685658847592, 3468387874),
		("msg_0123456789", 2908453707762074186, 5536768375414643136, 2642441275143476843, 2085676443),
		("xxxxxxxxxxxxxxxx", 827872304449044717, 3262157922054588742, 392565628354714129, 404385805),
		(
			"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
			680086789126984164,
			15701539045301624487,
			14474974188117071360,
			2408617730,
		),
		(
			"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
			9097929466063971759,
			1889557378991455395,
			6856128287974695777,
			275343152,
		),
		(
			"wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww",
			5604701756356470495,
			3015003063822389629,
			13043127289904703527,
			2940780133,
		),
		("éèê", 13843556365651981986, 8951261783565915740, 2113172694515438287, 854800321),
		(
			r#"{"a":1,"b":[1,2,3]}"#,
			10314042778230248648,
			13776273279942828616,
			17132556477653889574,
			2384166177,
		),
	];

	fn wyhash(input: &str, seed: u64) -> u64 {
		let bytes = input.as_bytes();
		// SAFETY: The slice outlives the call and the C reader reads exactly
		// `len` bytes, never dereferencing the pointer when the length is zero.
		unsafe { omp_hash_wyhash64(bytes.as_ptr(), bytes.len(), seed) }
	}

	#[test]
	fn matches_bun_hash_vectors_across_every_length_branch() {
		for &(input, seed0, seed7, xx64, xx32) in BUN_VECTORS {
			assert_eq!(wyhash(input, 0), seed0, "wyhash seed 0 for {input:?}");
			assert_eq!(wyhash(input, 7), seed7, "wyhash seed 7 for {input:?}");
			assert_eq!(xxh64(input.as_bytes(), 0), xx64, "xxHash64 for {input:?}");
			assert_eq!(xxh32(input.as_bytes(), 0), xx32, "xxHash32 for {input:?}");
		}
	}

	#[test]
	fn covers_the_multi_block_and_long_tail_paths() {
		// 96 bytes exercises the >48 three-lane loop; 257 the loop plus tail.
		assert_eq!(wyhash(&"q".repeat(96), 0), 15738684009790372699);
		assert_eq!(wyhash(&"p".repeat(257), 0), 13365892106009851589);
		assert_eq!(xxh64("q".repeat(96).as_bytes(), 0), 1861228624379141371);
	}
}
