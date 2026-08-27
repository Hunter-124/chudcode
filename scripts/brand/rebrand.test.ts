import { describe, expect, test } from "bun:test";
import { transformText } from "./rebrand";

describe("Chudcode brand codemod", () => {
	test("leaves homonyms, URLs, package names, env names, persisted paths, and compatibility commands unchanged", () => {
		const fixture = [
			"compile component comparison composer",
			"Chudware chudware-hostd /home/hunter/Repositories/CAD/vendor/omp",
			"--from https://github.com/Hunter-124/oh-my-pi.git",
			"https://omp.sh https://github.com/can1357/oh-my-pi",
			"@oh-my-pi/omp-stats @oh-my-pi/pi-coding-agent",
			"PI_PROFILE OMP_PROFILE ~/.omp/agent/LICENSE OMP.claimTarget",
			"nix build .#omp",
			"`chudware-code` compatibility command",
			"`chcode` short compatibility alias",
			"omp legacy alias",
			"`omp`-based scripts",
			"Chudcode v0.1.0 (based on omp 18.0.8)",
		].join("\n");

		expect(transformText(fixture, "docs/homonym-fixture.md").text).toBe(fixture);
	});

	test("rebrands intermediate and upstream product prose and command examples", () => {
		const fixture =
			"# Chudware Code\nChudware Code replaces Oh My Pi.\nRepository: Hunter-124/oh-my-pi\nPick a model — omp will run it.\n`chudware-code models`\n$ omp --version\n";
		expect(transformText(fixture, "docs/example.md").text).toBe(
			"# Chudcode\nChudcode replaces Chudcode.\nRepository: Hunter-124/chudcode\nPick a model — Chudcode will run it.\n`chudcode models`\n$ chudcode --version\n",
		);
	});
});
