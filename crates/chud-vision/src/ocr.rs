use std::{collections::VecDeque, path::Path};

use image::{DynamicImage, GenericImageView};

use crate::{
	image_io, inference,
	protocol::{TextRegion, VisionError},
};

pub fn recognize(
	image: &DynamicImage,
	detector_model: &Path,
	recognizer_model: &Path,
	dictionary_path: &Path,
	max_results: usize,
) -> Result<(Vec<TextRegion>, String), VisionError> {
	let boxes = detect_text(image, detector_model, max_results.clamp(1, 100))?;
	let dictionary = load_dictionary(dictionary_path)?;
	let mut recognizer_session = inference::session(recognizer_model)?;
	let mut regions = Vec::new();
	for bbox in boxes {
		let crop = image.crop_imm(bbox[0], bbox[1], bbox[2], bbox[3]);
		let (text, confidence) = recognize_line(&crop, &mut recognizer_session, &dictionary)?;
		if !text.trim().is_empty() {
			regions.push(TextRegion { text, confidence, bbox });
		}
	}
	regions.sort_by_key(|region| (region.bbox[1], region.bbox[0]));
	let full_text = regions
		.iter()
		.map(|region| region.text.as_str())
		.collect::<Vec<_>>()
		.join("\n");
	Ok((regions, full_text))
}

pub fn detect_text(
	image: &DynamicImage,
	model: &Path,
	max_results: usize,
) -> Result<Vec<[u32; 4]>, VisionError> {
	let (source_w, source_h) = image.dimensions();
	let scale = (960.0 / source_w.max(source_h) as f32).min(1.0);
	let input_w = (((source_w as f32 * scale).round() as u32).div_ceil(32) * 32).max(32);
	let input_h = (((source_h as f32 * scale).round() as u32).div_ceil(32) * 32).max(32);
	let resized = image_io::resize_rgb(image, input_w, input_h);
	let data =
		image_io::normalized_nchw(&resized, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225], true);
	let tensor = inference::tensor_f32(vec![1, 3, input_h as i64, input_w as i64], data)?;
	let mut session = inference::session(model)?;
	let outputs = inference::run_one(&mut session, tensor)?;
	if outputs.len() == 0 {
		return Err(VisionError::new(
			"model_incompatible",
			"PP-OCR detector returned no output tensors",
		));
	}
	let (shape, map) = outputs[0].try_extract_tensor::<f32>().map_err(|error| {
		VisionError::new("inference_failed", format!("PP-OCR detector output is invalid: {error}"))
	})?;
	if shape.len() < 2 {
		return Err(VisionError::new(
			"model_incompatible",
			"PP-OCR detector returned an output without image dimensions",
		));
	}
	let map_h = shape[shape.len() - 2].max(0) as usize;
	let map_w = shape[shape.len() - 1].max(0) as usize;
	if map_h == 0 || map_w == 0 || map.len() < map_h * map_w {
		return Err(VisionError::new(
			"model_incompatible",
			"PP-OCR detector returned an empty probability map",
		));
	}
	let probabilities = &map[map.len() - map_h * map_w..];
	let mut boxes = probability_components(probabilities, map_w, map_h, 0.3, 0.6);
	boxes.sort_by(|left, right| {
		let left_area = left[2] * left[3];
		let right_area = right[2] * right[3];
		right_area.cmp(&left_area)
	});
	boxes.truncate(max_results.clamp(1, 100));
	let sx = source_w as f32 / map_w as f32;
	let sy = source_h as f32 / map_h as f32;
	Ok(boxes
		.into_iter()
		.filter_map(|bbox| {
			image_io::scale_bbox(
				[bbox[0] as f32, bbox[1] as f32, bbox[2] as f32, bbox[3] as f32],
				sx,
				sy,
				source_w,
				source_h,
			)
		})
		.collect())
}

fn probability_components(
	map: &[f32],
	width: usize,
	height: usize,
	pixel_threshold: f32,
	box_threshold: f32,
) -> Vec<[u32; 4]> {
	let mut visited = vec![false; width * height];
	let mut boxes = Vec::new();
	for start in 0..map.len().min(width * height) {
		if visited[start] || map[start] < pixel_threshold {
			continue;
		}
		visited[start] = true;
		let mut queue = VecDeque::from([start]);
		let mut min_x = start % width;
		let mut max_x = min_x;
		let mut min_y = start / width;
		let mut max_y = min_y;
		let mut sum = 0.0;
		let mut count = 0usize;
		while let Some(index) = queue.pop_front() {
			let x = index % width;
			let y = index / width;
			min_x = min_x.min(x);
			max_x = max_x.max(x);
			min_y = min_y.min(y);
			max_y = max_y.max(y);
			sum += map[index];
			count += 1;
			for (nx, ny) in [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)] {
				if nx >= width || ny >= height {
					continue;
				}
				let next = ny * width + nx;
				if !visited[next] && map[next] >= pixel_threshold {
					visited[next] = true;
					queue.push_back(next);
				}
			}
		}
		let box_w = max_x - min_x + 1;
		let box_h = max_y - min_y + 1;
		if count < 4 || box_w < 3 || box_h < 3 || sum / (count as f32) < box_threshold {
			continue;
		}
		let expand_x = ((box_w as f32 * 0.25).ceil() as usize).max(1);
		let expand_y = ((box_h as f32 * 0.25).ceil() as usize).max(1);
		let x0 = min_x.saturating_sub(expand_x);
		let y0 = min_y.saturating_sub(expand_y);
		let x1 = (max_x + expand_x + 1).min(width);
		let y1 = (max_y + expand_y + 1).min(height);
		boxes.push([x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32]);
	}
	boxes
}

fn recognize_line(
	image: &DynamicImage,
	session: &mut ort::session::Session,
	dictionary: &[String],
) -> Result<(String, f32), VisionError> {
	let (width, height) = image.dimensions();
	let target_w = (((48.0 * width as f32 / height.max(1) as f32).round() as u32).div_ceil(8) * 8)
		.clamp(16, 3200);
	let resized = image_io::resize_rgb(image, target_w, 48);
	let data = image_io::normalized_nchw(&resized, [0.5; 3], [0.5; 3], true);
	let tensor = inference::tensor_f32(vec![1, 3, 48, target_w as i64], data)?;
	let outputs = inference::run_one(session, tensor)?;
	if outputs.len() == 0 {
		return Err(VisionError::new(
			"model_incompatible",
			"PP-OCR recognizer returned no output tensors",
		));
	}
	let (shape, logits) = outputs[0].try_extract_tensor::<f32>().map_err(|error| {
		VisionError::new("inference_failed", format!("PP-OCR recognizer output is invalid: {error}"))
	})?;
	if shape.len() < 2 {
		return Err(VisionError::new(
			"model_incompatible",
			"PP-OCR recognizer returned an unexpected tensor shape",
		));
	}
	let classes = *shape.last().unwrap_or(&0);
	if classes <= 1 || logits.len() % classes as usize != 0 {
		return Err(VisionError::new(
			"model_incompatible",
			"PP-OCR recognizer logits do not contain CTC classes",
		));
	}
	let classes = classes as usize;
	if classes != dictionary.len() + 1 {
		return Err(VisionError::new(
			"model_incompatible",
			format!(
				"PP-OCR recognizer has {classes} CTC classes but dictionary has {} entries",
				dictionary.len()
			),
		));
	}
	let steps = logits.len() / classes;
	let mut previous = usize::MAX;
	let mut text = String::new();
	let mut confidence_sum = 0.0;
	let mut characters = 0usize;
	for step in 0..steps {
		let row = &logits[step * classes..(step + 1) * classes];
		let Some((index, best)) = row.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)) else {
			continue;
		};
		let max = *best;
		if !max.is_finite() {
			return Err(VisionError::new(
				"inference_failed",
				"PP-OCR recognizer returned non-finite logits",
			));
		}
		let row_sum: f32 = row.iter().sum();
		let already_probabilities =
			(0.98..=1.02).contains(&row_sum) && row.iter().all(|value| (0.0..=1.0).contains(value));
		let confidence = if already_probabilities {
			max
		} else {
			let denominator: f32 = row.iter().map(|value| (*value - max).exp()).sum();
			if denominator > 0.0 {
				1.0 / denominator
			} else {
				0.0
			}
		};
		if index != 0 && index != previous {
			if let Some(character) = dictionary.get(index - 1) {
				text.push_str(character);
				confidence_sum += confidence;
				characters += 1;
			}
		}
		previous = index;
	}
	let confidence = if characters == 0 {
		0.0
	} else {
		confidence_sum / characters as f32
	};
	Ok((text, confidence))
}

fn load_dictionary(path: &Path) -> Result<Vec<String>, VisionError> {
	let content = std::fs::read_to_string(path).map_err(|error| {
		VisionError::new(
			"model_missing",
			format!("cannot read OCR dictionary {}: {error}", path.display()),
		)
	})?;
	let marker = "  character_dict:";
	let mut in_dictionary = false;
	let mut characters = Vec::new();
	for line in content.lines() {
		if line == marker {
			in_dictionary = true;
			continue;
		}
		if !in_dictionary {
			continue;
		}
		let Some(value) = line.strip_prefix("  - ") else {
			if !line.trim().is_empty() {
				break;
			}
			continue;
		};
		let value = value
			.strip_prefix('\'')
			.and_then(|v| v.strip_suffix('\''))
			.or_else(|| value.strip_prefix('"').and_then(|v| v.strip_suffix('"')))
			.unwrap_or(value);
		characters.push(value.to_string());
	}
	if characters.is_empty() {
		return Err(VisionError::new(
			"model_incompatible",
			format!("OCR dictionary {} contains no character_dict", path.display()),
		));
	}
	// Paddle's CTCLabelDecode appends an ASCII space when the export omits the
	// use_space_char flag. The ONNX class count includes it plus the blank.
	if !characters.iter().any(|character| character == " ") {
		characters.push(" ".to_string());
	}
	Ok(characters)
}

#[cfg(test)]
mod tests {
	use super::probability_components;

	#[test]
	fn groups_probability_map_regions() {
		let mut map = vec![0.0; 64];
		for y in 2..6 {
			for x in 1..7 {
				map[y * 8 + x] = 0.9;
			}
		}
		let boxes = probability_components(&map, 8, 8, 0.3, 0.6);
		assert_eq!(boxes.len(), 1);
		assert!(boxes[0][2] >= 6);
	}
}
