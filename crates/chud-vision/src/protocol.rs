use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
pub struct Request {
	pub action:      String,
	pub path:        Option<String>,
	pub path_b:      Option<String>,
	pub out:         Option<String>,
	pub model_dir:   Option<String>,
	pub query:       Option<String>,
	pub template:    Option<String>,
	pub bbox:        Option<[u32; 4]>,
	#[serde(default)]
	pub auto:        bool,
	pub redact:      Option<RedactOptions>,
	pub max_results: Option<usize>,
	pub top_k:       Option<usize>,
	pub threshold:   Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RedactOptions {
	pub faces:    Option<bool>,
	pub emails:   Option<bool>,
	pub phones:   Option<bool>,
	pub cards:    Option<bool>,
	pub keys:     Option<bool>,
	pub all_text: Option<bool>,
}

impl Default for RedactOptions {
	fn default() -> Self {
		Self {
			faces:    Some(true),
			emails:   Some(true),
			phones:   Some(true),
			cards:    Some(true),
			keys:     Some(true),
			all_text: Some(false),
		}
	}
}

impl RedactOptions {
	pub fn enabled(value: Option<bool>, default: bool) -> bool {
		value.unwrap_or(default)
	}
}

#[derive(Debug, Clone)]
pub struct VisionError {
	pub reason: &'static str,
	pub hint:   String,
}

impl VisionError {
	pub fn new(reason: &'static str, hint: impl Into<String>) -> Self {
		Self { reason, hint: hint.into() }
	}

	pub fn response(&self) -> Value {
		json!({ "ok": false, "reason": self.reason, "hint": self.hint })
	}
}

impl std::fmt::Display for VisionError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "{}: {}", self.reason, self.hint)
	}
}

impl std::error::Error for VisionError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Label {
	pub label:      String,
	pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Object {
	pub label:      String,
	pub confidence: f32,
	pub bbox:       [u32; 4],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Face {
	pub bbox:       [u32; 4],
	pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextRegion {
	pub text:       String,
	pub confidence: f32,
	pub bbox:       [u32; 4],
}

pub fn required_path<'a>(value: &'a Option<String>, field: &str) -> Result<&'a str, VisionError> {
	value.as_deref().filter(|v| !v.is_empty()).ok_or_else(|| {
		VisionError::new("invalid_request", format!("{field} is required for this action"))
	})
}
