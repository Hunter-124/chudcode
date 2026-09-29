use std::path::Path;

use image::{DynamicImage, GenericImageView};

use crate::{detect, image_io, protocol::VisionError};

pub fn crop(
	image: &DynamicImage,
	explicit: Option<[u32; 4]>,
	auto: bool,
	detector_model: &Path,
	out: &str,
	max_results: usize,
) -> Result<[u32; 4], VisionError> {
	let (image_w, image_h) = image.dimensions();
	let bbox = if let Some(bbox) = explicit {
		validate_bbox(bbox, image_w, image_h)?
	} else if auto {
		let objects = detect::objects(image, detector_model, 0.3, max_results.clamp(1, 10))?;
		if objects.is_empty() {
			return Err(VisionError::new(
				"nothing_to_crop",
				"no object detections met the automatic crop threshold; provide bbox explicitly",
			));
		}
		let min_x = objects
			.iter()
			.map(|object| object.bbox[0])
			.min()
			.unwrap_or(0);
		let min_y = objects
			.iter()
			.map(|object| object.bbox[1])
			.min()
			.unwrap_or(0);
		let max_x = objects
			.iter()
			.map(|object| object.bbox[0] + object.bbox[2])
			.max()
			.unwrap_or(image_w);
		let max_y = objects
			.iter()
			.map(|object| object.bbox[1] + object.bbox[3])
			.max()
			.unwrap_or(image_h);
		let pad_x = ((max_x - min_x) as f32 * 0.05).ceil() as u32;
		let pad_y = ((max_y - min_y) as f32 * 0.05).ceil() as u32;
		let x0 = min_x.saturating_sub(pad_x);
		let y0 = min_y.saturating_sub(pad_y);
		let x1 = (max_x + pad_x).min(image_w);
		let y1 = (max_y + pad_y).min(image_h);
		[x0, y0, x1 - x0, y1 - y0]
	} else {
		return Err(VisionError::new("invalid_request", "crop requires bbox or auto:true"));
	};
	let output = image.crop_imm(bbox[0], bbox[1], bbox[2], bbox[3]);
	image_io::save(&output, out)?;
	Ok(bbox)
}

fn validate_bbox(bbox: [u32; 4], image_w: u32, image_h: u32) -> Result<[u32; 4], VisionError> {
	if bbox[2] == 0
		|| bbox[3] == 0
		|| bbox[0] >= image_w
		|| bbox[1] >= image_h
		|| bbox[0].saturating_add(bbox[2]) > image_w
		|| bbox[1].saturating_add(bbox[3]) > image_h
	{
		return Err(VisionError::new(
			"invalid_bbox",
			format!("bbox {bbox:?} lies outside image dimensions {image_w}x{image_h}"),
		));
	}
	Ok(bbox)
}
