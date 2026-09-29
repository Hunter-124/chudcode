import { sleep } from "@chudware/utils/async";
import * as fsx from "@chudware/utils/fsx";
import { AgentSession } from "../../src/session/agent-session";

const outputPath = process.env.CHUDCODE_TITLE_PROBE_PATH;
if (!outputPath) {
	throw new Error("CHUDCODE_TITLE_PROBE_PATH is required");
}

let generatedFrom: string | undefined;

AgentSession.prototype.generateTitle = (firstMessage: string): Promise<string | null> => {
	generatedFrom = firstMessage;
	return Promise.resolve("CLI Initial Title");
};

AgentSession.prototype.prompt = async function (): Promise<boolean> {
	void sleep(100).then(async () => {
		await fsx.write(outputPath, JSON.stringify({ generatedFrom, sessionName: this.sessionName }));
		process.exit(0);
	});
	return true;
};
