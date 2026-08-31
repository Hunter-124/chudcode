/**
 * UI adapter over the schema. Reads `ui.options` declared inline in
 * settings-schema.ts and produces typed widget definitions for the
 * settings selector.
 *
 * To add a new setting to the UI: declare it in `settings-schema.ts`
 * with a `ui` block carrying `tab` and `group` (the group must be listed
 * in `TAB_GROUPS[tab]`). If it needs a submenu, include `options: [...]`
 * (or `options: "runtime"` for runtime-injected lists like themes).
 */

import { TERMINAL } from "@chudware/tui";
import { Settings } from "../../config/settings";
import {
	type AnyUiMetadata,
	getDefault,
	getEnumValues,
	getPathsForTab,
	getType,
	getUi,
	isCredential,
	SETTING_TABS,
	type SettingPath,
	type SettingTab,
	type SubmenuOption,
	TAB_GROUPS,
} from "../../config/settings-schema";

// ═══════════════════════════════════════════════════════════════════════════
// UI Definition Types
// ═══════════════════════════════════════════════════════════════════════════

export type SettingValue = boolean | string;

interface BaseSettingDef {
	path: SettingPath;
	label: string;
	description: string;
	/** Risk note shown in warning styling; set for settings that can get the user flagged or banned. */
	warning?: string;
	tab: SettingTab;
	/** Section within the tab; items are ordered by TAB_GROUPS[tab] and rendered under a heading row. */
	group?: string;
	/**
	 * Optional visibility predicate. When supplied and returning false, the
	 * setting is hidden from the UI. Applies to every variant — booleans,
	 * enums, submenus, and text inputs.
	 */
	condition?: () => boolean;
	/** Settings read by the visibility predicate; used to prevent Basic controls from depending on hidden controls. */
	conditionDependencies: readonly SettingPath[];
}

export interface BooleanSettingDef extends BaseSettingDef {
	type: "boolean";
}

export interface EnumSettingDef extends BaseSettingDef {
	type: "enum";
	values: readonly string[];
}

type OptionList = ReadonlyArray<SubmenuOption>;

export interface SubmenuSettingDef extends BaseSettingDef {
	type: "submenu";
	options: OptionList;
	onPreview?: (value: string) => void;
	onPreviewCancel?: (originalValue: string) => void;
}

export interface NumberSettingDef extends BaseSettingDef {
	type: "number";
	/** Presets shown before the Custom… entry. Empty means open the numeric editor directly. */
	options: OptionList;
}

export interface TextInputSettingDef extends BaseSettingDef {
	type: "text";
	secret: boolean;
}

export interface ProviderLimitsSettingDef extends BaseSettingDef {
	type: "providerLimits";
}

/** Array-of-enum setting edited as a toggle list; `ordered` lists render positions and support reordering. */
export interface MultiSelectSettingDef extends BaseSettingDef {
	type: "multiselect";
	options: OptionList;
	ordered: boolean;
}

export type SettingDef =
	| BooleanSettingDef
	| EnumSettingDef
	| SubmenuSettingDef
	| NumberSettingDef
	| TextInputSettingDef
	| ProviderLimitsSettingDef
	| MultiSelectSettingDef;

// ═══════════════════════════════════════════════════════════════════════════
// Condition Functions
// ═══════════════════════════════════════════════════════════════════════════

interface ConditionDefinition {
	test: () => boolean;
	dependsOn?: SettingPath;
}

const CONDITIONS: Record<string, ConditionDefinition> = {
	advancedSettings: {
		dependsOn: "settings.tier",
		test: () => {
			try {
				return Settings.instance.get("settings.tier") === "advanced";
			} catch {
				return false;
			}
		},
	},
	macOS: { test: () => process.platform === "darwin" },
	hasImageProtocol: { test: () => !!TERMINAL.imageProtocol },
	advisorEnabled: {
		dependsOn: "advisor.enabled",
		test: () => {
			try {
				return Settings.instance.get("advisor.enabled") === true;
			} catch {
				return false;
			}
		},
	},
	hindsightActive: {
		dependsOn: "memory.backend",
		test: () => {
			try {
				return Settings.instance.get("memory.backend") === "hindsight";
			} catch {
				return false;
			}
		},
	},
	mnemopiActive: {
		dependsOn: "memory.backend",
		test: () => {
			try {
				return Settings.instance.get("memory.backend") === "mnemo";
			} catch {
				return false;
			}
		},
	},
	autolearnActive: {
		dependsOn: "autolearn.enabled",
		test: () => {
			try {
				return Settings.instance.get("autolearn.enabled") === true;
			} catch {
				return false;
			}
		},
	},
	autoThinkingActive: {
		dependsOn: "defaultThinkingLevel",
		test: () => {
			try {
				return Settings.instance.get("defaultThinkingLevel") === "auto";
			} catch {
				return false;
			}
		},
	},
	usageAwareFallbackEnabled: {
		dependsOn: "retry.usageAwareFallback",
		test: () => {
			try {
				return Settings.instance.get("retry.usageAwareFallback") === true;
			} catch {
				return false;
			}
		},
	},
	planModeEnabled: {
		dependsOn: "plan.enabled",
		test: () => {
			try {
				return Settings.instance.get("plan.enabled");
			} catch {
				return false;
			}
		},
	},
	unexpectedStopSmart: {
		dependsOn: "features.unexpectedStopDetection",
		test: () => {
			try {
				return Settings.instance.get("features.unexpectedStopDetection") === "smart";
			} catch {
				return false;
			}
		},
	},
};

/** Whether every predicate in a composed schema visibility condition is registered. */
export function isSettingConditionResolvable(name: string): boolean {
	return name.split("&").every(part => CONDITIONS[part] !== undefined);
}

// ═══════════════════════════════════════════════════════════════════════════
// Schema to UI Conversion
// ═══════════════════════════════════════════════════════════════════════════

function resolveOptions(ui: AnyUiMetadata): OptionList | "runtime" | undefined {
	if (!ui.options) return undefined;
	if (ui.options === "runtime") return "runtime";
	return ui.options;
}

function resolveCondition(name: string | undefined): {
	test: (() => boolean) | undefined;
	dependencies: readonly SettingPath[];
} {
	if (!name) return { test: undefined, dependencies: [] };
	if (!isSettingConditionResolvable(name)) return { test: undefined, dependencies: [] };
	const definitions = name.split("&").map(part => CONDITIONS[part]);
	return {
		test: () => definitions.every(definition => definition?.test() === true),
		dependencies: definitions.flatMap(definition => (definition?.dependsOn ? [definition.dependsOn] : [])),
	};
}

function pathToSettingDef(path: SettingPath): SettingDef | null {
	const ui = getUi(path);
	if (!ui) return null;

	const schemaType = getType(path);
	const condition = resolveCondition(ui.condition);
	const base = {
		path,
		label: ui.label,
		description: ui.description,
		warning: ui.warning,
		tab: ui.tab,
		group: ui.group,
		condition: condition.test,
		conditionDependencies: condition.dependencies,
	};

	if (schemaType === "boolean") {
		return { ...base, type: "boolean" };
	}

	const options = resolveOptions(ui);

	if (schemaType === "enum") {
		if (options === undefined) {
			return { ...base, type: "enum", values: getEnumValues(path) ?? [] };
		}
		// "runtime" is not a valid sentinel for enums — schema types prevent this,
		// but treat defensively as an empty submenu.
		return { ...base, type: "submenu", options: options === "runtime" ? [] : options };
	}

	if (schemaType === "number") {
		return { ...base, type: "number", options: !options || options === "runtime" ? [] : options };
	}

	if (schemaType === "string") {
		if (options === "runtime") {
			// Empty list now; the selector layer (theme handling, etc.) injects choices.
			return { ...base, type: "submenu", options: [] };
		}
		if (options) {
			return { ...base, type: "submenu", options };
		}
		// One classification drives both surfaces: a setting marked `credential`
		// masks here too, so the panel cannot display one that only the CLI knows
		// to redact.
		return { ...base, type: "text", secret: isCredential(path) };
	}

	if (schemaType === "array") {
		// Arrays without declared options stay config-file only (free-form lists
		// like extension paths have no finite choice set to toggle).
		if (!options || options === "runtime") return null;
		return { ...base, type: "multiselect", options, ordered: ui.ordered === true };
	}

	if (schemaType === "record") {
		return path === "providers.maxInFlightRequests"
			? { ...base, type: "providerLimits" }
			: { ...base, type: "text", secret: false };
	}

	return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/** Cache of generated definitions */
let cachedDefs: SettingDef[] | null = null;

/** Get all setting definitions with UI */
export function getAllSettingDefs(): SettingDef[] {
	if (cachedDefs) return cachedDefs;

	const defs: SettingDef[] = [];
	for (const tab of SETTING_TABS) {
		for (const path of getPathsForTab(tab)) {
			const def = pathToSettingDef(path);
			if (def) defs.push(def);
		}
	}
	cachedDefs = defs;
	return defs;
}

/**
 * Get settings for a specific tab, ordered by the tab's group layout
 * (TAB_GROUPS). Ungrouped settings sort first; within a group, schema
 * declaration order is preserved.
 */
export function getSettingsForTab(tab: SettingTab): SettingDef[] {
	const defs = getAllSettingDefs().filter(def => def.tab === tab);
	const order = TAB_GROUPS[tab];
	const rank = (def: SettingDef): number => {
		if (!def.group) return -1;
		const index = order.indexOf(def.group);
		return index >= 0 ? index : order.length;
	};
	return defs.sort((a, b) => rank(a) - rank(b));
}

/** Get a setting definition by path */
export function getSettingDef(path: SettingPath): SettingDef | undefined {
	return getAllSettingDefs().find(def => def.path === path);
}

/** Get default value for display */
export function getDisplayDefault(path: SettingPath): string {
	const value = getDefault(path);
	if (value === undefined) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	return String(value);
}
