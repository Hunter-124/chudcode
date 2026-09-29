use std::{
	ffi::{CStr, CString, c_char, c_int},
	ptr::{NonNull, null_mut},
	slice, str,
};

use napi::bindgen_prelude::{Either, Result, Uint8Array, Undefined};
use napi_derive::napi;

const ERROR_CAPACITY: usize = 512;

#[repr(C)]
struct ChudCatalog {
	_private: [u8; 0],
}

#[derive(Clone, Copy, Default)]
#[repr(C)]
struct ChudCatalogSlice {
	data:   *const u8,
	length: usize,
}

unsafe extern "C" {
	fn chudcode_catalog_open_file(
		utf8_path: *const c_char,
		out: *mut *mut ChudCatalog,
		error: *mut c_char,
		error_capacity: usize,
	) -> c_int;
	fn chudcode_catalog_open_memory(
		bytes: *const u8,
		length: usize,
		out: *mut *mut ChudCatalog,
		error: *mut c_char,
		error_capacity: usize,
	) -> c_int;
	fn chudcode_catalog_close(catalog: *mut ChudCatalog);
	fn chudcode_catalog_provider_count(catalog: *const ChudCatalog) -> usize;
	fn chudcode_catalog_provider_at(
		catalog: *const ChudCatalog,
		index: usize,
		name: *mut ChudCatalogSlice,
		ordinal: *mut u32,
	) -> c_int;
	fn chudcode_catalog_provider_payload(
		catalog: *const ChudCatalog,
		name: *const u8,
		name_length: usize,
		payload: *mut ChudCatalogSlice,
	) -> c_int;
	fn chudcode_catalog_mapped_bytes(catalog: *const ChudCatalog) -> usize;
	fn chudcode_catalog_is_file_backed(catalog: *const ChudCatalog) -> c_int;
}

fn open_catalog(
	context: &str,
	open: impl FnOnce(*mut *mut ChudCatalog, *mut c_char, usize) -> c_int,
) -> Result<NonNull<ChudCatalog>> {
	let mut native_handle = null_mut();
	let mut error = [0 as c_char; ERROR_CAPACITY];
	let status = open(&raw mut native_handle, error.as_mut_ptr(), error.len());
	if status != 0 {
		// SAFETY: The zero-initialized buffer is always NUL-terminated, and the C
		// API additionally guarantees bounded writes with a trailing NUL.
		let detail = unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy();
		let detail = if detail.is_empty() {
			"unknown native error".into()
		} else {
			detail
		};
		return Err(napi::Error::from_reason(format!("{context}: {detail}")));
	}
	NonNull::new(native_handle).ok_or_else(|| {
		napi::Error::from_reason(format!("{context}: native reader returned a null handle"))
	})
}

fn slice_to_string(value: ChudCatalogSlice, context: &str) -> Result<String> {
	if value.length == 0 {
		return Ok(String::new());
	}
	if value.data.is_null() {
		return Err(napi::Error::from_reason(format!(
			"{context}: native reader returned a null slice"
		)));
	}
	// SAFETY: The C reader returns a validated in-bounds slice borrowing the
	// immutable catalog mapping. Callers invoke this only while `self.handle` is
	// alive, and the bytes are copied into a Rust String before returning.
	let bytes = unsafe { slice::from_raw_parts(value.data, value.length) };
	str::from_utf8(bytes)
		.map(str::to_owned)
		.map_err(|error| napi::Error::from_reason(format!("{context}: invalid UTF-8: {error}")))
}

/// Owning view of a validated binary model catalog.
#[napi]
pub struct MappedModelCatalog {
	handle: NonNull<ChudCatalog>,
}

// SAFETY: The C handle owns an immutable mapping or immutable copied buffer.
// Every method is read-only, and `Drop` is the sole operation that closes it.
unsafe impl Send for MappedModelCatalog {}
// SAFETY: Shared access only reads the immutable C handle and borrowed slices;
// no native method mutates mapping or index state.
unsafe impl Sync for MappedModelCatalog {}

#[napi]
impl MappedModelCatalog {
	/// Open and memory-map a binary model catalog file.
	#[napi(constructor)]
	pub fn new(path: String) -> Result<Self> {
		let native_path = CString::new(path.as_bytes())
			.map_err(|_| napi::Error::from_reason("Catalog path contains an interior NUL byte"))?;
		let handle = open_catalog("Could not open model catalog file", |out, error, capacity| {
			// SAFETY: `native_path` remains alive for the call; the output and error
			// buffers are valid for the lengths passed to the C ABI.
			unsafe { chudcode_catalog_open_file(native_path.as_ptr(), out, error, capacity) }
		})?;
		Ok(Self { handle })
	}

	/// Copy and open a binary model catalog from bytes.
	#[napi(factory)]
	pub fn from_bytes(bytes: Uint8Array) -> Result<Self> {
		let handle = open_catalog("Could not open model catalog bytes", |out, error, capacity| {
			// SAFETY: The Uint8Array remains alive for the call, and the C ABI copies
			// the full input before returning.
			unsafe { chudcode_catalog_open_memory(bytes.as_ptr(), bytes.len(), out, error, capacity) }
		})?;
		Ok(Self { handle })
	}

	/// Provider IDs in the binary index's stable insertion order.
	#[napi]
	pub fn provider_ids(&self) -> Result<Vec<String>> {
		// SAFETY: `self.handle` remains valid for this method call.
		let count = unsafe { chudcode_catalog_provider_count(self.handle.as_ptr()) };
		let mut providers = Vec::with_capacity(count);
		for index in 0..count {
			let mut name = ChudCatalogSlice::default();
			let mut ordinal = 0;
			// SAFETY: Output pointers are valid, and the checked index is below the
			// count reported by the same immutable handle.
			let status = unsafe {
				chudcode_catalog_provider_at(
					self.handle.as_ptr(),
					index,
					&raw mut name,
					&raw mut ordinal,
				)
			};
			if status != 0 || ordinal as usize != index {
				return Err(napi::Error::from_reason(format!(
					"Could not read model catalog provider at index {index}"
				)));
			}
			providers.push(slice_to_string(name, &format!("Model catalog provider {index}"))?);
		}
		Ok(providers)
	}

	/// Compact JSON object for one provider, or `undefined` when absent.
	#[napi]
	pub fn provider_json(&self, provider: String) -> Result<Either<String, Undefined>> {
		let mut payload = ChudCatalogSlice::default();
		// SAFETY: The provider bytes and output pointer remain valid for the call;
		// a found slice borrows the still-live immutable handle.
		let status = unsafe {
			chudcode_catalog_provider_payload(
				self.handle.as_ptr(),
				provider.as_ptr(),
				provider.len(),
				&raw mut payload,
			)
		};
		match status {
			0 => Ok(Either::B(())),
			1 => slice_to_string(payload, &format!("Model catalog provider '{provider}' payload"))
				.map(Either::A),
			_ => Err(napi::Error::from_reason(format!(
				"Could not read model catalog provider '{provider}'"
			))),
		}
	}

	/// Byte length of the mapped file or owned memory copy.
	#[napi]
	pub fn mapped_bytes(&self) -> f64 {
		// SAFETY: `self.handle` remains valid for this method call.
		unsafe { chudcode_catalog_mapped_bytes(self.handle.as_ptr()) as f64 }
	}

	/// Whether the catalog owns an OS-backed file mapping.
	#[napi]
	pub fn is_file_backed(&self) -> bool {
		// SAFETY: `self.handle` remains valid for this method call.
		unsafe { chudcode_catalog_is_file_backed(self.handle.as_ptr()) != 0 }
	}
}

impl Drop for MappedModelCatalog {
	fn drop(&mut self) {
		// SAFETY: This instance uniquely owns the handle, and `Drop` runs once.
		unsafe { chudcode_catalog_close(self.handle.as_ptr()) };
	}
}

#[cfg(test)]
mod tests {
	use std::{
		ffi::{CStr, CString, c_char},
		fs,
		ptr::null_mut,
		slice,
		sync::atomic::{AtomicU64, Ordering},
	};

	use super::*;

	const FIRST_RECORD: usize = 24;
	const SECOND_RECORD: usize = 56;
	const PAYLOAD_SECTION: usize = 88;
	const FIRST_PAYLOAD_PADDING: usize = 95;
	static NEXT_TEMP_FILE: AtomicU64 = AtomicU64::new(0);

	struct TestCatalog(NonNull<ChudCatalog>);

	impl Drop for TestCatalog {
		fn drop(&mut self) {
			// SAFETY: The test wrapper uniquely owns this successful open handle.
			unsafe { chudcode_catalog_close(self.0.as_ptr()) };
		}
	}

	fn write_u16(bytes: &mut [u8], offset: usize, value: u16) {
		bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
	}

	fn write_u32(bytes: &mut [u8], offset: usize, value: u32) {
		bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
	}

	fn write_u64(bytes: &mut [u8], offset: usize, value: u64) {
		bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
	}

	fn fixture() -> Vec<u8> {
		let first_name = b"alpha";
		let second_name = "\u{03b2}eta".as_bytes();
		let first_payload = br#"{"a":1}"#;
		let second_payload = br#"{"b":2}"#;
		let mut bytes = vec![0; 103];
		bytes[..8].copy_from_slice(b"OMPCAT1\0");
		write_u32(&mut bytes, 8, 1);
		write_u32(&mut bytes, 12, 2);
		write_u64(&mut bytes, 16, PAYLOAD_SECTION as u64);

		write_u16(&mut bytes, FIRST_RECORD, first_name.len() as u16);
		write_u32(&mut bytes, FIRST_RECORD + 4, 0);
		write_u64(&mut bytes, FIRST_RECORD + 8, PAYLOAD_SECTION as u64);
		write_u64(&mut bytes, FIRST_RECORD + 16, first_payload.len() as u64);
		bytes[FIRST_RECORD + 24..FIRST_RECORD + 24 + first_name.len()].copy_from_slice(first_name);

		write_u16(&mut bytes, SECOND_RECORD, second_name.len() as u16);
		write_u32(&mut bytes, SECOND_RECORD + 4, 1);
		write_u64(&mut bytes, SECOND_RECORD + 8, 96);
		write_u64(&mut bytes, SECOND_RECORD + 16, second_payload.len() as u64);
		bytes[SECOND_RECORD + 24..SECOND_RECORD + 24 + second_name.len()]
			.copy_from_slice(second_name);

		bytes[PAYLOAD_SECTION..PAYLOAD_SECTION + first_payload.len()].copy_from_slice(first_payload);
		bytes[96..96 + second_payload.len()].copy_from_slice(second_payload);
		bytes
	}

	fn open_memory(bytes: &[u8]) -> TestCatalog {
		let handle = open_catalog("test memory catalog", |out, error, capacity| {
			// SAFETY: The slice and output buffers remain valid for this synchronous call.
			unsafe { chudcode_catalog_open_memory(bytes.as_ptr(), bytes.len(), out, error, capacity) }
		})
		.expect("valid memory catalog should open");
		TestCatalog(handle)
	}

	fn assert_rejected(label: &str, bytes: &[u8]) {
		let mut handle = null_mut();
		let mut error = [0 as c_char; ERROR_CAPACITY];
		// SAFETY: Inputs and output buffers remain valid for this synchronous call.
		let status = unsafe {
			chudcode_catalog_open_memory(
				bytes.as_ptr(),
				bytes.len(),
				&raw mut handle,
				error.as_mut_ptr(),
				error.len(),
			)
		};
		assert_eq!(status, -1, "{label} unexpectedly opened");
		assert!(handle.is_null(), "{label} returned a partial handle");
		// SAFETY: The buffer is zero-initialized and the native API guarantees
		// termination.
		let detail = unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy();
		assert!(!detail.is_empty(), "{label} returned no actionable error");
	}

	#[test]
	fn copied_memory_catalog_preserves_order_lookup_and_owned_bytes() {
		let mut bytes = fixture();
		let expected_length = bytes.len();
		let catalog = open_memory(&bytes);
		bytes.fill(0);

		// SAFETY: The handle remains live for all accessor calls in this test.
		assert_eq!(unsafe { chudcode_catalog_provider_count(catalog.0.as_ptr()) }, 2);
		// SAFETY: The handle remains live and immutable.
		assert_eq!(unsafe { chudcode_catalog_mapped_bytes(catalog.0.as_ptr()) }, expected_length);
		// SAFETY: The handle remains live and immutable.
		assert_eq!(unsafe { chudcode_catalog_is_file_backed(catalog.0.as_ptr()) }, 0);

		let mut name = ChudCatalogSlice::default();
		let mut ordinal = u32::MAX;
		// SAFETY: Output pointers are valid and index zero exists.
		assert_eq!(
			unsafe {
				chudcode_catalog_provider_at(catalog.0.as_ptr(), 0, &raw mut name, &raw mut ordinal)
			},
			0
		);
		assert_eq!(ordinal, 0);
		// SAFETY: The returned slice borrows the still-live immutable handle.
		assert_eq!(unsafe { slice::from_raw_parts(name.data, name.length) }, b"alpha");
		// SAFETY: Index two is deliberately outside the two-provider catalog.
		assert_eq!(
			unsafe {
				chudcode_catalog_provider_at(catalog.0.as_ptr(), 2, &raw mut name, &raw mut ordinal)
			},
			-1
		);

		let mut payload = ChudCatalogSlice::default();
		// SAFETY: The name and output pointers remain valid for the call.
		assert_eq!(
			unsafe {
				chudcode_catalog_provider_payload(
					catalog.0.as_ptr(),
					b"alpha".as_ptr(),
					b"alpha".len(),
					&raw mut payload,
				)
			},
			1
		);
		// SAFETY: The returned slice borrows the still-live immutable handle.
		assert_eq!(unsafe { slice::from_raw_parts(payload.data, payload.length) }, br#"{"a":1}"#);
		// SAFETY: The absent lookup uses valid input and output pointers.
		assert_eq!(
			unsafe {
				chudcode_catalog_provider_payload(
					catalog.0.as_ptr(),
					b"missing".as_ptr(),
					b"missing".len(),
					&raw mut payload,
				)
			},
			0
		);
		assert!(payload.data.is_null());
		assert_eq!(payload.length, 0);
	}

	#[test]
	fn file_catalog_owns_a_real_mapping() {
		let bytes = fixture();
		let sequence = NEXT_TEMP_FILE.fetch_add(1, Ordering::Relaxed);
		let path = std::env::temp_dir()
			.join(format!("chudcode-catalog-{}-{sequence}.bin", std::process::id()));
		fs::write(&path, &bytes).expect("write catalog fixture");
		let native_path =
			CString::new(path.to_string_lossy().as_bytes()).expect("temporary path has no NUL");
		{
			let handle = open_catalog("test file catalog", |out, error, capacity| {
				// SAFETY: The path and output buffers remain valid for this synchronous call.
				unsafe { chudcode_catalog_open_file(native_path.as_ptr(), out, error, capacity) }
			})
			.expect("valid file catalog should open");
			let catalog = TestCatalog(handle);
			// SAFETY: The handle remains live and immutable.
			assert_eq!(unsafe { chudcode_catalog_is_file_backed(catalog.0.as_ptr()) }, 1);
			// SAFETY: The handle remains live and immutable.
			assert_eq!(unsafe { chudcode_catalog_mapped_bytes(catalog.0.as_ptr()) }, bytes.len());
		}
		fs::remove_file(path).expect("remove catalog fixture");
	}

	#[test]
	fn rejects_every_malformed_format_boundary_without_a_partial_handle() {
		let valid = fixture();
		assert_rejected("truncated header", &valid[..20]);

		let mut bad_magic = valid.clone();
		bad_magic[0] = b'X';
		assert_rejected("bad magic", &bad_magic);

		let mut wrong_schema = valid.clone();
		write_u32(&mut wrong_schema, 8, 2);
		assert_rejected("wrong schema", &wrong_schema);

		let mut payload_out_of_file = valid.clone();
		write_u64(&mut payload_out_of_file, 16, 1_000);
		assert_rejected("payload section outside file", &payload_out_of_file);

		let mut unaligned_payload_section = valid.clone();
		write_u64(&mut unaligned_payload_section, 16, 89);
		assert_rejected("unaligned payload section", &unaligned_payload_section);

		let mut mismatched_index_end = valid.clone();
		write_u32(&mut mismatched_index_end, 12, 0);
		write_u64(&mut mismatched_index_end, 16, 32);
		assert_rejected("payload section differs from index end", &mismatched_index_end);

		let mut truncated_index = valid.clone();
		write_u32(&mut truncated_index, 12, 1);
		write_u64(&mut truncated_index, 16, 32);
		assert_rejected("truncated index", &truncated_index);

		let mut reserved_bits = valid.clone();
		write_u16(&mut reserved_bits, FIRST_RECORD + 2, 1);
		assert_rejected("nonzero reserved bits", &reserved_bits);

		let mut wrong_ordinal = valid.clone();
		write_u32(&mut wrong_ordinal, FIRST_RECORD + 4, 1);
		assert_rejected("wrong ordinal", &wrong_ordinal);

		let mut oversized_name = valid.clone();
		write_u16(&mut oversized_name, FIRST_RECORD, u16::MAX);
		assert_rejected("name outside index", &oversized_name);

		let mut invalid_utf8 = valid.clone();
		invalid_utf8[FIRST_RECORD + 24] = 0xff;
		assert_rejected("invalid UTF-8 name", &invalid_utf8);

		let mut index_padding = valid.clone();
		index_padding[FIRST_RECORD + 24 + 5] = 1;
		assert_rejected("nonzero index padding", &index_padding);

		let mut payload_gap = valid.clone();
		write_u64(&mut payload_gap, FIRST_RECORD + 8, 96);
		assert_rejected("payload gap", &payload_gap);

		let mut overlapping_payload = valid.clone();
		write_u64(&mut overlapping_payload, SECOND_RECORD + 8, PAYLOAD_SECTION as u64);
		assert_rejected("overlapping payload", &overlapping_payload);

		let mut out_of_bounds_payload = valid.clone();
		write_u64(&mut out_of_bounds_payload, SECOND_RECORD + 16, 1_000);
		assert_rejected("out-of-bounds payload", &out_of_bounds_payload);

		let mut nonzero_payload_padding = valid.clone();
		nonzero_payload_padding[FIRST_PAYLOAD_PADDING] = 1;
		assert_rejected("nonzero payload padding", &nonzero_payload_padding);

		let mut trailing_bytes = valid;
		trailing_bytes.push(0);
		assert_rejected("final payload before EOF", &trailing_bytes);
	}
}
