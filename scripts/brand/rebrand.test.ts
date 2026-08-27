import { describe, expect, test } from "bun:test";
import { transformText } from "./rebrand";

describe("Chudware Code brand codemod", () => {
	test("leaves homonyms, URLs, package names, env names, and persisted paths unchanged", () => {
		const fixture = [
			"compile component comparison composer",
			"https://omp.sh https://github.com/can1357/oh-my-pi",
			"@oh-my-pi/omp-stats @oh-my-pi/pi-coding-agent",
			"PI_PROFILE OMP_PROFILE ~/.omp/agent/LICENSE OMP.claimTarget",
			"nix build .#omp",
			"omp legacy alias",
			"`omp`-based scripts",
			"Chudware Code v0.1.0 (based on omp 18.0.8)",
		].join("\n");

		expect(transformText(fixture, "docs/homonym-fixture.md").text).toBe(fixture);
	});

	test("rebrands product prose and command examples", () => {
		const fixture = "# Oh My Pi\nOMP is useful. Pick a model — omp will run it.\n`omp models`\n$ omp --version\n";
		expect(transformText(fixture, "docs/example.md").text).toBe(
			"# Chudware Code\nChudware Code is useful. Pick a model — Chudware Code will run it.\n`chudware-code models`\n$ chudware-code --version\n",
		);
	});
});
