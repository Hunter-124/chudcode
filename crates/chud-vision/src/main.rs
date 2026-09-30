mod classify;
mod crop;
mod detect;
mod diff;
mod image_io;
mod imagenet;
mod inference;
mod locate;
mod models;
mod ocr;
mod protocol;
mod redact;

use std::{
	io::{self, BufRead, Write},
	path::Path,
};

use protocol::{Request, VisionError, required_path};
use serde_json::{Value, json};

fn main() {
	if std::env::args().any(|argument| argument == "--print-manifest") {
		println!("{}", serde_json::to_string(models::MANIFEST).expect("manifest serializes"));
		return;
	}
	let stdin = io::stdin();
	let mut stdout = io::BufWriter::new(io::stdout().lock());
	for line in stdin.lock().lines() {
		let response = match line {
			Ok(line) if !line.trim().is_empty() => match serde_json::from_str::<Request>(&line) {
				Ok(request) => dispatch(&request).unwrap_or_else(|error| error.response()),
				Err(error) => VisionError::new(
					"invalid_request",
					format!("request is not valid JSON for the vision protocol: {error}"),
				)
				.response(),
			},
			Ok(_) => continue,
			Err(error) => {
				VisionError::new("input_unreadable", format!("cannot read NDJSON request: {error}"))
					.response()
			},
		};
		if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
			return;
		}
	}
}

fn dispatch(request: &Request) -> Result<Value, VisionError> {
	let max_results = request.max_results.unwrap_or(25).clamp(1, 100);
	match request.action.as_str() {
		"classify" => {
			let image = image_io::load(required_path(&request.path, "path")?)?;
			let model_dir = models::model_dir(request.model_dir.as_deref());
			let model = models::model_path(&model_dir, "mobilenetv4")?;
			let labels = classify::classify(
				&image,
				&model,
				request.top_k.unwrap_or(max_results).min(max_results),
			)?;
			Ok(json!({ "ok": true, "labels": labels }))
		},
		"detect" => {
			let image = image_io::load(required_path(&request.path, "path")?)?;
			let model_dir = models::model_dir(request.model_dir.as_deref());
			let object_model = models::model_path(&model_dir, "dfine_n_coco")?;
			let face_model = models::model_path(&model_dir, "yunet")?;
			let threshold = request.threshold.unwrap_or(0.35).clamp(0.0, 1.0);
			let objects = detect::objects(&image, &object_model, threshold, max_results)?;
			let faces = detect::faces(&image, &face_model, threshold.max(0.6), max_results)?;
			Ok(json!({ "ok": true, "objects": objects, "faces": faces }))
		},
		"ocr" => {
			let image = image_io::load(required_path(&request.path, "path")?)?;
			let model_dir = models::model_dir(request.model_dir.as_deref());
			let (detector, recognizer, dictionary) = ocr_paths(&model_dir)?;
			let (text_regions, full_text) =
				ocr::recognize(&image, &detector, &recognizer, &dictionary, max_results)?;
			Ok(json!({ "ok": true, "text_regions": text_regions, "full_text": full_text }))
		},
		"redact" => {
			let image = image_io::load(required_path(&request.path, "path")?)?;
			let out = required_path(&request.out, "out")?;
			let options = request.redact.clone().unwrap_or_default();
			let model_dir = models::model_dir(request.model_dir.as_deref());
			let need_faces = protocol::RedactOptions::enabled(options.faces, true);
			let need_text = protocol::RedactOptions::enabled(options.emails, true)
				|| protocol::RedactOptions::enabled(options.phones, true)
				|| protocol::RedactOptions::enabled(options.cards, true)
				|| protocol::RedactOptions::enabled(options.keys, true)
				|| protocol::RedactOptions::enabled(options.all_text, false);
			let yunet = if need_faces {
				models::model_path(&model_dir, "yunet")?
			} else {
				model_dir.join("face_detection_yunet_2023mar.onnx")
			};
			let (detector, recognizer, dictionary) = if need_text {
				ocr_paths(&model_dir)?
			} else {
				(
					model_dir.join("ppocrv5_mobile_det.onnx"),
					model_dir.join("ppocrv5_mobile_rec.onnx"),
					model_dir.join("ppocrv5_mobile_rec.yml"),
				)
			};
			let redactions = redact::redact(
				&image,
				&yunet,
				&detector,
				&recognizer,
				&dictionary,
				&options,
				out,
				max_results,
			)?;
			Ok(json!({ "ok": true, "redactions": redactions, "out": out }))
		},
		"crop" => {
			let image = image_io::load(required_path(&request.path, "path")?)?;
			let out = required_path(&request.out, "out")?;
			let model_dir = models::model_dir(request.model_dir.as_deref());
			let detector = if request.bbox.is_none() && request.auto {
				models::model_path(&model_dir, "dfine_n_coco")?
			} else {
				model_dir.join("dfine_n_coco.onnx")
			};
			let bbox = crop::crop(&image, request.bbox, request.auto, &detector, out, max_results)?;
			Ok(json!({ "ok": true, "bbox": bbox, "out": out }))
		},
		"locate" => {
			let image = image_io::load(required_path(&request.path, "path")?)?;
			if request.query.is_none() && request.template.is_none() {
				return Err(VisionError::new(
					"invalid_request",
					"locate requires query and/or template",
				));
			}
			let mut matches = Vec::new();
			if let Some(query) = request.query.as_deref() {
				let model_dir = models::model_dir(request.model_dir.as_deref());
				let (detector, recognizer, dictionary) = ocr_paths(&model_dir)?;
				matches = locate::locate_text(
					&image,
					query,
					&detector,
					&recognizer,
					&dictionary,
					max_results,
				)?;
			}
			if let Some(template_path) = request.template.as_deref() {
				let template = locate::load_template(template_path)?;
				let template_matches = locate::locate_template(
					&image,
					&template,
					request.threshold.unwrap_or(0.8).clamp(0.0, 1.0),
					max_results,
				)?;
				matches = locate::merge_matches(matches, template_matches, max_results);
			}
			Ok(json!({ "ok": true, "matches": matches }))
		},
		"diff" => {
			let first = image_io::load(required_path(&request.path, "path")?)?;
			let second = image_io::load(required_path(&request.path_b, "path_b")?)?;
			let result = diff::compare(&first, &second, request.out.as_deref(), max_results)?;
			let mut response = json!({
				 "ok": true,
				 "changed_pct": result.changed_pct,
				 "regions": result.regions,
			});
			if let Some(out) = request.out.as_deref() {
				response["out"] = json!(out);
			}
			Ok(response)
		},
		"describe" => {
			let image = image_io::load(required_path(&request.path, "path")?)?;
			let model_dir = models::model_dir(request.model_dir.as_deref());
			let classifier = models::model_path(&model_dir, "mobilenetv4")?;
			let detector = models::model_path(&model_dir, "dfine_n_coco")?;
			let yunet = models::model_path(&model_dir, "yunet")?;
			let (ocr_detector, ocr_recognizer, dictionary) = ocr_paths(&model_dir)?;
			let labels = classify::classify(
				&image,
				&classifier,
				request.top_k.unwrap_or(max_results).min(max_results),
			)?;
			let objects =
				detect::objects(&image, &detector, request.threshold.unwrap_or(0.35), max_results)?;
			let faces = detect::faces(&image, &yunet, 0.6, max_results)?;
			let (text_regions, full_text) =
				ocr::recognize(&image, &ocr_detector, &ocr_recognizer, &dictionary, max_results)?;
			Ok(json!({
				 "ok": true,
				 "labels": labels,
				 "objects": objects,
				 "faces": faces,
				 "text_regions": text_regions,
				 "full_text": full_text,
			}))
		},
		_ => Err(VisionError::new(
			"unknown_action",
			"action must be one of describe, classify, detect, ocr, redact, crop, locate, diff",
		)),
	}
}

fn ocr_paths(
	model_dir: &Path,
) -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), VisionError> {
	Ok((
		models::model_path(model_dir, "ppocr_det")?,
		models::model_path(model_dir, "ppocr_rec")?,
		models::model_path(model_dir, "ppocr_dict")?,
	))
}

#[cfg(test)]
mod model_tests {
	use image::{DynamicImage, Rgb, RgbImage};

	use super::*;

	fn model_tests_enabled() -> bool {
		std::env::var_os("CHUDCODE_VISION_TEST_MODELS").is_some()
	}

	#[test]
	fn model_gated_classification_round_trip() {
		if !model_tests_enabled() {
			return;
		}
		let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(224, 224, Rgb([80, 140, 220])));
		let dir = models::model_dir(None);
		let labels =
			classify::classify(&image, &models::model_path(&dir, "mobilenetv4").unwrap(), 3).unwrap();
		assert_eq!(labels.len(), 3);
		assert!(labels.iter().all(|label| label.confidence.is_finite()));
	}

	#[test]
	fn model_gated_ocr_redact_round_trip() {
		if !model_tests_enabled() {
			return;
		}
		let Some(input) = std::env::var_os("CHUDCODE_VISION_TEST_EMAIL_IMAGE") else {
			return;
		};
		let image = image_io::load(input.to_string_lossy().as_ref()).unwrap();
		let dir = models::model_dir(None);
		let (detector, recognizer, dictionary) = ocr_paths(&dir).unwrap();
		let (_, before) = ocr::recognize(&image, &detector, &recognizer, &dictionary, 25).unwrap();
		assert!(before.to_lowercase().contains("bob@example.com"));
		let out = std::env::temp_dir().join("chud-vision-redact-roundtrip.png");
		redact::redact(
			&image,
			&models::model_path(&dir, "yunet").unwrap(),
			&detector,
			&recognizer,
			&dictionary,
			&protocol::RedactOptions::default(),
			out.to_string_lossy().as_ref(),
			25,
		)
		.unwrap();
		let processed = image_io::load(out.to_string_lossy().as_ref()).unwrap();
		let (_, after) = ocr::recognize(&processed, &detector, &recognizer, &dictionary, 25).unwrap();
		assert!(!after.to_lowercase().contains("bob@example.com"));
		let _ = std::fs::remove_file(out);
	}
}
