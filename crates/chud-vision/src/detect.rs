use std::path::Path;

use image::{DynamicImage, GenericImageView};

use crate::{
	image_io, inference,
	protocol::{Face, Object, VisionError},
};

static COCO_LABELS: &[&str; 80] = &[
	"person",
	"bicycle",
	"car",
	"motorcycle",
	"airplane",
	"bus",
	"train",
	"truck",
	"boat",
	"traffic light",
	"fire hydrant",
	"stop sign",
	"parking meter",
	"bench",
	"bird",
	"cat",
	"dog",
	"horse",
	"sheep",
	"cow",
	"elephant",
	"bear",
	"zebra",
	"giraffe",
	"backpack",
	"umbrella",
	"handbag",
	"tie",
	"suitcase",
	"frisbee",
	"skis",
	"snowboard",
	"sports ball",
	"kite",
	"baseball bat",
	"baseball glove",
	"skateboard",
	"surfboard",
	"tennis racket",
	"bottle",
	"wine glass",
	"cup",
	"fork",
	"knife",
	"spoon",
	"bowl",
	"banana",
	"apple",
	"sandwich",
	"orange",
	"broccoli",
	"carrot",
	"hot dog",
	"pizza",
	"donut",
	"cake",
	"chair",
	"couch",
	"potted plant",
	"bed",
	"dining table",
	"toilet",
	"tv",
	"laptop",
	"mouse",
	"remote",
	"keyboard",
	"cell phone",
	"microwave",
	"oven",
	"toaster",
	"sink",
	"refrigerator",
	"book",
	"clock",
	"vase",
	"scissors",
	"teddy bear",
	"hair drier",
	"toothbrush",
];

pub fn objects(
	image: &DynamicImage,
	model: &Path,
	threshold: f32,
	max_results: usize,
) -> Result<Vec<Object>, VisionError> {
	let (source_w, source_h) = image.dimensions();
	let resized = image_io::resize_rgb(image, 640, 640);
	let data = image_io::normalized_nchw(&resized, [0.0; 3], [1.0; 3], false);
	let tensor = inference::tensor_f32(vec![1, 3, 640, 640], data)?;
	let mut session = inference::session(model)?;
	let outputs = inference::run_one(&mut session, tensor)?;
	if outputs.len() < 2 {
		return Err(VisionError::new(
			"model_incompatible",
			"D-FINE returned fewer than two output tensors",
		));
	}
	let logits_value = outputs.get("logits").unwrap_or(&outputs[0]);
	let boxes_value = outputs
		.get("pred_boxes")
		.or_else(|| outputs.get("boxes"))
		.unwrap_or(&outputs[1]);
	let (logit_shape, logits) = logits_value.try_extract_tensor::<f32>().map_err(|error| {
		VisionError::new("inference_failed", format!("D-FINE logits are invalid: {error}"))
	})?;
	let (box_shape, boxes) = boxes_value.try_extract_tensor::<f32>().map_err(|error| {
		VisionError::new("inference_failed", format!("D-FINE boxes are invalid: {error}"))
	})?;
	if logit_shape.len() < 2 || box_shape.len() < 2 || boxes.len() % 4 != 0 {
		return Err(VisionError::new(
			"model_incompatible",
			"D-FINE output tensors have unexpected shapes",
		));
	}
	let queries = boxes.len() / 4;
	if queries == 0 || logits.len() % queries != 0 {
		return Err(VisionError::new(
			"model_incompatible",
			"D-FINE logits do not align with predicted boxes",
		));
	}
	let classes = logits.len() / queries;
	let mut candidates = Vec::new();
	for query in 0..queries {
		let scores = &logits[query * classes..(query + 1) * classes];
		let Some((class, raw_score)) = scores
			.iter()
			.take(COCO_LABELS.len())
			.enumerate()
			.max_by(|left, right| left.1.total_cmp(right.1))
		else {
			continue;
		};
		if !raw_score.is_finite() {
			continue;
		}
		let confidence = 1.0 / (1.0 + (-raw_score).exp());
		if confidence < threshold {
			continue;
		}
		let values = &boxes[query * 4..query * 4 + 4];
		if values.iter().any(|value| !value.is_finite()) {
			continue;
		}
		let cx = values[0] * source_w as f32;
		let cy = values[1] * source_h as f32;
		let width = values[2] * source_w as f32;
		let height = values[3] * source_h as f32;
		if let Some(bbox) = image_io::clamp_bbox(
			[
				(cx - width / 2.0).round() as i32,
				(cy - height / 2.0).round() as i32,
				width.round() as i32,
				height.round() as i32,
			],
			source_w,
			source_h,
		) {
			candidates.push(Object { label: COCO_LABELS[class].to_string(), confidence, bbox });
		}
	}
	candidates.sort_by(|left, right| right.confidence.total_cmp(&left.confidence));
	let mut selected: Vec<Object> = Vec::new();
	for candidate in candidates {
		if selected.iter().any(|existing| {
			existing.label == candidate.label
				&& image_io::intersection_over_union(existing.bbox, candidate.bbox) > 0.5
		}) {
			continue;
		}
		selected.push(candidate);
		if selected.len() >= max_results.clamp(1, 100) {
			break;
		}
	}
	Ok(selected)
}

pub fn faces(
	image: &DynamicImage,
	model: &Path,
	threshold: f32,
	max_results: usize,
) -> Result<Vec<Face>, VisionError> {
	let (source_w, source_h) = image.dimensions();
	// The OpenCV Zoo 2023mar export is fixed at 640×640; FaceDetectorYN's
	// dynamic setInputSize API does not make this ONNX graph dynamic.
	let input_w = 640u32;
	let input_h = 640u32;
	let resized = image_io::resize_rgb(image, input_w, input_h);
	let data = image_io::normalized_nchw(&resized, [0.0; 3], [1.0 / 255.0; 3], true);
	let tensor = inference::tensor_f32(vec![1, 3, input_h as i64, input_w as i64], data)?;
	let mut session = inference::session(model)?;
	let outputs = inference::run_one(&mut session, tensor)?;
	let mut candidates = Vec::new();
	for stride in [8u32, 16, 32] {
		let cls_name = format!("cls_{stride}");
		let obj_name = format!("obj_{stride}");
		let bbox_name = format!("bbox_{stride}");
		let cls_value = outputs.get(&cls_name).ok_or_else(|| {
			VisionError::new("model_incompatible", format!("YuNet lacks output {cls_name}"))
		})?;
		let obj_value = outputs.get(&obj_name).ok_or_else(|| {
			VisionError::new("model_incompatible", format!("YuNet lacks output {obj_name}"))
		})?;
		let bbox_value = outputs.get(&bbox_name).ok_or_else(|| {
			VisionError::new("model_incompatible", format!("YuNet lacks output {bbox_name}"))
		})?;
		let (_, cls) = cls_value
			.try_extract_tensor::<f32>()
			.map_err(invalid_yunet)?;
		let (_, obj) = obj_value
			.try_extract_tensor::<f32>()
			.map_err(invalid_yunet)?;
		let (_, bbox) = bbox_value
			.try_extract_tensor::<f32>()
			.map_err(invalid_yunet)?;
		let count = cls.len().min(obj.len()).min(bbox.len() / 4);
		let grid_w = (input_w / stride) as usize;
		if grid_w == 0 {
			continue;
		}
		for index in 0..count {
			if !cls[index].is_finite()
				|| !obj[index].is_finite()
				|| bbox[index * 4..index * 4 + 4]
					.iter()
					.any(|value| !value.is_finite())
			{
				continue;
			}
			let confidence = (cls[index].clamp(0.0, 1.0) * obj[index].clamp(0.0, 1.0)).sqrt();
			if confidence < threshold {
				continue;
			}
			let grid_x = (index % grid_w) as f32;
			let grid_y = (index / grid_w) as f32;
			let values = &bbox[index * 4..index * 4 + 4];
			let center_x = (grid_x + 0.5 + values[0]) * stride as f32;
			let center_y = (grid_y + 0.5 + values[1]) * stride as f32;
			let width = values[2].exp() * stride as f32;
			let height = values[3].exp() * stride as f32;
			if let Some(boxed) = image_io::scale_bbox(
				[center_x - width / 2.0, center_y - height / 2.0, width, height],
				source_w as f32 / input_w as f32,
				source_h as f32 / input_h as f32,
				source_w,
				source_h,
			) {
				candidates.push(Face { bbox: boxed, confidence });
			}
		}
	}
	candidates.sort_by(|left, right| right.confidence.total_cmp(&left.confidence));
	let mut selected: Vec<Face> = Vec::new();
	for face in candidates {
		if selected
			.iter()
			.any(|existing| image_io::intersection_over_union(existing.bbox, face.bbox) > 0.35)
		{
			continue;
		}
		selected.push(face);
		if selected.len() >= max_results.clamp(1, 100) {
			break;
		}
	}
	Ok(selected)
}

fn invalid_yunet(error: ort::Error) -> VisionError {
	VisionError::new("inference_failed", format!("YuNet output is invalid: {error}"))
}
