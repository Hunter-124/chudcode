import path from "node:path";
import { getProjectDir } from "@chudware/utils";
import { Command, Flags } from "@chudware/utils/cli";
import { contextHelp as commandHelp } from "../cli/command-help";
import { auditProjectArtifacts } from "../context-curation/artifact-audit";

export default class Context extends Command {
	static description = commandHelp.description;
	static flags = {
		apply: Flags.boolean({ description: "Remove only terminal hash-verified Chudcode-managed artifacts" }),
		json: Flags.boolean({ description: "Output the machine-readable audit report" }),
		root: Flags.string({ description: "Project root to audit (defaults to the current project)" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Context);
		const report = await auditProjectArtifacts({
			root: path.resolve(flags.root ?? getProjectDir()),
			apply: flags.apply,
		});
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		} else {
			const counts = report.decisions.reduce<Record<string, number>>((result, decision) => {
				result[decision.action] = (result[decision.action] ?? 0) + 1;
				return result;
			}, {});
			process.stdout.write(
				`Context audit: ${report.filesScanned} artifacts · ${counts.remove ?? 0} removable · ${counts.archive ?? 0} archive suggestions · ${counts.deduplicate ?? 0} duplicate suggestions · ${counts.review ?? 0} review\n`,
			);
			for (const decision of report.decisions) {
				if (decision.action === "keep") continue;
				process.stdout.write(
					`- ${decision.action} ${(decision.confidence * 100).toFixed(0)}% ${decision.path}: ${decision.reason}\n`,
				);
			}
			if (flags.apply) process.stdout.write(`Removed ${report.removed.length} verified managed artifacts.\n`);
		}
		if (report.errors.length > 0) process.exitCode = 1;
	}
}
