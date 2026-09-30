use std::collections::VecDeque;

use image::{DynamicImage, GenericImageView, Rgba};
use imageproc::{drawing::draw_hollow_rect_mut, rect::Rect};

use crate::{image_io, protocol::VisionError};

pub struct DiffResult {
	pub changed_pct: f32,
	pub regions:     Vec<[u32; 4]>,
}

pub fn compare(
	first: &DynamicImage,
	second: &DynamicImage,
	out: Option<&str>,
	max_results: usize,
) -> Result<DiffResult, VisionError> {
	let (width, height) = first.dimensions();
	if width == 0 || height == 0 {
		return Err(VisionError::new("invalid_image", "cannot diff an empty image"));
	}
	let left = first.to_rgba8();
	let right = second
		.resize_exact(width, height, image::imageops::FilterType::Triangle)
		.to_rgba8();
	let mut changed = vec![false; (width * height) as usize];
	let mut changed_pixels = 0usize;
	let mut delta_image = image::RgbaImage::new(width, height);
	for y in 0..height {
		for x in 0..width {
			let a = left.get_pixel(x, y);
			let b = right.get_pixel(x, y);
			let delta = [a[0].abs_diff(b[0]), a[1].abs_diff(b[1]), a[2].abs_diff(b[2])];
			let max_delta = *delta.iter().max().unwrap_or(&0);
			let is_changed = max_delta >= 16;
			changed[(y * width + x) as usize] = is_changed;
			if is_changed {
				changed_pixels += 1;
			}
			delta_image.put_pixel(x, y, Rgba([delta[0], delta[1], delta[2], 255]));
		}
	}
	let mut regions = connected_regions(&changed, width, height);
	regions.sort_by_key(|bbox| std::cmp::Reverse(bbox[2] * bbox[3]));
	regions.truncate(max_results.clamp(1, 100));
	if let Some(path) = out {
		for bbox in &regions {
			draw_hollow_rect_mut(
				&mut delta_image,
				Rect::at(bbox[0] as i32, bbox[1] as i32).of_size(bbox[2], bbox[3]),
				Rgba([255, 0, 0, 255]),
			);
		}
		image_io::save(&DynamicImage::ImageRgba8(delta_image), path)?;
	}
	Ok(DiffResult { changed_pct: changed_pixels as f32 * 100.0 / changed.len() as f32, regions })
}

fn connected_regions(mask: &[bool], width: u32, height: u32) -> Vec<[u32; 4]> {
	let mut visited = vec![false; mask.len()];
	let mut regions = Vec::new();
	for start in 0..mask.len() {
		if !mask[start] || visited[start] {
			continue;
		}
		visited[start] = true;
		let mut queue = VecDeque::from([start]);
		let mut min_x = start as u32 % width;
		let mut max_x = min_x;
		let mut min_y = start as u32 / width;
		let mut max_y = min_y;
		let mut pixels = 0usize;
		while let Some(index) = queue.pop_front() {
			let x = index as u32 % width;
			let y = index as u32 / width;
			min_x = min_x.min(x);
			max_x = max_x.max(x);
			min_y = min_y.min(y);
			max_y = max_y.max(y);
			pixels += 1;
			for (nx, ny) in [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)] {
				if nx >= width || ny >= height {
					continue;
				}
				let next = (ny * width + nx) as usize;
				if mask[next] && !visited[next] {
					visited[next] = true;
					queue.push_back(next);
				}
			}
		}
		if pixels >= 4 {
			regions.push([min_x, min_y, max_x - min_x + 1, max_y - min_y + 1]);
		}
	}
	regions
}

#[cfg(test)]
mod tests {
	use super::connected_regions;

	#[test]
	fn separates_changed_components() {
		let mut mask = vec![false; 36];
		for index in [0, 1, 6, 7, 28, 29, 34, 35] {
			mask[index] = true;
		}
		let regions = connected_regions(&mask, 6, 6);
		assert_eq!(regions.len(), 2);
	}
}
