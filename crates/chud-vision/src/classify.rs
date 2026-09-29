use std::path::Path;

use image::DynamicImage;

use crate::{
	image_io,
	imagenet::IMAGENET_LABELS,
	inference,
	protocol::{Label, VisionError},
};

pub fn classify(
	image: &DynamicImage,
	model: &Path,
	top_k: usize,
) -> Result<Vec<Label>, VisionError> {
	let input_image = image_io::center_crop_224(image);
	let data =
		image_io::normalized_nchw(&input_image, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225], false);
	let tensor = inference::tensor_f32(vec![1, 3, 224, 224], data)?;
	let mut session = inference::session(model)?;
	let outputs = inference::run_one(&mut session, tensor)?;
	if outputs.len() == 0 {
		return Err(VisionError::new("model_incompatible", "MobileNet returned no output tensors"));
	}
	let (_, logits) = outputs[0].try_extract_tensor::<f32>().map_err(|error| {
		VisionError::new(
			"inference_failed",
			format!("MobileNet output is not a float tensor: {error}"),
		)
	})?;
	if logits.len() < IMAGENET_LABELS.len() {
		return Err(VisionError::new(
			"model_incompatible",
			format!(
				"MobileNet returned {} scores, expected at least {}",
				logits.len(),
				IMAGENET_LABELS.len()
			),
		));
	}
	let logits = &logits[logits.len() - IMAGENET_LABELS.len()..];
	let max_logit = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
	let denominator: f32 = logits.iter().map(|value| (*value - max_logit).exp()).sum();
	if !denominator.is_finite() || denominator <= 0.0 {
		return Err(VisionError::new("inference_failed", "MobileNet returned non-finite logits"));
	}
	let mut ranked: Vec<(usize, f32)> = logits
		.iter()
		.enumerate()
		.map(|(index, value)| (index, (*value - max_logit).exp() / denominator))
		.collect();
	ranked.sort_by(|left, right| right.1.total_cmp(&left.1));
	Ok(ranked
		.into_iter()
		.take(top_k.clamp(1, 25))
		.map(|(index, confidence)| Label { label: IMAGENET_LABELS[index].to_string(), confidence })
		.collect())
}
