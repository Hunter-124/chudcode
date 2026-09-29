use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::protocol::VisionError;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ModelSpec {
	pub id:       &'static str,
	pub filename: &'static str,
	pub sha256:   &'static str,
	pub url:      &'static str,
	pub bytes:    u64,
}

pub static MANIFEST: &[ModelSpec] = &[
    ModelSpec {
        id: "mobilenetv4",
        filename: "mobilenetv4.onnx",
        sha256: "ca5b8dbf490f54e83c5d72f787821565447ea94347935f6b834cf0a4af0e8d37",
        url: "https://huggingface.co/onnx-community/mobilenetv4_conv_small.e2400_r224_in1k/resolve/main/onnx/model.onnx",
        bytes: 15_086_122,
    },
    ModelSpec {
        id: "dfine_n_coco",
        filename: "dfine_n_coco.onnx",
        sha256: "0f684f409618ee8a822410e754a29caa817d1aa16283ce89cad936d0a48e2f35",
        url: "https://huggingface.co/onnx-community/dfine_n_coco-ONNX/resolve/main/onnx/model.onnx",
        bytes: 15_258_358,
    },
    ModelSpec {
        id: "yunet",
        filename: "face_detection_yunet_2023mar.onnx",
        sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
        url: "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        bytes: 232_589,
    },
    ModelSpec {
        id: "ppocr_det",
        filename: "ppocrv5_mobile_det.onnx",
        sha256: "a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d",
        url: "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx",
        bytes: 4_826_518,
    },
    ModelSpec {
        id: "ppocr_rec",
        filename: "ppocrv5_mobile_rec.onnx",
        sha256: "da72dc72ca4dc220df0dfde68c1dedc31c58d3e76a25871122e5056227d50092",
        url: "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx",
        bytes: 16_534_782,
    },
    ModelSpec {
        id: "ppocr_dict",
        filename: "ppocrv5_mobile_rec.yml",
        sha256: "5dfeb2777f6d0db8177d8128a8acfcf6e6276dc4ac73ea3bf0dc06d6a5e85d8e",
        url: "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx/resolve/main/inference.yml",
        bytes: 148_345,
    },
];

pub fn model_dir(request_dir: Option<&str>) -> PathBuf {
	if let Some(dir) = request_dir.filter(|v| !v.is_empty()) {
		return PathBuf::from(dir);
	}
	if let Some(dir) = std::env::var_os("CHUDCODE_VISION_MODEL_DIR") {
		return PathBuf::from(dir);
	}
	let home = std::env::var_os("HOME").unwrap_or_else(|| ".".into());
	PathBuf::from(home).join(".chudcode/models/vision")
}

pub fn model_path(dir: &Path, id: &str) -> Result<PathBuf, VisionError> {
	let spec = MANIFEST
		.iter()
		.find(|spec| spec.id == id)
		.ok_or_else(|| VisionError::new("unknown_model", format!("unknown vision model id {id}")))?;
	let path = dir.join(spec.filename);
	if !path.is_file() {
		return Err(VisionError::new(
			"model_missing",
			format!("place model {} at {} or enable vision.autoDownload", spec.id, path.display()),
		));
	}
	Ok(path)
}
