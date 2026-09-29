use std::{
	ffi::{CStr, c_char, c_int},
	ptr::{NonNull, null_mut},
	slice, str,
};

use napi::bindgen_prelude::{Either, Result, Undefined};
use napi_derive::napi;

const ERROR_CAPACITY: usize = 512;

#[repr(C)]
struct ChudTuiScreen {
	_private: [u8; 0],
}

#[derive(Clone, Copy, Default)]
#[repr(C)]
struct ChudTuiSlice {
	data:   *const u8,
	length: usize,
}

unsafe extern "C" {
	fn chudcode_tui_create(
		out: *mut *mut ChudTuiScreen,
		error: *mut c_char,
		error_capacity: usize,
	) -> c_int;
	fn chudcode_tui_destroy(screen: *mut ChudTuiScreen);
	fn chudcode_tui_begin_frame(
		screen: *mut ChudTuiScreen,
		rows: usize,
		error: *mut c_char,
		error_capacity: usize,
	) -> c_int;
	fn chudcode_tui_set_row(
		screen: *mut ChudTuiScreen,
		row: usize,
		bytes: *const u8,
		length: usize,
		error: *mut c_char,
		error_capacity: usize,
	) -> c_int;
	fn chudcode_tui_force_repaint(screen: *mut ChudTuiScreen) -> c_int;
	fn chudcode_tui_flush(
		screen: *mut ChudTuiScreen,
		prologue: *const u8,
		prologue_length: usize,
		epilogue: *const u8,
		epilogue_length: usize,
		out: *mut ChudTuiSlice,
		error: *mut c_char,
		error_capacity: usize,
	) -> c_int;
	fn chudcode_tui_rows(screen: *const ChudTuiScreen) -> usize;
	fn chudcode_tui_changed_rows(screen: *const ChudTuiScreen) -> usize;
}

struct ErrorBuffer([c_char; ERROR_CAPACITY]);

impl ErrorBuffer {
	const fn new() -> Self {
		Self([0; ERROR_CAPACITY])
	}

	const fn as_mut_ptr(&mut self) -> *mut c_char {
		self.0.as_mut_ptr()
	}

	fn into_error(self, context: &str) -> napi::Error {
		// SAFETY: The buffer is zero-initialized and the C API writes a bounded,
		// NUL-terminated string.
		let detail = unsafe { CStr::from_ptr(self.0.as_ptr()) }.to_string_lossy();
		let detail = if detail.is_empty() {
			"unknown native error".into()
		} else {
			detail
		};
		napi::Error::from_reason(format!("{context}: {detail}"))
	}
}

/// Row-granular differential frame emitter backed by the native TUI core.
///
/// Rows are opaque strings: the caller pads, clips, and terminates styles, and
/// this emitter writes only the rows whose bytes changed since the last flush.
#[napi]
pub struct TuiScreen {
	handle: NonNull<ChudTuiScreen>,
}

// SAFETY: The handle owns its own row buffers, every method takes `&mut self`
// or reads immutable counters, and `Drop` is the sole destroyer.
unsafe impl Send for TuiScreen {}

#[napi]
impl TuiScreen {
	#[napi(constructor)]
	pub fn new() -> Result<Self> {
		let mut native_handle = null_mut();
		let mut error = ErrorBuffer::new();
		// SAFETY: Output and error buffers are valid for the lengths passed.
		let status =
			unsafe { chudcode_tui_create(&raw mut native_handle, error.as_mut_ptr(), ERROR_CAPACITY) };
		if status != 0 {
			return Err(error.into_error("Could not create the native TUI screen"));
		}
		NonNull::new(native_handle)
			.map(|handle| Self { handle })
			.ok_or_else(|| napi::Error::from_reason("Native TUI screen returned a null handle"))
	}

	/// Stage a frame of `rows` rows. A row-count change forces a full repaint.
	#[napi]
	pub fn begin_frame(&mut self, rows: u32) -> Result<()> {
		let mut error = ErrorBuffer::new();
		// SAFETY: The handle is live and the error buffer is valid for the call.
		let status = unsafe {
			chudcode_tui_begin_frame(
				self.handle.as_ptr(),
				rows as usize,
				error.as_mut_ptr(),
				ERROR_CAPACITY,
			)
		};
		if status != 0 {
			return Err(error.into_error("Could not begin the native TUI frame"));
		}
		Ok(())
	}

	/// Stage one row's exact bytes. Every row must be staged before `flush`.
	#[napi]
	pub fn set_row(&mut self, row: u32, text: String) -> Result<()> {
		let mut error = ErrorBuffer::new();
		// SAFETY: `text` outlives the call and the C ABI copies the bytes.
		let status = unsafe {
			chudcode_tui_set_row(
				self.handle.as_ptr(),
				row as usize,
				text.as_ptr(),
				text.len(),
				error.as_mut_ptr(),
				ERROR_CAPACITY,
			)
		};
		if status != 0 {
			return Err(error.into_error("Could not stage the native TUI row"));
		}
		Ok(())
	}

	/// Treat every row of the next flush as changed.
	#[napi]
	pub fn force_repaint(&mut self) {
		// SAFETY: The handle is live for this call.
		unsafe { chudcode_tui_force_repaint(self.handle.as_ptr()) };
	}

	/// Emit the staged frame, or `undefined` when no row changed.
	///
	/// Cursor position after a flush is unspecified: callers that need a
	/// specific position append the sequence to `epilogue`.
	#[napi]
	pub fn flush(
		&mut self,
		prologue: String,
		epilogue: String,
	) -> Result<Either<String, Undefined>> {
		let mut out = ChudTuiSlice::default();
		let mut error = ErrorBuffer::new();
		// SAFETY: Both strings outlive the call and the output slice borrows the
		// screen's internal buffer, which stays alive until the next flush.
		let status = unsafe {
			chudcode_tui_flush(
				self.handle.as_ptr(),
				prologue.as_ptr(),
				prologue.len(),
				epilogue.as_ptr(),
				epilogue.len(),
				&raw mut out,
				error.as_mut_ptr(),
				ERROR_CAPACITY,
			)
		};
		if status != 0 {
			return Err(error.into_error("Could not flush the native TUI frame"));
		}
		if out.length == 0 {
			return Ok(Either::B(()));
		}
		// SAFETY: A successful flush returns an in-bounds slice of the screen's
		// output buffer, copied into a Rust String before returning.
		let bytes = unsafe { slice::from_raw_parts(out.data, out.length) };
		str::from_utf8(bytes)
			.map(|frame| Either::A(frame.to_owned()))
			.map_err(|error| {
				napi::Error::from_reason(format!("Native TUI frame is not valid UTF-8: {error}"))
			})
	}

	/// Row count of the current frame.
	#[napi(getter)]
	pub fn rows(&self) -> u32 {
		// SAFETY: The handle is live for this call.
		unsafe { chudcode_tui_rows(self.handle.as_ptr()) as u32 }
	}

	/// Rows emitted by the most recent flush.
	#[napi(getter)]
	pub fn changed_rows(&self) -> u32 {
		// SAFETY: The handle is live for this call.
		unsafe { chudcode_tui_changed_rows(self.handle.as_ptr()) as u32 }
	}
}

impl Drop for TuiScreen {
	fn drop(&mut self) {
		// SAFETY: This instance uniquely owns the handle and `Drop` runs once.
		unsafe { chudcode_tui_destroy(self.handle.as_ptr()) };
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn frame(screen: &mut TuiScreen, rows: &[&str]) -> Option<String> {
		screen.begin_frame(rows.len() as u32).expect("begin frame");
		for (index, row) in rows.iter().enumerate() {
			screen
				.set_row(index as u32, (*row).to_string())
				.expect("stage row");
		}
		match screen
			.flush(String::new(), String::new())
			.expect("flush frame")
		{
			Either::A(frame) => Some(frame),
			Either::B(()) => None,
		}
	}

	#[test]
	fn first_frame_paints_every_row_then_only_changed_rows() {
		let mut screen = TuiScreen::new().expect("create screen");

		let first = frame(&mut screen, &["alpha", "beta", "gamma"]).expect("first frame paints");
		assert_eq!(first, "\u{1b}[1;1Halpha\u{1b}[2;1Hbeta\u{1b}[3;1Hgamma");
		assert_eq!(screen.changed_rows(), 3);
		assert_eq!(screen.rows(), 3);

		let unchanged = frame(&mut screen, &["alpha", "beta", "gamma"]);
		assert!(unchanged.is_none(), "an identical frame must emit nothing");
		assert_eq!(screen.changed_rows(), 0);

		let partial = frame(&mut screen, &["alpha", "BETA", "gamma"]).expect("changed row paints");
		assert_eq!(partial, "\u{1b}[2;1HBETA");
		assert_eq!(screen.changed_rows(), 1);
	}

	#[test]
	fn row_count_change_and_forced_repaint_paint_every_row() {
		let mut screen = TuiScreen::new().expect("create screen");
		frame(&mut screen, &["one", "two"]).expect("first frame paints");

		let resized =
			frame(&mut screen, &["one", "two", "three"]).expect("row-count change repaints");
		assert_eq!(resized, "\u{1b}[1;1Hone\u{1b}[2;1Htwo\u{1b}[3;1Hthree");
		assert_eq!(screen.changed_rows(), 3);

		assert!(frame(&mut screen, &["one", "two", "three"]).is_none());
		screen.force_repaint();
		let forced = frame(&mut screen, &["one", "two", "three"]).expect("forced repaint paints");
		assert_eq!(forced, "\u{1b}[1;1Hone\u{1b}[2;1Htwo\u{1b}[3;1Hthree");
		assert_eq!(screen.changed_rows(), 3);
	}

	#[test]
	fn prologue_and_epilogue_wrap_only_non_empty_frames() {
		let mut screen = TuiScreen::new().expect("create screen");
		screen.begin_frame(1).expect("begin frame");
		screen.set_row(0, "row".to_string()).expect("stage row");
		let painted = match screen
			.flush("<begin>".to_string(), "<end>".to_string())
			.expect("flush frame")
		{
			Either::A(frame) => frame,
			Either::B(()) => panic!("a changed frame must emit output"),
		};
		assert_eq!(painted, "<begin>\u{1b}[1;1Hrow<end>");

		screen.begin_frame(1).expect("begin frame");
		screen.set_row(0, "row".to_string()).expect("stage row");
		let skipped = screen
			.flush("<begin>".to_string(), "<end>".to_string())
			.expect("flush frame");
		assert!(matches!(skipped, Either::B(())), "an identical frame must emit nothing");
	}

	#[test]
	fn rejects_unstaged_rows_and_out_of_range_rows() {
		let mut screen = TuiScreen::new().expect("create screen");
		screen.begin_frame(2).expect("begin frame");
		screen.set_row(0, "only".to_string()).expect("stage row");
		let unstaged = screen
			.flush(String::new(), String::new())
			.expect_err("unstaged row must fail");
		assert!(unstaged.reason.contains("row 1 was not staged"), "{}", unstaged.reason);

		let out_of_range = screen
			.set_row(5, "nope".to_string())
			.expect_err("out-of-range row must fail");
		assert!(out_of_range.reason.contains("outside the 2-row frame"), "{}", out_of_range.reason);
	}

	#[test]
	fn multi_byte_rows_round_trip_and_wide_row_indices_position_correctly() {
		let mut screen = TuiScreen::new().expect("create screen");
		let rows: Vec<String> = (0..12).map(|index| format!("ロー{index}")).collect();
		let staged: Vec<&str> = rows.iter().map(String::as_str).collect();
		let painted = frame(&mut screen, &staged).expect("first frame paints");
		assert!(painted.contains("\u{1b}[10;1Hロー9"), "{painted}");
		assert!(painted.contains("\u{1b}[12;1Hロー11"), "{painted}");

		let mut changed = staged.clone();
		let replacement = "ローX".to_string();
		changed[9] = replacement.as_str();
		let partial = frame(&mut screen, &changed).expect("changed row paints");
		assert_eq!(partial, "\u{1b}[10;1HローX");
	}
}
