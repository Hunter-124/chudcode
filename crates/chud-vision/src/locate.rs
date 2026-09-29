use std::path::Path;

use image::{DynamicImage, GrayImage};
use imageproc::template_matching::{MatchTemplateMethod, match_template_parallel};
use serde::Serialize;

use crate::{image_io, ocr, protocol::VisionError};

#[derive(Debug, Clone, Serialize)]
pub struct LocateMatch {
	pub bbox:   [u32; 4],
	pub score:  f32,
	pub method: String,
}

pub fn locate_text(
	image: &DynamicImage,
	query: &str,
	detector_model: &Path,
	recognizer_model: &Path,
	dictionary_path: &Path,
	max_results: usize,
) -> Result<Vec<LocateMatch>, VisionError> {
	if query.trim().is_empty() {
		return Err(VisionError::new("invalid_request", "locate query cannot be empty"));
	}
	let needle = query.to_lowercase();
	let (regions, _) = ocr::recognize(
		image,
		detector_model,
		recognizer_model,
		dictionary_path,
		max_results.clamp(1, 100),
	)?;
	Ok(regions
		.into_iter()
		.filter(|region| region.text.to_lowercase().contains(&needle))
		.take(max_results.clamp(1, 100))
		.map(|region| LocateMatch {
			bbox:   region.bbox,
			score:  region.confidence,
			method: "ocr".into(),
		})
		.collect())
}

pub fn locate_template(
	image: &DynamicImage,
	template: &DynamicImage,
	threshold: f32,
	max_results: usize,
) -> Result<Vec<LocateMatch>, VisionError> {
	let source = image.to_luma8();
	let template = template.to_luma8();
	locate_template_gray(&source, &template, threshold, max_results)
}

fn locate_template_gray(
	source: &GrayImage,
	template: &GrayImage,
	threshold: f32,
	max_results: usize,
) -> Result<Vec<LocateMatch>, VisionError> {
	if template.width() == 0
		|| template.height() == 0
		|| template.width() >= source.width()
		|| template.height() >= source.height()
	{
		return Err(VisionError::new(
			"invalid_template",
			format!(
				"template {}x{} must be smaller than source {}x{}",
				template.width(),
				template.height(),
				source.width(),
				source.height()
			),
		));
	}
	let scores =
		match_template_parallel(source, template, MatchTemplateMethod::CrossCorrelationNormalized);
	let mut candidates = Vec::new();
	for (x, y, pixel) in scores.enumerate_pixels() {
		let score = pixel[0];
		if score.is_finite() && score >= threshold {
			candidates.push(LocateMatch {
				bbox: [x, y, template.width(), template.height()],
				score,
				method: "template".into(),
			});
		}
	}
	candidates.sort_by(|left, right| right.score.total_cmp(&left.score));
	let mut selected: Vec<LocateMatch> = Vec::new();
	for candidate in candidates {
		if selected
			.iter()
			.any(|existing| image_io::intersection_over_union(existing.bbox, candidate.bbox) > 0.3)
		{
			continue;
		}
		selected.push(candidate);
		if selected.len() >= max_results.clamp(1, 100) {
			break;
		}
	}
	Ok(selected)
}

pub fn merge_matches(
	mut left: Vec<LocateMatch>,
	right: Vec<LocateMatch>,
	max_results: usize,
) -> Vec<LocateMatch> {
	left.extend(right);
	left.sort_by(|a, b| b.score.total_cmp(&a.score));
	left.truncate(max_results.clamp(1, 100));
	left
}

pub fn load_template(path: &str) -> Result<DynamicImage, VisionError> {
	image_io::load(path)
}

#[cfg(test)]
mod tests {
	use image::{GrayImage, Luma};

	use super::locate_template_gray;

	#[test]
	fn locates_synthetic_template() {
		let mut source = GrayImage::from_pixel(64, 64, Luma([10]));
		let mut template = GrayImage::from_pixel(8, 8, Luma([20]));
		for i in 0..8 {
			template.put_pixel(i, i, Luma([240]));
			template.put_pixel(7 - i, i, Luma([180]));
		}
		for y in 0..8 {
			for x in 0..8 {
				source.put_pixel(31 + x, 19 + y, *template.get_pixel(x, y));
			}
		}
		let matches = locate_template_gray(&source, &template, 0.99, 5).unwrap();
		assert_eq!(matches[0].bbox, [31, 19, 8, 8]);
		assert!(matches[0].score > 0.99);
	}
}
