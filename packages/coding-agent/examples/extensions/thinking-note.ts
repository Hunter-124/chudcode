import type { ExtensionFactory } from "@chudware/coding-agent";
import { Container, Text } from "@chudware/tui";

const extension: ExtensionFactory = chud => {
	chud.setLabel("Thinking note");
	chud.registerAssistantThinkingRenderer((context, theme) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("dim", `thinking chars: ${context.text.length}`), 1, 0));
		return container;
	});
};

export default extension;
