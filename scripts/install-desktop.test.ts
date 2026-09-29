import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { PRODUCT_SEMVER, PRODUCT_VERSION } from "../packages/coding-agent/src/brand";
import {
	buildReleaseManifest,
	DESKTOP_RELEASE_TARGETS,
	formatChecksums,
	hashReleaseFile,
} from "./ci-release-checksums";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

const noticeTokens = "GLFW ImGui IXWebSocket libvterm stb_image Rubik JetBrains Mono Monaco xterm.js Bun\n";

async function makeOfflineRelease(root: string, version = PRODUCT_SEMVER): Promise<string> {
	const artifacts = path.join(root, "artifacts");
	const payload = path.join(root, "payload");
	await Promise.all([
		fs.mkdir(path.join(payload, "web"), { recursive: true }),
		fs.mkdir(path.join(payload, "assets"), { recursive: true }),
		fs.mkdir(artifacts, { recursive: true }),
	]);
	const executable = (output: string) => `#!/bin/sh\n[ "$1" = "--version" ] || exit 2\nprintf '%s\\n' '${output}'\n`;
	await Promise.all([
		fs.writeFile(path.join(payload, "chud"), executable(PRODUCT_VERSION), {
			mode: 0o755,
		}),
		fs.writeFile(path.join(payload, "chudcode-desktop"), executable(version), { mode: 0o755 }),
		fs.writeFile(path.join(payload, "chudcode-gui"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }),
		fs.writeFile(path.join(payload, "VERSION"), `${version}\n`),
		fs.writeFile(path.join(payload, "NOTICE"), "Chudcode\n"),
		fs.writeFile(path.join(payload, "THIRD-PARTY-NOTICES.txt"), noticeTokens),
		fs.writeFile(path.join(payload, "web", "index.html"), "<!doctype html>"),
		fs.writeFile(path.join(payload, "assets", "icon.png"), "icon"),
	]);
	const selected = path.join(artifacts, "chudcode-desktop-linux-x64.tar.gz");
	const packed = await $`tar -czf ${selected} -C ${payload} .`.quiet().nothrow();
	if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
	for (const target of DESKTOP_RELEASE_TARGETS) {
		const file = path.join(artifacts, target.file);
		if (file !== selected) await fs.writeFile(file, `fixture-${target.target}`);
	}
	const entries = await Promise.all(
		DESKTOP_RELEASE_TARGETS.map(target => hashReleaseFile(path.join(artifacts, target.file))),
	);
	const manifestPath = path.join(artifacts, "release-manifest.json");
	await fs.writeFile(manifestPath, `${JSON.stringify(buildReleaseManifest(entries, version), null, 2)}\n`);
	const selectedEntry = entries.find(entry => entry.name === path.basename(selected));
	if (!selectedEntry) throw new Error("fixture selected archive missing");
	await fs.writeFile(
		path.join(artifacts, "SHA256SUMS.txt"),
		formatChecksums([selectedEntry, await hashReleaseFile(manifestPath)]),
	);
	return artifacts;
}

async function runInstaller(root: string, artifacts: string, extraEnv: Record<string, string> = {}) {
	return await $`sh ${path.join(import.meta.dir, "..", "install.sh")}`
		.env({
			...process.env,
			HOME: path.join(root, "home"),
			CHUDCODE_ARTIFACT_DIR: artifacts,
			CHUDCODE_INSTALL_DESKTOP: "0",
			...extraEnv,
		})
		.quiet()
		.nothrow();
}

describe("standalone desktop installer", () => {
	it("is repeatable, fails closed on tampering, and leaves the active release unchanged", async () => {
		if (process.platform !== "linux" || process.arch !== "x64") return;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-install-test-"));
		roots.push(root);
		const artifacts = await makeOfflineRelease(root);
		const first = await runInstaller(root, artifacts);
		if (first.exitCode !== 0) throw new Error(first.stderr.toString());
		const current = path.join(root, "home", ".local", "share", "chudcode", "current");
		const before = await fs.readlink(current);
		const second = await runInstaller(root, artifacts);
		expect(second.exitCode).toBe(0);
		expect(await fs.readlink(current)).toBe(before);

		await fs.appendFile(path.join(artifacts, "chudcode-desktop-linux-x64.tar.gz"), "tamper");
		const tampered = await runInstaller(root, artifacts);
		expect(tampered.exitCode).not.toBe(0);
		expect(tampered.stderr.toString()).toContain("checksum mismatch");
		expect(await fs.readlink(current)).toBe(before);
	});

	it("never overwrites a marked Chudware-private runtime", async () => {
		if (process.platform !== "linux" || process.arch !== "x64") return;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-private-test-"));
		roots.push(root);
		const artifacts = await makeOfflineRelease(root);
		const privateRoot = path.join(root, "private-runtime");
		await fs.mkdir(privateRoot);
		await fs.writeFile(path.join(privateRoot, ".chudware-private-runtime"), "owned by Chudware\n");
		const result = await runInstaller(root, artifacts, { CHUDCODE_INSTALL_ROOT: privateRoot, CHUDCODE_FORCE: "1" });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("Chudware-private embedded runtime");
	});
});
