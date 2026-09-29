use std::path::Path;

use image::{DynamicImage, GenericImageView, ImageReader, RgbImage};

use crate::protocol::VisionError;

const MAX_INPUT_EDGE: u32 = 2048;

pub fn load(path: &str) -> Result<DynamicImage, VisionError> {
	let reader = ImageReader::open(path).map_err(|error| {
		VisionError::new("image_unreadable", format!("cannot open {path}: {error}"))
	})?;
	let image = reader.decode().map_err(|error| {
		VisionError::new("image_unreadable", format!("cannot decode {path}: {error}"))
	})?;
	Ok(downscale(image, MAX_INPUT_EDGE))
}

pub fn downscale(image: DynamicImage, max_edge: u32) -> DynamicImage {
	let (width, height) = image.dimensions();
	let longest = width.max(height);
	if longest <= max_edge {
		return image;
	}
	let scale = max_edge as f32 / longest as f32;
	let out_w = ((width as f32 * scale).round() as u32).max(1);
	let out_h = ((height as f32 * scale).round() as u32).max(1);
	image.resize_exact(out_w, out_h, image::imageops::FilterType::Lanczos3)
}

pub fn save(image: &DynamicImage, path: &str) -> Result<(), VisionError> {
	if let Some(parent) = Path::new(path)
		.parent()
		.filter(|p| !p.as_os_str().is_empty())
	{
		std::fs::create_dir_all(parent).map_err(|error| {
			VisionError::new(
				"output_unwritable",
				format!("cannot create {}: {error}", parent.display()),
			)
		})?;
	}
	image.save(path).map_err(|error| {
		VisionError::new("output_unwritable", format!("cannot write {path}: {error}"))
	})
}

pub fn resize_rgb(image: &DynamicImage, width: u32, height: u32) -> RgbImage {
	image
		.resize_exact(width, height, image::imageops::FilterType::Triangle)
		.to_rgb8()
}

pub fn center_crop_224(image: &DynamicImage) -> RgbImage {
	let (width, height) = image.dimensions();
	let scale = 256.0 / width.min(height) as f32;
	let resized = image
		.resize_exact(
			(width as f32 * scale).round() as u32,
			(height as f32 * scale).round() as u32,
			image::imageops::FilterType::CatmullRom,
		)
		.to_rgb8();
	let x = (resized.width() - 224) / 2;
	let y = (resized.height() - 224) / 2;
	image::imageops::crop_imm(&resized, x, y, 224, 224).to_image()
}

pub fn normalized_nchw(image: &RgbImage, mean: [f32; 3], std: [f32; 3], bgr: bool) -> Vec<f32> {
	let plane = (image.width() * image.height()) as usize;
	let mut output = vec![0.0; plane * 3];
	for (index, pixel) in image.pixels().enumerate() {
		let values = if bgr {
			[pixel[2], pixel[1], pixel[0]]
		} else {
			[pixel[0], pixel[1], pixel[2]]
		};
		for channel in 0..3 {
			output[channel * plane + index] =
				(values[channel] as f32 / 255.0 - mean[channel]) / std[channel];
		}
	}
	output
}

pub fn clamp_bbox(bbox: [i32; 4], width: u32, height: u32) -> Option<[u32; 4]> {
	let x0 = bbox[0].clamp(0, width as i32);
	let y0 = bbox[1].clamp(0, height as i32);
	let x1 = (bbox[0] + bbox[2]).clamp(0, width as i32);
	let y1 = (bbox[1] + bbox[3]).clamp(0, height as i32);
	if x1 <= x0 || y1 <= y0 {
		return None;
	}
	Some([x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32])
}

pub fn scale_bbox(bbox: [f32; 4], sx: f32, sy: f32, width: u32, height: u32) -> Option<[u32; 4]> {
	clamp_bbox(
		[
			(bbox[0] * sx).round() as i32,
			(bbox[1] * sy).round() as i32,
			(bbox[2] * sx).round() as i32,
			(bbox[3] * sy).round() as i32,
		],
		width,
		height,
	)
}

pub fn intersection_over_union(a: [u32; 4], b: [u32; 4]) -> f32 {
	let ax1 = a[0] + a[2];
	let ay1 = a[1] + a[3];
	let bx1 = b[0] + b[2];
	let by1 = b[1] + b[3];
	let iw = ax1.min(bx1).saturating_sub(a[0].max(b[0]));
	let ih = ay1.min(by1).saturating_sub(a[1].max(b[1]));
	let intersection = (iw * ih) as f32;
	let union = (a[2] * a[3] + b[2] * b[3]) as f32 - intersection;
	if union <= 0.0 {
		0.0
	} else {
		intersection / union
	}
}
