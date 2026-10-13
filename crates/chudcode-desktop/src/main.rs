use std::{
	env,
	ffi::OsString,
	fs, io,
	path::{Path, PathBuf},
	process::{Command, ExitCode},
};

const EXTENSION: &str = "chudcode-workbench";

struct Payload {
	root:      PathBuf,
	editor:    PathBuf,
	service:   PathBuf,
	chud:      PathBuf,
	extension: PathBuf,
	version:   String,
}

fn invalid(message: impl Into<String>) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn target() -> io::Result<&'static str> {
	if env::consts::ARCH != "x86_64" {
		return Err(invalid("The pinned workbench supports x64 only"));
	}
	match env::consts::OS {
		"linux" => Ok("linux-x64"),
		"macos" => Ok("darwin-x64"),
		"windows" => Ok("win32-x64"),
		_ => Err(invalid("Unsupported workbench platform")),
	}
}

fn layout(root: &Path, platform: &str) -> (PathBuf, PathBuf) {
	let editor = root.join("editor");
	match platform {
		"darwin-x64" => (
			editor.join("VSCodium.app/Contents/MacOS/VSCodium"),
			editor.join("VSCodium.app/Contents/Resources/app"),
		),
		"win32-x64" => (editor.join("VSCodium.exe"), editor.join("resources/app")),
		_ => (editor.join("codium"), editor.join("resources/app")),
	}
}

fn version(root: &Path) -> io::Result<String> {
	let text = fs::read_to_string(required_file(root, &root.join("VERSION"), false)?)?;
	let value = text.trim();
	let core = value.split(['-', '+']).next().unwrap_or_default();
	if core.split('.').count() != 3
		|| core
			.split('.')
			.any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
		|| !value
			.bytes()
			.all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
	{
		return Err(invalid("Invalid adjacent VERSION metadata"));
	}
	Ok(value.to_owned())
}

fn required_file(root: &Path, path: &Path, executable: bool) -> io::Result<PathBuf> {
	let resolved = fs::canonicalize(path)?;
	if !resolved.starts_with(root) {
		return Err(invalid(format!("Payload escapes bundle: {}", path.display())));
	}
	let metadata = fs::metadata(&resolved)?;
	if !metadata.is_file() || metadata.len() == 0 {
		return Err(invalid(format!("Missing or empty payload file: {}", path.display())));
	}
	#[cfg(unix)]
	if executable {
		use std::os::unix::fs::PermissionsExt;
		if metadata.permissions().mode() & 0o111 == 0 {
			return Err(invalid(format!("Payload is not executable: {}", path.display())));
		}
	}
	#[cfg(not(unix))]
	let _ = executable;
	Ok(resolved)
}

impl Payload {
	fn load(root: PathBuf, platform: &str) -> io::Result<Self> {
		let version = version(&root)?;
		let (editor, app) = layout(&root, platform);
		let suffix = if platform == "win32-x64" { ".exe" } else { "" };
		let extension = app.join("extensions").join(EXTENSION);
		required_file(&root, &app.join("product.json"), false)?;
		required_file(&root, &app.join("package.json"), false)?;
		required_file(&root, &root.join("candidate-manifest.json"), false)?;
		for file in
			["package.json", "dist/extension.cjs", "dist/webview/index.js", "dist/webview/index.css"]
		{
			required_file(&root, &extension.join(file), false)?;
		}
		Ok(Self {
			editor: required_file(&root, &editor, true)?,
			service: required_file(&root, &root.join(format!("chudcode-service{suffix}")), true)?,
			chud: required_file(&root, &root.join(format!("chud{suffix}")), true)?,
			extension: fs::canonicalize(extension)?,
			root,
			version,
		})
	}
}

fn absolute_env(name: &str) -> io::Result<Option<PathBuf>> {
	let Some(value) = env::var_os(name).filter(|value| !value.is_empty()) else {
		return Ok(None);
	};
	let path = PathBuf::from(value);
	if !path.is_absolute() {
		return Err(invalid(format!("{name} must be an absolute directory")));
	}
	Ok(Some(path))
}

fn home() -> io::Result<PathBuf> {
	let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
	absolute_env(variable)?
		.ok_or_else(|| invalid(format!("{variable} is required for isolated workbench state")))
}

fn state_dirs() -> io::Result<(PathBuf, PathBuf)> {
	match env::consts::OS {
		"windows" => {
			let home = home()?;
			let data = absolute_env("APPDATA")?.unwrap_or_else(|| home.join("AppData/Roaming"));
			Ok((data.join("Chudcode Workbench"), home.join(".chudcode-workbench/extensions")))
		},
		"macos" => {
			let home = home()?;
			Ok((
				home.join("Library/Application Support/Chudcode Workbench"),
				home.join(".chudcode-workbench/extensions"),
			))
		},
		_ => {
			let home = home()?;
			let config = absolute_env("XDG_CONFIG_HOME")?.unwrap_or_else(|| home.join(".config"));
			let data = absolute_env("XDG_DATA_HOME")?.unwrap_or_else(|| home.join(".local/share"));
			Ok((config.join("chudcode-workbench"), data.join("chudcode-workbench/extensions")))
		},
	}
}

fn has_option(args: &[OsString], option: &str) -> bool {
	for arg in args {
		if arg == "--" {
			break;
		}
		if arg == option
			|| arg.to_str().is_some_and(|text| {
				text
					.strip_prefix(option)
					.is_some_and(|tail| tail.starts_with('='))
			}) {
			return true;
		}
	}
	false
}

fn command(payload: &Payload, args: &[OsString]) -> io::Result<Command> {
	let mut command = Command::new(&payload.editor);
	// Never inherit source-mode executable arguments into a packaged release.
	command
		.env("CHUDCODE_WORKBENCH_SERVICE", &payload.service)
		.env_remove("CHUDCODE_WORKBENCH_SERVICE_ARGS")
		.env_remove("ELECTRON_RUN_AS_NODE")
		.env_remove("BUN_BE_BUN")
		.env_remove("VSCODE_PORTABLE");
	let explicit_data = has_option(args, "--user-data-dir");
	let explicit_extensions = has_option(args, "--extensions-dir");
	if !explicit_data || !explicit_extensions {
		let (user_data, extensions) = state_dirs()?;
		if !explicit_data {
			command.arg("--user-data-dir").arg(user_data);
		}
		if !explicit_extensions {
			command.arg("--extensions-dir").arg(extensions);
		}
	}
	command.args(args);
	Ok(command)
}

fn json_string(value: &str) -> String {
	let mut result = String::with_capacity(value.len() + 2);
	result.push('"');
	for character in value.chars() {
		match character {
			'"' => result.push_str("\\\""),
			'\\' => result.push_str("\\\\"),
			'\n' => result.push_str("\\n"),
			'\r' => result.push_str("\\r"),
			'\t' => result.push_str("\\t"),
			c if c < '\u{20}' => {
				use std::fmt::Write;
				write!(result, "\\u{:04x}", u32::from(c)).expect("String formatting cannot fail");
			},
			c => result.push(c),
		}
	}
	result.push('"');
	result
}

fn json_path(path: &Path) -> io::Result<String> {
	path
		.to_str()
		.map(json_string)
		.ok_or_else(|| invalid("--check requires Unicode payload paths"))
}

fn run() -> io::Result<ExitCode> {
	let root = env::current_exe()?
		.parent()
		.ok_or_else(|| invalid("Launcher has no parent directory"))?
		.to_path_buf();
	let root = fs::canonicalize(root)?;
	let args: Vec<OsString> = env::args_os().skip(1).collect();
	if args.len() == 1 && args[0] == "--build-info" {
		println!("{{\"role\":\"chudcode-desktop\",\"version\":\"{}\"}}", env!("CARGO_PKG_VERSION"));
		return Ok(ExitCode::SUCCESS);
	}
	if args.len() == 1 && args[0] == "--version" {
		println!("{}", version(&root)?);
		return Ok(ExitCode::SUCCESS);
	}
	let platform = target()?;
	let payload = Payload::load(root, platform)?;
	if args.len() == 1 && args[0] == "--check" {
		let (user_data, extensions) = state_dirs()?;
		println!(
			"{{\"version\":{},\"target\":{},\"root\":{},\"editor\":{},\"service\":{},\"chud\":{},\"\
			 extension\":{},\"userData\":{},\"extensions\":{}}}",
			json_string(&payload.version),
			json_string(platform),
			json_path(&payload.root)?,
			json_path(&payload.editor)?,
			json_path(&payload.service)?,
			json_path(&payload.chud)?,
			json_path(&payload.extension)?,
			json_path(&user_data)?,
			json_path(&extensions)?
		);
		return Ok(ExitCode::SUCCESS);
	}
	let mut command = command(&payload, &args)?;
	#[cfg(unix)]
	{
		// Replace the launcher, so signals and the editor's exit status are unchanged.
		use std::os::unix::process::CommandExt;
		Err(command.exec())
	}
	#[cfg(not(unix))]
	{
		let status = command.status()?;
		// ExitCode is only u8; Windows process statuses must not be truncated.
		std::process::exit(status.code().unwrap_or(1));
	}
}

fn main() -> ExitCode {
	match run() {
		Ok(code) => code,
		Err(error) => {
			eprintln!("chudcode-desktop: {error}");
			ExitCode::FAILURE
		},
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn platform_layouts_are_native() {
		let root = Path::new("bundle");
		assert_eq!(layout(root, "linux-x64").0, root.join("editor/codium"));
		assert_eq!(
			layout(root, "darwin-x64").0,
			root.join("editor/VSCodium.app/Contents/MacOS/VSCodium")
		);
		assert_eq!(layout(root, "win32-x64").0, root.join("editor/VSCodium.exe"));
	}

	#[test]
	fn isolation_flags_and_argument_boundary_are_preserved() {
		let args = [
			"--user-data-dir=/tmp/smoke data",
			"--extensions-dir",
			"/tmp/extensions",
			"--",
			"--user-data-dir",
		]
		.map(OsString::from);
		assert!(has_option(&args, "--user-data-dir"));
		assert!(has_option(&args, "--extensions-dir"));
		assert!(!has_option(
			&[OsString::from("--"), OsString::from("--user-data-dir")],
			"--user-data-dir"
		));
		let payload = Payload {
			root:      PathBuf::new(),
			editor:    PathBuf::from("editor"),
			service:   PathBuf::from("service"),
			chud:      PathBuf::new(),
			extension: PathBuf::new(),
			version:   String::new(),
		};
		let command =
			command(&payload, &args).expect("Explicit isolation needs no default state directories");
		assert_eq!(
			command.get_args().collect::<Vec<_>>(),
			args.iter().map(OsString::as_os_str).collect::<Vec<_>>()
		);
		for name in [
			"CHUDCODE_WORKBENCH_SERVICE_ARGS",
			"ELECTRON_RUN_AS_NODE",
			"BUN_BE_BUN",
			"VSCODE_PORTABLE",
		] {
			assert!(
				command
					.get_envs()
					.any(|(key, value)| key == name && value.is_none()),
				"{name} must not reach the packaged editor or service"
			);
		}
	}

	#[test]
	fn check_json_escapes_paths() {
		assert_eq!(json_string("C:\\folder\"\n\t\u{1}"), "\"C:\\\\folder\\\"\\n\\t\\u0001\"");
	}
}
