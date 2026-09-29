use std::{path::Path, sync::LazyLock};

use image::{DynamicImage, GenericImage, Rgba};
use regex::Regex;
use serde::Serialize;

use crate::{
	detect, image_io, ocr,
	protocol::{RedactOptions, TextRegion, VisionError},
};

static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"(?i)(?:^|[^a-z0-9._%+-])([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})(?:$|[^a-z0-9._%+-])",
	)
	.expect("email regex")
});
static PHONE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"(?:\+?\d{1,3}[ .-]?)?(?:\(?\d{3}\)?[ .-]?)\d{3}[ .-]?\d{4}").expect("phone regex")
});
static CARD: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"(?:\d[ -]?){13,19}").expect("card regex"));
static SSN: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"(?:^|\D)(\d{3}-\d{2}-\d{4})(?:$|\D)").expect("SSN regex"));
static API_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"(?i)(?:sk|pk|api|key|token|secret)[_-]?[a-z0-9_-]{16,}|[A-Za-z0-9_+/=-]{24,}")
		.expect("API token regex")
});

#[derive(Debug, Clone, Serialize)]
pub struct Redaction {
	pub kind: String,
	pub bbox: [u32; 4],
}

#[allow(clippy::too_many_arguments, reason = "one sidecar request maps to one call")]
pub fn redact(
	image: &DynamicImage,
	yunet_model: &Path,
	ocr_detector: &Path,
	ocr_recognizer: &Path,
	ocr_dictionary: &Path,
	options: &RedactOptions,
	out: &str,
	max_results: usize,
) -> Result<Vec<Redaction>, VisionError> {
	let face_enabled = RedactOptions::enabled(options.faces, true);
	let text_enabled = RedactOptions::enabled(options.emails, true)
		|| RedactOptions::enabled(options.phones, true)
		|| RedactOptions::enabled(options.cards, true)
		|| RedactOptions::enabled(options.keys, true)
		|| RedactOptions::enabled(options.all_text, false);
	let faces = if face_enabled {
		detect::faces(image, yunet_model, 0.6, max_results)?
	} else {
		Vec::new()
	};
	let text_regions = if text_enabled {
		ocr::recognize(image, ocr_detector, ocr_recognizer, ocr_dictionary, max_results)?.0
	} else {
		Vec::new()
	};
	let mut output = image.to_rgba8();
	let mut redactions = Vec::new();
	let redaction_limit = max_results.clamp(1, 100);
	for face in faces {
		let [x, y, width, height] = face.bbox;
		if width == 0 || height == 0 {
			continue;
		}
		let crop = image::imageops::crop_imm(&output, x, y, width, height).to_image();
		let sigma = (width.min(height) as f32 / 8.0).max(6.0);
		let blurred = imageproc::filter::gaussian_blur_f32(&crop, sigma);
		output.copy_from(&blurred, x, y).map_err(|error| {
			VisionError::new("processing_failed", format!("cannot blur face region: {error}"))
		})?;
		redactions.push(Redaction { kind: "face".into(), bbox: face.bbox });
		if redactions.len() >= redaction_limit {
			break;
		}
	}
	'regions: for region in text_regions {
		if redactions.len() >= redaction_limit {
			break;
		}
		let kinds = pii_kinds(&region, options);
		if kinds.is_empty() {
			continue;
		}
		fill_rect(&mut output, region.bbox, Rgba([0, 0, 0, 255]));
		for kind in kinds {
			redactions.push(Redaction { kind: kind.to_string(), bbox: region.bbox });
			if redactions.len() >= redaction_limit {
				break 'regions;
			}
		}
	}
	image_io::save(&DynamicImage::ImageRgba8(output), out)?;
	Ok(redactions)
}

fn pii_kinds(region: &TextRegion, options: &RedactOptions) -> Vec<&'static str> {
	let text = region.text.as_str();
	if RedactOptions::enabled(options.all_text, false) {
		return vec!["text"];
	}
	let mut kinds = Vec::new();
	if RedactOptions::enabled(options.emails, true) && EMAIL.is_match(text) {
		kinds.push("email");
	}
	if RedactOptions::enabled(options.phones, true) && PHONE.is_match(text) {
		kinds.push("phone");
	}
	if RedactOptions::enabled(options.cards, true) {
		if CARD.find_iter(text).any(|value| luhn_valid(value.as_str())) {
			kinds.push("card");
		}
		if SSN.is_match(text) {
			kinds.push("ssn");
		}
	}
	if RedactOptions::enabled(options.keys, true)
		&& API_TOKEN
			.find_iter(text)
			.any(|value| token_entropy(value.as_str()) >= 3.5)
	{
		kinds.push("key");
	}
	kinds
}

fn fill_rect(image: &mut image::RgbaImage, bbox: [u32; 4], color: Rgba<u8>) {
	let x1 = (bbox[0] + bbox[2]).min(image.width());
	let y1 = (bbox[1] + bbox[3]).min(image.height());
	for y in bbox[1].min(image.height())..y1 {
		for x in bbox[0].min(image.width())..x1 {
			image.put_pixel(x, y, color);
		}
	}
}

pub fn luhn_valid(candidate: &str) -> bool {
	let digits: Vec<u32> = candidate
		.chars()
		.filter_map(|value| value.to_digit(10))
		.collect();
	if !(13..=19).contains(&digits.len()) || digits.iter().all(|value| *value == digits[0]) {
		return false;
	}
	let sum: u32 = digits
		.iter()
		.rev()
		.enumerate()
		.map(|(index, value)| {
			if index % 2 == 1 {
				let doubled = value * 2;
				if doubled > 9 { doubled - 9 } else { doubled }
			} else {
				*value
			}
		})
		.sum();
	sum.is_multiple_of(10)
}

fn token_entropy(value: &str) -> f32 {
	let mut counts = [0u16; 256];
	let bytes = value.as_bytes();
	for byte in bytes {
		counts[*byte as usize] += 1;
	}
	counts
		.iter()
		.filter(|count| **count > 0)
		.map(|count| {
			let probability = *count as f32 / bytes.len() as f32;
			-probability * probability.log2()
		})
		.sum()
}

#[cfg(test)]
mod tests {
	use super::{luhn_valid, pii_kinds};
	use crate::protocol::{RedactOptions, TextRegion};

	fn region(text: &str) -> TextRegion {
		TextRegion { text: text.into(), confidence: 1.0, bbox: [0, 0, 10, 10] }
	}

	#[test]
	fn validates_luhn_without_accepting_repeated_digits() {
		assert!(luhn_valid("4111 1111 1111 1111"));
		assert!(luhn_valid("5555-5555-5555-4444"));
		assert!(!luhn_valid("4111 1111 1111 1112"));
		assert!(!luhn_valid("0000 0000 0000 0000"));
	}

	#[test]
	fn classifies_supported_pii() {
		let options = RedactOptions::default();
		assert!(pii_kinds(&region("reach bob@example.com"), &options).contains(&"email"));
		assert!(pii_kinds(&region("call (212) 555-0198"), &options).contains(&"phone"));
		assert!(pii_kinds(&region("SSN 123-45-6789"), &options).contains(&"ssn"));
		assert!(pii_kinds(&region("sk_live_a8H3kd92Jf7Lm4Qx0Z"), &options).contains(&"key"));
	}
}
