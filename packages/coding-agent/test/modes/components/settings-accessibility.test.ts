import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { isAdvancedSetting } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { getAllSettingDefs, getSettingDef } from "@oh-my-pi/pi-coding-agent/modes/components/settings-defs";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry(120);
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

function stubStdoutGeometry(cols: number): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 40, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	return {
		restore() {
			if (rowsDesc) Object.defineProperty(process.stdout, "rows", rowsDesc);
			if (colsDesc) Object.defineProperty(process.stdout, "columns", colsDesc);
		},
	};
}

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			cwd: process.cwd(),
		},
		{
			onChange: () => {},
			onCancel: () => {},
		},
	);
}

function type(component: SettingsSelectorComponent, value: string): void {
	for (const character of value) component.handleInput(character);
}

describe("settings accessibility", () => {
	it("round-trips a custom numeric preset value and rejects invalid input without corruption", () => {
		const component = createSelector();
		type(component, "ask.timeout");
		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("Ask Timeout");

		component.handleInput("\n");
		for (let index = 0; index < 5; index++) component.handleInput("\x1b[B");
		component.handleInput("\n");
		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("Ask Timeout — Custom");
		component.handleInput("\x15");
		type(component, "45");
		component.handleInput("\n");
		expect(settings.get("ask.timeout")).toBe(45);

		component.handleInput("\n");
		component.handleInput("\n");
		component.handleInput("\x15");
		type(component, "not-a-number");
		component.handleInput("\n");

		const invalid = Bun.stripANSI(component.render(120).join("\n"));
		expect(invalid).toContain("ask.timeout must be a finite number");
		expect(settings.get("ask.timeout")).toBe(45);
	});

	it("keeps the tier control visible while Basic hides and Advanced reveals expert settings", () => {
		expect(settings.get("settings.tier")).toBe("basic");
		const tier = getSettingDef("settings.tier");
		const advanced = getSettingDef("retry.maxRetries");
		expect(tier?.condition?.() ?? true).toBe(true);
		expect(advanced?.condition?.()).toBe(false);

		Settings.instance.set("settings.tier", "advanced");
		expect(tier?.condition?.() ?? true).toBe(true);
		expect(advanced?.condition?.()).toBe(true);
	});

	it("has no Basic setting whose visibility depends on an Advanced setting", () => {
		const violations = getAllSettingDefs().flatMap(def => {
			if (isAdvancedSetting(def.path)) return [];
			return def.conditionDependencies
				.filter(isAdvancedSetting)
				.map(dependency => `${def.path} depends on ${dependency}`);
		});
		expect(violations).toEqual([]);
	});

	it("searches setting paths as well as labels and descriptions", () => {
		Settings.instance.set("settings.tier", "advanced");
		const component = createSelector();
		type(component, "maxDelayMs");
		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("Max Retry Delay");
	});

	it("flattens Basic groups while Advanced retains the section sidebar", () => {
		const basic = Bun.stripANSI(createSelector().render(120).join("\n"));
		expect(basic).toContain("Dark Theme");
		expect(basic).toContain("Show Token Usage");

		Settings.instance.set("settings.tier", "advanced");
		const advanced = Bun.stripANSI(createSelector().render(120).join("\n"));
		expect(advanced).toContain("Dark Theme");
		expect(advanced).not.toContain("Show Token Usage");
	});
});
