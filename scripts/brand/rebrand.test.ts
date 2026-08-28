import { describe, expect, test } from "bun:test";
import { transformText } from "./rebrand";

describe("Chudcode brand codemod", () => {
	test("leaves homonyms, URLs, package names, env names, persisted paths, and compatibility commands unchanged", () => {
		const fixture = [
			"compile component comparison composer",
			"Chudware chudware-hostd /home/hunter/Repositories/CAD/vendor/chudcode",
			"--from https://github.com/Hunter-124/chudware.git",
			"https://chudware.sh https://github.com/Hunter-124/chudcode",
			"@chudware/stats @chudware/coding-agent",
			"CHUDCODE_PROFILE CHUDCODE_PROFILE ~/.chudcode/agent/LICENSE Chudcode.claimTarget",
			"nix build .#chudcode",
			"`chudware-code` compatibility command",
			"`chcode` short compatibility alias",
			"chudcode legacy alias",
			"`chudcode`-based scripts",
			"Chudcode v0.1.0 (based on chudcode 18.0.8)",
		].join("\n");

		expect(transformText(fixture, "docs/homonym-fixture.md").text).toBe(fixture);
	});

	test("rebrands intermediate and upstream product prose and command examples", () => {
		const fixture =
			"# Chudware Code\nChudware Code replaces Chudcode.\nRepository: Hunter-124/chudware\nPick a model — chudcode will run it.\n`chudware-code models`\n$ chudcode --version\n";
		expect(transformText(fixture, "docs/example.md").text).toBe(
			"# Chudcode\nChudcode replaces Chudcode.\nRepository: Hunter-124/chudcode\nPick a model — Chudcode will run it.\n`chudcode models`\n$ chudcode --version\n",
		);
	});
});
