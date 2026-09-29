use std::{path::Path, sync::LazyLock};

use ort::{session::Session, value::Tensor};

use crate::protocol::VisionError;

static ORT_INIT: LazyLock<Result<(), String>> = LazyLock::new(|| {
	let path = std::env::var_os("ORT_DYLIB_PATH")
		.filter(|value| !value.is_empty())
		.ok_or_else(|| {
			"ORT_DYLIB_PATH is unset; point it at the shipped libonnxruntime shared library"
				.to_string()
		})?;
	ort::init_from(&path)
		.map_err(|error| format!("cannot load {}: {error}", Path::new(&path).display()))?
		.commit();
	Ok(())
});

pub fn ensure_runtime() -> Result<(), VisionError> {
	(*ORT_INIT)
		.clone()
		.map_err(|hint| VisionError::new("runtime_missing", hint))
}

pub fn session(path: &Path) -> Result<Session, VisionError> {
	ensure_runtime()?;
	Session::builder()
		.and_then(|mut builder| builder.commit_from_file(path))
		.map_err(|error| {
			VisionError::new(
				"model_load_failed",
				format!("cannot load ONNX model {}: {error}", path.display()),
			)
		})
}

pub fn tensor_f32(shape: Vec<i64>, data: Vec<f32>) -> Result<Tensor<f32>, VisionError> {
	Tensor::from_array((shape, data.into_boxed_slice())).map_err(|error| {
		VisionError::new("inference_failed", format!("cannot create input tensor: {error}"))
	})
}

pub fn run_one<'s>(
	session: &'s mut Session,
	input: Tensor<f32>,
) -> Result<ort::session::SessionOutputs<'s>, VisionError> {
	session.run(ort::inputs![input]).map_err(|error| {
		VisionError::new("inference_failed", format!("ONNX Runtime inference failed: {error}"))
	})
}
