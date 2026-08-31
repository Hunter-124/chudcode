/**
 * Check for and install updates.
 */

import { Command, Flags } from "@chudware/utils/cli";
import { PRODUCT_CLI_NAME } from "../brand";
import { updateHelp as commandHelp } from "../cli/command-help";
import * as pluginCli from "../cli/plugin-cli";
import * as updateCli from "../cli/update-cli";
import { CliUsageError } from "../cli/usage-error";
import { initTheme } from "../modes/theme/theme";

export default class Update extends Command {
	static description = commandHelp.description;
	static flags = {
		force: Flags.boolean({ char: "f", description: "Force update", default: false }),
		check: Flags.boolean({ char: "c", description: "Check for updates without installing", default: false }),
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
		canary: Flags.boolean({ description: "Switch to the canary channel and update", default: false }),
		stable: Flags.boolean({ description: "Switch back to the stable channel", default: false }),
	};

	static examples = [
		`${PRODUCT_CLI_NAME} update`,
		`${PRODUCT_CLI_NAME} update --check`,
		`${PRODUCT_CLI_NAME} update --canary`,
		`# If GitHub rate-limits release metadata, set GITHUB_TOKEN or GH_TOKEN\n  GITHUB_TOKEN=... ${PRODUCT_CLI_NAME} update`,
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		await initTheme();
		if (flags.canary && flags.stable) throw new CliUsageError("--canary and --stable are mutually exclusive");
		if (flags.plugins) {
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: {} });
		} else {
			await updateCli.runUpdateCommand({
				force: flags.force,
				check: flags.check,
				channel: flags.canary ? "canary" : flags.stable ? "stable" : undefined,
			});
		}
	}
}
