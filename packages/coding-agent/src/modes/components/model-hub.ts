/**
 * Fullscreen /models hub, shown on the alternate screen like /settings.
 *
 * Layout: a sidebar of scopes (recently used, all models, and one entry per
 * provider — locked providers included) beside a {@link ModelBrowser} body.
 * Advanced adds role assignments: it shows the concrete model and effort
 * behind each @role before offering model, thinking, and fallback edits.
 * Locked providers forward to the /login flow.
 * Fully mouse-navigable (hover, wheel, click). Session-only switching lives
 * in the compact alt+p picker ({@link ./model-picker}).
 */
import { ThinkingLevel } from "@chudware/agent-core";
import type { Model } from "@chudware/ai";
import { getOAuthProviders } from "@chudware/ai/oauth";
import { getSupportedEfforts } from "@chudware/catalog/model-thinking";
import { getCatalogProviderEntry } from "@chudware/catalog/provider-models";
import {
	type Component,
	extractPrintableText,
	fuzzyFilter,
	getKeybindings,
	Input,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@chudware/tui";
import type { ModelRegistry } from "../../config/model-registry";
import {
	describeModelSettingProvenance,
	type EffectiveModelSettings,
	type ModelRoleLookup,
	type ResolvedModelRoleValue,
	resolveEffectiveModelSettings,
	resolveModelRoleValue,
} from "../../config/model-resolver";
import { getKnownRoleIds, getRoleInfo } from "../../config/model-roles";
import type {
	ModelSettingsProfileField,
	ModelSettingsProfileTarget,
	ModelSettingsStorageScope,
	Settings,
} from "../../config/settings";
import type { CacheRetentionSetting } from "../../config/settings-schema";
import { AUTO_THINKING, type ConfiguredThinkingLevel, getConfiguredThinkingLevelMetadata } from "../../thinking";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import {
	buildBrowserItems,
	ModelBrowser,
	type ModelBrowserItem,
	type RoleAssignments,
	resolveRoleAssignments,
	sortModelItems,
	thinkingLevelGlyph,
} from "./model-browser";
import { type OverlayMouseEvent, OverlayMouseRouter } from "./mouse-routing";
import { bottomBorder, dividerSplit, row, splitBodyWidth, splitRow, topBorderSplit } from "./overlay-box";
import { renderSegmentTrack } from "./segment-track";

/**
 * A row of the Roles view: a role, a model/wildcard chain-key header, one of a
 * chain's fallback entries, or the trailing "+ New role…". Fallback rows under
 * a chain-key header carry the key in `role` — `retry.fallbackChains` treats
 * roles, `provider/model-id`, and `provider/*` keys uniformly.
 */
type RolesRow =
	| { kind: "role"; role: string }
	| { kind: "chainKey"; role: string }
	| { kind: "fallback"; role: string; chainIndex: number; selector: string }
	| { kind: "separator" }
	| { kind: "newFallback" }
	| { kind: "newRole" };

/**
 * What the model browser is currently picking for: a role's model, a slot in
 * a fallback chain (`role` may be a role name, model selector, or `provider/*`
 * key), or the primary model a brand-new fallback chain protects.
 */
type AssignTarget =
	| { kind: "role"; role: string }
	| { kind: "fallback"; role: string; index: number | null }
	| { kind: "fallbackKey" };

/** A `--models` scope entry (mirrors the session's scoped model list). */
export interface ScopedModelItem {
	model: Model;
	thinkingLevel?: string;
}

export type ModelRoleSelectionScope = "global" | "project";
export type ModelSettingsEditValue = ConfiguredThinkingLevel | CacheRetentionSetting;

export interface ModelHubCallbacks {
	/** Persist a role assignment. */
	onAssign: (
		model: Model,
		role: string,
		thinkingLevel: ConfiguredThinkingLevel | undefined,
		selector: string,
		scope?: ModelRoleSelectionScope,
	) => void;
	/** Clear a configured role back to auto-selection. */
	onUnassign: (role: string, scope?: ModelRoleSelectionScope) => void;
	/** Persist one legal model-profile leaf. Supplying both settings callbacks enables Customize controls. */
	onSetModelSettingsField?: (
		scope: ModelSettingsStorageScope,
		target: ModelSettingsProfileTarget,
		field: ModelSettingsProfileField,
		value: ModelSettingsEditValue,
	) => void;
	/** Delete one model-profile leaf so lower-precedence settings inherit immediately. */
	onResetModelSettingsField?: (
		scope: ModelSettingsStorageScope,
		target: ModelSettingsProfileTarget,
		field: ModelSettingsProfileField,
	) => void;
	/** Persist a `retry.fallbackChains` entry — keyed by a role, `provider/model-id`, or `provider/*`; an empty chain clears the key. */
	onFallbackChainChange?: (role: string, chain: string[]) => void;
	/** Locked provider activation: forward to the /login flow. */
	onLoginRequest?: (providerId: string) => void;
	/** Persist a new quick-switch cycle order (the ctrl+p role cycle). */
	onCycleOrderChange?: (order: string[]) => void;
	onCancel: () => void;
}

export interface ModelHubOptions {
	/** Preselect this provider's sidebar entry (e.g. when reopening after /login). */
	initialProviderId?: string;
}

const CACHE_RETENTION_LABELS: Readonly<Record<EffectiveModelSettings["cacheRetention"]["value"], string>> = {
	auto: "Auto",
	short: "Short",
	long: "Long",
	none: "None",
};

/** Pure copy builder shared by the Basic compact line and Advanced disclosure. */
export function formatEffectiveModelSettingsLines(
	effective: EffectiveModelSettings,
	tier: "basic" | "advanced",
): string[] {
	const thinking =
		effective.thinking.value === undefined
			? "Provider default"
			: getConfiguredThinkingLevelMetadata(effective.thinking.value).label;
	const thinkingLabel = thinking.charAt(0).toUpperCase() + thinking.slice(1);
	const cacheLabel = CACHE_RETENTION_LABELS[effective.cacheRetention.value];
	if (tier === "basic") {
		return [`Effective: Thinking ${thinkingLabel} · Prompt cache ${cacheLabel}`];
	}

	const adjusted =
		effective.thinking.adjustedFrom === undefined
			? ""
			: ` (clamped from ${getConfiguredThinkingLevelMetadata(effective.thinking.adjustedFrom).label})`;
	return [
		"Effective settings",
		`Thinking: ${thinkingLabel}${adjusted} — ${describeModelSettingProvenance(effective.thinking.provenance)}`,
		`Prompt cache: ${cacheLabel} — ${describeModelSettingProvenance(effective.cacheRetention.provenance)}`,
	];
}

interface SidebarEntry {
	id: string;
	kind: "recent" | "roles" | "all" | "separator" | "provider";
	label: string;
	providerId?: string;
	locked?: boolean;
	/** Right-aligned annotation: model count, `assigned/total`, or `login`. */
	annotation?: string;
	oauth?: boolean;
	catalogCount?: number;
}

interface StripChip {
	label: string;
	/** Pre-styled label body (without selection decoration). */
	styled: string;
}

type RoleStripChip =
	| (StripChip & {
			action: "assign";
			role: string;
			scope: ModelRoleSelectionScope;
	  })
	| (StripChip & {
			action: "unassign";
			role: string;
			scope: ModelRoleSelectionScope;
	  })
	| (StripChip & {
			action: "fallback";
	  })
	| (StripChip & {
			action: "fallbackModel";
	  })
	| (StripChip & {
			action: "fallbackProvider";
	  });

type ScopeStripChip = StripChip & {
	action: "scope";
	scope: ModelRoleSelectionScope;
};

type ThinkingStripChip = StripChip & {
	action: "thinking";
	thinkingLevel: ConfiguredThinkingLevel;
};

type SettingsTargetStripChip = StripChip & {
	action: "settingsTarget";
	settingsTarget: ModelSettingsProfileTarget;
};

type SettingsScopeStripChip = StripChip & {
	action: "settingsScope";
	scope: ModelSettingsStorageScope;
};

type SettingsFieldStripChip = StripChip & {
	action: "settingsField";
	settingsField: ModelSettingsProfileField;
};

type SettingsValueStripChip =
	| (StripChip & {
			action: "settingsReset";
	  })
	| (StripChip & {
			action: "settingsValue";
			settingsValue: ModelSettingsEditValue;
	  });

interface RoleStripState {
	kind: "role";
	item: ModelBrowserItem;
	chips: RoleStripChip[];
	index: number;
	returnToRoles: boolean;
}

interface ScopeStripState {
	kind: "scope";
	item: ModelBrowserItem;
	role: string;
	chips: ScopeStripChip[];
	index: number;
	returnToRoles: boolean;
}

interface ThinkingStripState {
	kind: "thinking";
	item: ModelBrowserItem;
	role: string;
	scope?: ModelRoleSelectionScope;
	chips: ThinkingStripChip[];
	index: number;
	returnToRoles: boolean;
}

interface SettingsTargetStripState {
	kind: "settingsTarget";
	item: ModelBrowserItem;
	role?: string;
	chips: SettingsTargetStripChip[];
	index: number;
	returnToRoles: boolean;
}

interface SettingsScopeStripState {
	kind: "settingsScope";
	item: ModelBrowserItem;
	target: ModelSettingsProfileTarget;
	chips: SettingsScopeStripChip[];
	index: number;
	returnToRoles: boolean;
}

interface SettingsFieldStripState {
	kind: "settingsField";
	item: ModelBrowserItem;
	target: ModelSettingsProfileTarget;
	scope: ModelSettingsStorageScope;
	chips: SettingsFieldStripChip[];
	index: number;
	returnToRoles: boolean;
}

interface SettingsValueStripState {
	kind: "settingsValue";
	item: ModelBrowserItem;
	target: ModelSettingsProfileTarget;
	scope: ModelSettingsStorageScope;
	field: ModelSettingsProfileField;
	chips: SettingsValueStripChip[];
	index: number;
	returnToRoles: boolean;
}

interface RoleNameStripState {
	/** Footer text input naming a new custom role. */
	kind: "roleName";
	input: Input;
}

type StripState =
	| RoleStripState
	| ScopeStripState
	| ThinkingStripState
	| SettingsTargetStripState
	| SettingsScopeStripState
	| SettingsFieldStripState
	| SettingsValueStripState
	| RoleNameStripState;

/** Recorded chip hit-range on the footer row (columns relative to frame col 0). */
interface ChipRange {
	start: number;
	end: number;
	index: number;
}

const PROVIDER_REFRESH_DEBOUNCE_MS = 120;
const RECENT_LIMIT = 15;
const SIDEBAR_MIN_WIDTH = 18;
const SIDEBAR_MAX_WIDTH = 26;

/**
 * Providers already auto-refreshed this process. Selecting a provider fetches
 * its live model list at most once per application lifetime (surviving hub
 * close/reopen); F5 re-fetches on demand.
 */
const autoRefreshedProviders = new Set<string>();

/** Test hook: forget which providers were auto-refreshed this process. */
export function resetProviderAutoRefreshGuard(): void {
	autoRefreshedProviders.clear();
}

/**
 * The fullscreen model hub component. Hosted via `ui.showOverlay(..., { fullscreen: true })`;
 * the host must call {@link ModelHubComponent.dispose} when the overlay closes.
 */
export class ModelHubComponent implements Component {
	#tui: TUI;
	#settings: Settings;
	#registry: ModelRegistry;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#callbacks: ModelHubCallbacks;

	#browser: ModelBrowser;
	#roles: RoleAssignments = {};
	#availableItems: ModelBrowserItem[] = [];
	#recentItems: ModelBrowserItem[] = [];
	#configError: string | undefined;

	#entries: SidebarEntry[] = [];
	// Sidebar sections from the last registry sync; #composeEntries assembles
	// #entries from these (reordered while searching).
	#fixedEntries: SidebarEntry[] = [];
	#unlockedProviderEntries: SidebarEntry[] = [];
	#lockedProviderEntries: SidebarEntry[] = [];
	/** Fuzzy match totals while searching: recent-scope hits and overall hits. */
	#recentSearchCount = 0;
	#searchTotal = 0;
	#activeEntryId = "all";
	#sidebarScroll = 0;
	/** Snap the sidebar viewport to the active entry on the next render; wheel panning leaves it free. */
	#sidebarFollowActive = true;
	#sidebarHover: number | null = null;
	/**
	 * Arrow-key ownership: `scope` (default) hops the sidebar; `list`
	 * navigates rows (browser models or role rows). Typing anywhere focuses
	 * the model list; Tab toggles; ←/→ switches between sidebar and list.
	 */
	#focus: "scope" | "list" = "scope";

	#rolesRows: RolesRow[] = [];
	#roleIndex = 0;
	#roleHover: number | null = null;
	/** First roles row drawn in the scroll window; follows the cursor and clamps to the list. */
	#roleScrollStart = 0;
	/** Roles rows actually drawn this frame; bounds mouse hit-testing to the visible window. */
	#rolesVisibleCount = 0;

	#assigning: AssignTarget | null = null;
	#strip: StripState | null = null;
	/** Per-provider fuzzy match counts while a query is active; null when not searching. */
	#searchCounts: Map<string, number> | null = null;

	// Provider discovery refresh (debounced per sidebar selection, with spinner).
	#refreshingProviders = new Set<string>();
	#scheduledProviderRefreshes = new Map<string, Timer>();
	#refreshSpinnerFrame = 0;
	#refreshSpinnerInterval?: Timer;
	// Frame geometry from the last render, for mouse hit-testing (the
	// fullscreen overlay paints from screen row 0, so mouse rows map 1:1).
	#contentRowStart = 1;
	#contentRowCount = 0;
	#sidebarWidthLast = SIDEBAR_MIN_WIDTH;
	#footerRow = 0;
	#chipRanges: ChipRange[] = [];
	#lockedLoginLine: number | null = null;
	#rolesRowStart = 1;
	#mouse = new OverlayMouseRouter();

	constructor(
		tui: TUI,
		settings: Settings,
		registry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		callbacks: ModelHubCallbacks,
		options: ModelHubOptions = {},
	) {
		this.#tui = tui;
		this.#settings = settings;
		this.#registry = registry;
		this.#scopedModels = scopedModels;
		this.#callbacks = callbacks;

		this.#browser = new ModelBrowser(settings, {
			emptyText: () => this.#emptyStateMessage(),
		});
		this.#browser.onActivate = item => this.#activateItem(item);
		this.#browser.onCancel = () => this.#callbacks.onCancel();
		this.#browser.onQueryChange = query => this.#onQueryChanged(query);

		// Hydrate synchronously from the current registry snapshot so the first
		// Enter after opening acts on cached models instead of being dropped
		// while the offline refresh promise is still pending.
		this.#syncFromRegistryState();

		const initialProvider = options.initialProviderId;
		if (initialProvider && this.#entries.some(entry => entry.providerId === initialProvider)) {
			this.#setActiveEntry(`provider:${initialProvider}`);
		} else {
			this.#setActiveEntry("all");
		}

		// Reconcile with cached discovery state in the background. A --models
		// scope is registry-independent, so the offline reload would only repeat
		// the synchronous hydration above.
		if (this.#scopedModels.length === 0) {
			this.#registry
				.refresh("online")
				.then(() => this.#syncFromRegistryState())
				.catch(error => {
					this.#configError = error instanceof Error ? error.message : String(error);
				})
				.finally(() => this.#tui.requestRender());
		}
	}

	/** Cancel pending provider refresh timers and the spinner. Host calls this on overlay close. */
	dispose(): void {
		for (const [, timer] of this.#scheduledProviderRefreshes) clearTimeout(timer);
		this.#scheduledProviderRefreshes.clear();
		this.#refreshingProviders.clear();
		if (this.#refreshSpinnerInterval) {
			clearInterval(this.#refreshSpinnerInterval);
			this.#refreshSpinnerInterval = undefined;
		}
	}

	invalidate(): void {}

	#canCustomizeModelSettings(): boolean {
		return (
			this.#callbacks.onSetModelSettingsField !== undefined &&
			this.#callbacks.onResetModelSettingsField !== undefined
		);
	}

	#effectiveModelSettingsLines(model: Model, role: string | undefined, editable: boolean): string[] {
		const tier = this.#settings.get("settings.tier");
		const effective = resolveEffectiveModelSettings({
			model,
			role,
			sources: this.#settings.getModelSettingsSourceLayers(model, role),
		});
		const lines = formatEffectiveModelSettingsLines(effective, tier);
		if (tier === "advanced" && editable && this.#canCustomizeModelSettings()) {
			lines.push("Ctrl+E Customize settings");
		}
		return lines;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Data pipeline
	// ═══════════════════════════════════════════════════════════════════════

	#visibleRoleIds(): string[] {
		return getKnownRoleIds(this.#settings).filter(role => !getRoleInfo(role, this.#settings).hidden);
	}

	/** Resolve every known role: configured values first, auto-selection for the rest. */
	#reloadRoles(autoCandidates: ReadonlyArray<Model>): void {
		const allModels = this.#scopedModels.length > 0 ? autoCandidates : this.#registry.getAll();
		this.#roles = resolveRoleAssignments(this.#settings, allModels, autoCandidates);
	}

	/** Rebuild items, roles, and the sidebar from the registry's in-memory state. */
	#syncFromRegistryState(): void {
		let allModels: ReadonlyArray<Model>;
		let availableModels: ReadonlyArray<Model>;
		if (this.#scopedModels.length > 0) {
			allModels = this.#scopedModels.map(scoped => scoped.model);
			availableModels = allModels;
			this.#configError = undefined;
		} else {
			const loadError = this.#registry.getError();
			this.#configError = loadError ? String(loadError) : undefined;
			allModels = this.#registry.getAll();
			try {
				availableModels = this.#registry.getAvailable();
			} catch (error) {
				this.#configError = error instanceof Error ? error.message : String(error);
				availableModels = [];
			}
		}

		this.#reloadRoles(availableModels);
		this.#buildRolesRows();

		const storage = this.#settings.getStorage();
		const mruOrder = storage?.getModelUsageOrder() ?? [];
		this.#availableItems = buildBrowserItems(availableModels);
		sortModelItems(this.#availableItems, { roles: this.#roles, mruOrder });
		this.#browser.setRoles(this.#roles);
		this.#browser.setMruOrder(mruOrder);
		this.#browser.setPerfStats(storage?.getModelPerf() ?? new Map());

		const bySelector = new Map(this.#availableItems.map(item => [item.selector, item]));
		this.#recentItems = [];
		for (const key of mruOrder) {
			const item = bySelector.get(key);
			if (item) this.#recentItems.push(item);
			if (this.#recentItems.length >= RECENT_LIMIT) break;
		}

		this.#buildSidebar(allModels, availableModels);
		this.#applyScope();
	}

	#buildSidebar(allModels: ReadonlyArray<Model>, availableModels: ReadonlyArray<Model>): void {
		const scoped = this.#scopedModels.length > 0;
		let disabledProviders: ReadonlySet<string>;
		try {
			disabledProviders = new Set(this.#settings.get("disabledProviders"));
		} catch {
			disabledProviders = new Set();
		}

		const availableCounts = new Map<string, number>();
		for (const model of availableModels) {
			availableCounts.set(model.provider, (availableCounts.get(model.provider) ?? 0) + 1);
		}
		const catalogCounts = new Map<string, number>();
		for (const model of allModels) {
			catalogCounts.set(model.provider, (catalogCounts.get(model.provider) ?? 0) + 1);
		}

		const unlocked = new Set<string>(availableCounts.keys());
		const locked = new Set<string>();
		if (!scoped) {
			const authStorage = this.#registry.authStorage;
			for (const provider of catalogCounts.keys()) {
				if (!unlocked.has(provider) && !disabledProviders.has(provider)) {
					locked.add(provider);
				}
			}
			for (const provider of this.#registry.getDiscoverableProviders()) {
				if (unlocked.has(provider) || disabledProviders.has(provider)) continue;
				// Discoverable without stored auth: catalog-backed providers stay
				// locked; keyless/custom endpoints (ollama, vllm, …) surface as
				// selectable so discovery can populate them.
				if (authStorage.hasAuth(provider) || !locked.has(provider)) {
					// #2761: implicit local endpoints (optional: true) stay hidden
					// until discovery actually reaches a server. "idle" means never
					// probed; "unavailable" means the endpoint is unreachable; both
					// would render a dead tab for a provider the user never
					// configured. models.yml discovery providers (optional: false)
					// and providers with stored auth keep their entry so
					// misconfigurations stay visible and diagnosable.
					if (!authStorage.hasAuth(provider)) {
						const discovery = this.#registry.getProviderDiscoveryState(provider);
						if (discovery?.optional && (discovery.status === "idle" || discovery.status === "unavailable")) {
							continue;
						}
					}
					locked.delete(provider);
					unlocked.add(provider);
				}
			}
		}

		const oauthIds = new Set(getOAuthProviders().map(provider => provider.id));
		const providerEntry = (providerId: string, isLocked: boolean): SidebarEntry => ({
			id: `provider:${providerId}`,
			kind: "provider",
			label: providerId,
			providerId,
			locked: isLocked,
			annotation: isLocked ? undefined : String(availableCounts.get(providerId) ?? 0),
			oauth: oauthIds.has(providerId),
			catalogCount: catalogCounts.get(providerId) ?? 0,
		});

		// The transparent /agents assignment view is the everyday surface.
		// Expert role/fallback editing remains available in Advanced without
		// presenting a second competing assignment view in Basic.
		const fixed: SidebarEntry[] = [];
		if (this.#settings.get("settings.tier") === "advanced") {
			const visibleRoles = this.#visibleRoleIds();
			let assignedCount = 0;
			for (const role of visibleRoles) {
				const assignment = this.#roles[role];
				if (assignment && !assignment.autoSelected) assignedCount++;
			}
			fixed.push({
				id: "roles",
				kind: "roles",
				label: "Role assignments",
				annotation: `${assignedCount}/${visibleRoles.length}`,
			});
		}
		fixed.push({ id: "all", kind: "all", label: "All models", annotation: String(availableModels.length) });

		this.#fixedEntries = fixed;
		this.#unlockedProviderEntries = [...unlocked]
			.sort((a, b) => a.localeCompare(b))
			.map(provider => providerEntry(provider, false));
		this.#lockedProviderEntries = [...locked]
			.sort((a, b) => a.localeCompare(b))
			.map(provider => providerEntry(provider, true));
		this.#composeEntries();
	}

	/**
	 * Assemble `#entries` from the stored sections. While a search is active,
	 * providers with matches float to the top of the provider section (each
	 * group stays alphabetical) so the hop order, mouse hit-testing, and the
	 * paint all agree.
	 */
	#composeEntries(): void {
		const counts = this.#searchCounts;
		let providers = this.#unlockedProviderEntries;
		if (counts) {
			providers = [...providers].sort((a, b) => {
				const aMatched = (counts.get(a.providerId ?? "") ?? 0) > 0;
				const bMatched = (counts.get(b.providerId ?? "") ?? 0) > 0;
				if (aMatched !== bMatched) return aMatched ? -1 : 1;
				return a.label.localeCompare(b.label);
			});
		}

		const entries: SidebarEntry[] = [...this.#fixedEntries];
		if (providers.length > 0) {
			entries.push({ id: "sep:providers", kind: "separator", label: "" }, ...providers);
		}
		if (this.#lockedProviderEntries.length > 0) {
			entries.push({ id: "sep:locked", kind: "separator", label: "" }, ...this.#lockedProviderEntries);
		}

		this.#entries = entries;
		if (!entries.some(entry => entry.id === this.#activeEntryId)) {
			this.#activeEntryId = "all";
			this.#sidebarFollowActive = true;
		}
	}

	#activeEntry(): SidebarEntry {
		return this.#entries.find(entry => entry.id === this.#activeEntryId) ?? this.#entries[0];
	}

	#setActiveEntry(id: string): void {
		if (!this.#entries.some(entry => entry.id === id)) return;
		this.#activeEntryId = id;
		this.#sidebarFollowActive = true;
		this.#applyScope();
		const entry = this.#activeEntry();
		// Hops must never steal arrow focus: landing on a scope keeps provider
		// navigation active. Diving into the roles rows is explicit (Enter, →,
		// or a click on the Roles entry).
		this.#focus = "scope";
		if (entry.kind === "provider" && !entry.locked) {
			this.#scheduleProviderRefresh(entry.providerId ?? "");
		}
		this.#cancelScheduledRefreshesExcept(entry.kind === "provider" ? entry.providerId : undefined);
	}

	/** Push the active scope's items into the browser. */
	#applyScope(): void {
		const entry = this.#activeEntry();
		switch (entry.kind) {
			case "recent":
				this.#browser.setShowProvider(true);
				this.#browser.setItems([...this.#recentItems]);
				break;
			case "provider": {
				if (entry.locked) {
					// Assign-mode renders the browser regardless of scope; a locked
					// provider contributes nothing selectable.
					this.#browser.setItems([]);
					break;
				}
				const providerId = entry.providerId;
				this.#browser.setShowProvider(false);
				this.#browser.setItems(this.#availableItems.filter(item => item.provider === providerId));
				break;
			}
			case "roles":
				this.#roleIndex = Math.min(this.#roleIndex, Math.max(0, this.#rolesRowCount - 1));
				break;
			default:
				this.#browser.setShowProvider(true);
				this.#browser.setItems([...this.#availableItems]);
				break;
		}
	}

	/**
	 * The configured `retry.fallbackChains` record with malformed keys/entries
	 * dropped: non-array chains and non-string selectors never reach the rows
	 * or chain editors, so an edit through the hub replaces them wholesale.
	 */
	#fallbackChains(): Record<string, string[]> {
		try {
			const chains = this.#settings.get("retry.fallbackChains");
			if (!chains || typeof chains !== "object" || Array.isArray(chains)) return {};
			const sanitized: Record<string, string[]> = {};
			for (const key in chains) {
				const chain = (chains as Record<string, unknown>)[key];
				if (!Array.isArray(chain)) continue;
				sanitized[key] = chain.filter((entry): entry is string => typeof entry === "string");
			}
			return sanitized;
		} catch {
			return {};
		}
	}

	/**
	 * Rebuild the Roles view rows: each visible role followed by its
	 * fallback-chain entries, then model-oriented chains (`provider/model-id`
	 * and `provider/*` keys) as headed groups.
	 */
	#buildRolesRows(): void {
		const rows: RolesRow[] = [];
		const chains = this.#fallbackChains();
		for (const role of this.#visibleRoleIds()) {
			rows.push({ kind: "role", role });
			const chain = chains[role] ?? [];
			for (let i = 0; i < chain.length; i++) {
				rows.push({ kind: "fallback", role, chainIndex: i, selector: chain[i] });
			}
		}
		rows.push({ kind: "newRole" });
		rows.push({ kind: "separator" });
		const modelKeys = Object.keys(chains)
			.filter(key => key.includes("/"))
			.sort();
		for (const key of modelKeys) {
			const chain = chains[key] ?? [];
			rows.push({ kind: "chainKey", role: key });
			for (let i = 0; i < chain.length; i++) {
				rows.push({ kind: "fallback", role: key, chainIndex: i, selector: chain[i] });
			}
		}
		rows.push({ kind: "newFallback" });
		this.#rolesRows = rows;
	}

	/** Refresh roles + dependent state after a settings mutation (assign/unassign). */
	#refreshAfterMutation(): void {
		this.#syncFromRegistryState();
		this.#tui.requestRender();
	}

	/** Re-sync after an asynchronous callback finishes mutating settings. */
	refreshAfterExternalMutation(): void {
		this.#refreshAfterMutation();
	}

	/**
	 * Recompute per-provider match counts for the active query. Providers
	 * without matches gray out and the scope hop skips them; a provider scope
	 * that just lost its last match falls back to All models so the results
	 * never silently vanish.
	 */
	#onQueryChanged(query: string): void {
		if (!query.trim()) {
			this.#searchCounts = null;
			this.#composeEntries();
			return;
		}
		const matches = fuzzyFilter(this.#availableItems, query, ({ provider, id }) => `${provider}/${id}`);
		const counts = new Map<string, number>();
		for (const item of matches) {
			counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
		}
		const recentSelectors = new Set(this.#recentItems.map(item => item.selector));
		this.#recentSearchCount = matches.reduce(
			(total, item) => total + (recentSelectors.has(item.selector) ? 1 : 0),
			0,
		);
		this.#searchTotal = matches.length;
		this.#searchCounts = counts;
		this.#composeEntries();
		const entry = this.#activeEntry();
		if (
			this.#assigning === null &&
			entry.kind === "provider" &&
			(entry.locked || (counts.get(entry.providerId ?? "") ?? 0) === 0)
		) {
			this.#setActiveEntry("all");
		}
	}

	/**
	 * Entries the scope hop skips: separators always; while searching, also
	 * the Roles view (not a model scope), an empty Recent, locked providers,
	 * and providers without matches.
	 */
	#isHopSkipped(entry: SidebarEntry): boolean {
		if (entry.kind === "separator") return true;
		if (!this.#searchCounts) return false;
		if (entry.kind === "roles") return true;
		if (entry.kind === "recent") return this.#recentSearchCount === 0;
		if (entry.kind === "provider") {
			if (entry.locked) return true;
			return (this.#searchCounts.get(entry.providerId ?? "") ?? 0) === 0;
		}
		return false;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Provider discovery refresh
	// ═══════════════════════════════════════════════════════════════════════

	#startRefreshSpinner(): void {
		if (this.#refreshSpinnerInterval) return;
		this.#refreshSpinnerInterval = setInterval(() => {
			const frameCount = theme.spinnerFrames.length;
			if (frameCount > 0) {
				this.#refreshSpinnerFrame = (this.#refreshSpinnerFrame + 1) % frameCount;
			}
			this.#tui.requestRender();
		}, 80);
	}

	#stopRefreshSpinnerIfIdle(): void {
		if (this.#refreshingProviders.size > 0) return;
		if (this.#refreshSpinnerInterval) {
			clearInterval(this.#refreshSpinnerInterval);
			this.#refreshSpinnerInterval = undefined;
		}
		this.#refreshSpinnerFrame = 0;
	}

	#setProviderRefreshing(providerId: string, refreshing: boolean): void {
		if (refreshing) {
			this.#refreshingProviders.add(providerId);
			this.#startRefreshSpinner();
		} else {
			this.#refreshingProviders.delete(providerId);
			this.#stopRefreshSpinnerIfIdle();
		}
	}

	#cancelScheduledRefreshesExcept(keepProviderId?: string): void {
		for (const [providerId, timer] of this.#scheduledProviderRefreshes) {
			if (providerId === keepProviderId) continue;
			clearTimeout(timer);
			this.#scheduledProviderRefreshes.delete(providerId);
			this.#setProviderRefreshing(providerId, false);
		}
	}

	#scheduleProviderRefresh(providerId: string, options?: { force?: boolean }): void {
		if (this.#scopedModels.length > 0 || !providerId) return;
		if (this.#scheduledProviderRefreshes.has(providerId) || this.#refreshingProviders.has(providerId)) return;
		// Hovering a provider must not re-fetch on every visit: auto-refresh runs
		// at most once per provider for the process lifetime. F5 forces a re-fetch.
		if (!options?.force && autoRefreshedProviders.has(providerId)) return;
		this.#setProviderRefreshing(providerId, true);
		const timer = setTimeout(() => {
			// Consume the once-guard only when the fetch actually starts: hopping
			// through a provider cancels the debounce and must not burn its slot.
			autoRefreshedProviders.add(providerId);
			this.#scheduledProviderRefreshes.delete(providerId);
			void this.#refreshProviderInBackground(providerId);
		}, PROVIDER_REFRESH_DEBOUNCE_MS);
		this.#scheduledProviderRefreshes.set(providerId, timer);
	}

	async #refreshProviderInBackground(providerId: string): Promise<void> {
		try {
			await this.#registry.refreshProvider(providerId, "online");
			// The provider refresh already updated the registry snapshot;
			// re-reading it here stays purely in-memory.
			this.#syncFromRegistryState();
		} catch (error) {
			this.#configError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#setProviderRefreshing(providerId, false);
			this.#tui.requestRender();
		}
	}

	#formatDiscoveryAge(fetchedAt: number | undefined): string | undefined {
		if (!fetchedAt) return undefined;
		const ageMs = Math.max(0, Date.now() - fetchedAt);
		if (ageMs < 60_000) return "less than a minute ago";
		return `${Math.round(ageMs / 60_000)}m ago`;
	}

	#emptyStateMessage(): string | undefined {
		if (this.#configError) return `  ${this.#configError}`;
		const entry = this.#activeEntry();
		if (entry.kind === "recent") return "  No recently used models yet";
		if (entry.kind !== "provider" || entry.locked) return undefined;
		if (this.#browser.query.trim()) {
			return `  No matching models in ${entry.label}. Switch to All models to search every provider.`;
		}
		const providerId = entry.providerId ?? "";
		const state = this.#registry.getProviderDiscoveryState(providerId);
		if (!state) return undefined;
		const age = this.#formatDiscoveryAge(state.fetchedAt);
		switch (state.status) {
			case "cached":
				return age
					? `  Using cached model list from ${age}. Live refresh is still pending.`
					: "  Using cached model list. Live refresh is still pending.";
			case "unavailable": {
				const httpMatch = state.error?.match(/^HTTP (\d+) from (.+)$/);
				if (httpMatch?.[1] === "404") {
					return `  Discovery endpoint ${httpMatch[2]} returned 404. Point baseUrl at the host that serves /models (usually .../v1).`;
				}
				if (state.error) return `  Discovery failed: ${state.error}`;
				return age ? `  Provider unavailable. Using cached model list from ${age}.` : "  Provider unavailable.";
			}
			case "unauthenticated":
				return "  Provider requires authentication before models can be discovered.";
			case "idle":
				return "  Provider has not been refreshed yet.";
			case "empty":
				return "  Discovery succeeded but returned 0 models. Check that /models returns { data: [{ id }] }.";
			case "ok":
				return undefined;
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Assignment flow
	// ═══════════════════════════════════════════════════════════════════════

	#activateItem(item: ModelBrowserItem): void {
		if (this.#assigning) {
			const target = this.#assigning;
			this.#assigning = null;
			if (target.kind === "role") {
				this.#assignRole(item, target.role, true);
			} else if (target.kind === "fallbackKey") {
				this.#openFallbackKeyStrip(item);
			} else {
				this.#commitFallback(item, target);
			}
			return;
		}
		this.#openRoleStrip(item);
	}

	#roleForScope(role: string, scope: ModelRoleSelectionScope): ResolvedModelRoleValue {
		const roleValue =
			scope === "project" ? this.#settings.getProjectModelRole(role) : this.#settings.getGlobalModelRole(role);
		const allModels =
			this.#scopedModels.length > 0 ? this.#scopedModels.map(scoped => scoped.model) : this.#registry.getAll();
		const roleLookup: ModelRoleLookup = {
			getModelRole: scopedRole =>
				scope === "project"
					? (this.#settings.getProjectModelRole(scopedRole) ?? this.#settings.getGlobalModelRole(scopedRole))
					: this.#settings.getGlobalModelRole(scopedRole),
		};
		return resolveModelRoleValue(roleValue, allModels, { settings: this.#settings, roleLookup });
	}

	#thinkingLevelForScope(role: string, scope: ModelRoleSelectionScope): ConfiguredThinkingLevel {
		const resolved = this.#roleForScope(role, scope);
		return resolved.explicitThinkingLevel ? (resolved.thinkingLevel ?? ThinkingLevel.Inherit) : ThinkingLevel.Inherit;
	}

	/** Persist `role → item`, preserving a still-supported thinking level, then open the thinking strip. */
	#assignRole(item: ModelBrowserItem, role: string, returnToRoles: boolean, scope?: ModelRoleSelectionScope): void {
		if (this.#settings.get("modelRoleStorage") === "project" && scope === undefined) {
			this.#openScopeStrip(item, role, returnToRoles);
			return;
		}

		const current = this.#roles[role];
		let level: ConfiguredThinkingLevel = ThinkingLevel.Inherit;
		if (this.#settings.get("modelRoleStorage") === "project" && scope !== undefined) {
			level = this.#thinkingLevelForScope(role, scope);
		} else if (current && !current.autoSelected) {
			level = current.thinkingLevel;
		}
		const supported = this.#thinkingOptionsFor(item.model);
		if (!supported.includes(level)) level = ThinkingLevel.Inherit;
		this.#callbacks.onAssign(item.model, role, level, item.selector, scope);
		this.#refreshAfterMutation();
		this.#openThinkingStrip(item, role, returnToRoles, scope);
	}

	#unassignRole(role: string): void {
		const assignment = this.#roles[role];
		if (!assignment || assignment.autoSelected) return;
		if (this.#settings.get("modelRoleStorage") === "project") {
			const source = this.#settings.getModelRoleSource(role);
			this.#callbacks.onUnassign(role, source === "default" ? undefined : source);
		} else {
			this.#callbacks.onUnassign(role);
		}
		this.#refreshAfterMutation();
	}

	#thinkingOptionsFor(model: Model): ConfiguredThinkingLevel[] {
		return [ThinkingLevel.Inherit, ThinkingLevel.Off, AUTO_THINKING, ...getSupportedEfforts(model)];
	}

	#openRoleStrip(item: ModelBrowserItem): void {
		const chips: RoleStripChip[] = [];
		const scopedStorage = this.#settings.get("modelRoleStorage") === "project";
		const scopes: readonly ModelRoleSelectionScope[] = scopedStorage ? ["project", "global"] : ["global"];
		for (const role of this.#visibleRoleIds()) {
			const info = getRoleInfo(role, this.#settings);
			const assignment = this.#roles[role];
			for (const scope of scopes) {
				const scopedModel = scopedStorage
					? this.#roleForScope(role, scope).model
					: assignment && !assignment.autoSelected
						? assignment.model
						: undefined;
				const assignedHere =
					!!scopedModel && scopedModel.provider === item.model.provider && scopedModel.id === item.model.id;
				const roleLabel = (info.tag ?? info.name ?? role).toLowerCase();
				const label = scopedStorage ? `${scope} ${roleLabel}` : roleLabel;
				const styled = assignedHere
					? // Separator required: under the `nerd` preset this glyph is a
						// two-cell-wide PUA icon that `visibleWidth` counts as one, so
						// without it the icon overhangs and eats `label`'s first char.
						theme.fg(info.color ?? "muted", `${theme.status.enabled} ${label}`) +
						theme.fg("dim", ` ${theme.status.success}`)
					: theme.fg(info.color ?? "muted", label);
				if (assignedHere) {
					chips.push({ label, styled, role, scope, action: "unassign" });
				} else {
					chips.push({ label, styled, role, scope, action: "assign" });
				}
			}
		}
		chips.push({
			label: `fallbacks:${item.model.id}`,
			styled: theme.fg("muted", `fallbacks:${item.model.id}`),
			action: "fallbackModel",
		});
		chips.push({
			label: `fallbacks:${item.model.provider}/*`,
			styled: theme.fg("muted", `fallbacks:${item.model.provider}/*`),
			action: "fallbackProvider",
		});
		chips.push({ label: "fallback", styled: theme.fg("muted", "retry-fallback"), action: "fallback" });
		this.#strip = { kind: "role", item, chips, index: 0, returnToRoles: false };
	}

	#openScopeStrip(item: ModelBrowserItem, role: string, returnToRoles: boolean): void {
		const chips: ScopeStripChip[] = [
			{ label: "project", styled: theme.fg("accent", "project"), action: "scope", scope: "project" },
			{ label: "global", styled: theme.fg("muted", "global"), action: "scope", scope: "global" },
		];
		this.#strip = { kind: "scope", item, role, chips, index: 0, returnToRoles };
	}

	#openThinkingStrip(
		item: ModelBrowserItem,
		role: string,
		returnToRoles: boolean,
		scope?: ModelRoleSelectionScope,
	): void {
		const options = this.#thinkingOptionsFor(item.model);
		const current =
			this.#settings.get("modelRoleStorage") === "project" && scope !== undefined
				? this.#thinkingLevelForScope(role, scope)
				: (this.#roles[role]?.thinkingLevel ?? ThinkingLevel.Inherit);
		const chips: ThinkingStripChip[] = options.map(level => {
			const label = getConfiguredThinkingLevelMetadata(level).label;
			const glyph = thinkingLevelGlyph(level);
			return {
				label,
				styled: glyph ? `${theme.fg("accent", glyph)} ${label}` : label,
				action: "thinking",
				thinkingLevel: level,
			};
		});
		const preselect = options.indexOf(current);
		this.#strip = {
			kind: "thinking",
			item,
			role,
			scope,
			chips,
			index: preselect >= 0 ? preselect : 0,
			returnToRoles,
		};
	}

	#openModelSettingsTargetStrip(item: ModelBrowserItem, role: string | undefined, returnToRoles: boolean): void {
		if (!this.#canCustomizeModelSettings()) return;
		const modelTarget: ModelSettingsProfileTarget = {
			kind: "model",
			model: `${item.model.provider}/${item.model.id}`,
		};
		if (!role) {
			this.#openModelSettingsScopeStrip(item, modelTarget, returnToRoles);
			return;
		}
		const roleTarget: ModelSettingsProfileTarget = { kind: "role", role };
		const roleInfo = getRoleInfo(role, this.#settings);
		const roleLabel = roleInfo.tag ?? roleInfo.name ?? role;
		const chips: SettingsTargetStripChip[] = [
			{
				label: `current role ${role}`,
				styled: theme.fg(roleInfo.color ?? "accent", `current role ${roleLabel}`),
				action: "settingsTarget",
				settingsTarget: roleTarget,
			},
			{
				label: `exact model ${modelTarget.model}`,
				styled: theme.fg("muted", `exact model ${modelTarget.model}`),
				action: "settingsTarget",
				settingsTarget: modelTarget,
			},
		];
		this.#strip = { kind: "settingsTarget", item, role, chips, index: 0, returnToRoles };
	}

	#openModelSettingsScopeStrip(
		item: ModelBrowserItem,
		target: ModelSettingsProfileTarget,
		returnToRoles: boolean,
	): void {
		const scopes: readonly ModelSettingsStorageScope[] =
			this.#settings.get("modelRoleStorage") === "project" ? ["project", "global"] : ["global"];
		const chips: SettingsScopeStripChip[] = scopes.map(scope => ({
			label: scope,
			styled: theme.fg(scope === "project" ? "accent" : "muted", scope),
			action: "settingsScope",
			scope,
		}));
		this.#strip = { kind: "settingsScope", item, target, chips, index: 0, returnToRoles };
	}

	#openModelSettingsFieldStrip(
		item: ModelBrowserItem,
		target: ModelSettingsProfileTarget,
		scope: ModelSettingsStorageScope,
		returnToRoles: boolean,
	): void {
		const fields: readonly ModelSettingsProfileField[] =
			target.kind === "role" ? ["cacheRetention"] : ["thinking", "cacheRetention"];
		const chips: SettingsFieldStripChip[] = fields.map(field => {
			const label = field === "thinking" ? "Thinking" : "Prompt cache";
			return {
				label,
				styled: theme.fg(field === "thinking" ? "accent" : "muted", label),
				action: "settingsField",
				settingsField: field,
			};
		});
		this.#strip = { kind: "settingsField", item, target, scope, chips, index: 0, returnToRoles };
	}

	#openModelSettingsValueStrip(
		item: ModelBrowserItem,
		target: ModelSettingsProfileTarget,
		scope: ModelSettingsStorageScope,
		field: ModelSettingsProfileField,
		returnToRoles: boolean,
	): void {
		const chips: SettingsValueStripChip[] = [
			{
				label: "reset to inherited",
				styled: theme.fg("muted", "Reset to inherited"),
				action: "settingsReset",
			},
		];
		if (field === "thinking") {
			for (const level of [ThinkingLevel.Off, AUTO_THINKING, ...getSupportedEfforts(item.model)]) {
				const label = getConfiguredThinkingLevelMetadata(level).label;
				const glyph = thinkingLevelGlyph(level);
				chips.push({
					label,
					styled: glyph ? `${theme.fg("accent", glyph)} ${label}` : label,
					action: "settingsValue",
					settingsValue: level,
				});
			}
		} else {
			for (const value of ["auto", "short", "long", "none"] as const) {
				chips.push({
					label: CACHE_RETENTION_LABELS[value],
					styled: theme.fg(value === "auto" ? "accent" : "muted", CACHE_RETENTION_LABELS[value]),
					action: "settingsValue",
					settingsValue: value,
				});
			}
		}
		this.#strip = {
			kind: "settingsValue",
			item,
			target,
			scope,
			field,
			chips,
			index: 0,
			returnToRoles,
		};
	}

	#closeStrip(): void {
		const strip = this.#strip;
		this.#strip = null;
		this.#chipRanges = [];
		if (strip && strip.kind !== "roleName" && strip.returnToRoles) {
			this.#setActiveEntry("roles");
			this.#focus = "list";
		}
	}

	#activateStripChip(): void {
		const strip = this.#strip;
		if (!strip) return;
		switch (strip.kind) {
			case "role":
				this.#activateRoleStripChip(strip);
				return;
			case "scope":
				this.#activateScopeStripChip(strip);
				return;
			case "thinking":
				this.#activateThinkingStripChip(strip);
				return;
			case "settingsTarget":
				this.#activateSettingsTargetStripChip(strip);
				return;
			case "settingsScope":
				this.#activateSettingsScopeStripChip(strip);
				return;
			case "settingsField":
				this.#activateSettingsFieldStripChip(strip);
				return;
			case "settingsValue":
				this.#activateSettingsValueStripChip(strip);
				return;
			case "roleName":
				return;
		}
		const unhandled: never = strip;
		return unhandled;
	}

	#activateRoleStripChip(strip: RoleStripState): void {
		const chip = strip.chips[strip.index];
		if (!chip) return;
		switch (chip.action) {
			case "assign":
				this.#strip = null;
				this.#assignRole(strip.item, chip.role, false, chip.scope);
				return;
			case "unassign":
				if (this.#settings.get("modelRoleStorage") === "project") {
					this.#callbacks.onUnassign(chip.role, chip.scope);
				} else {
					this.#callbacks.onUnassign(chip.role);
				}
				this.#refreshAfterMutation();
				this.#closeStrip();
				return;
			case "fallback":
				this.#appendFallback(strip.item, "default");
				this.#closeStrip();
				return;
			case "fallbackModel":
				this.#closeStrip();
				this.#startAssignFallback(strip.item.selector, null);
				return;
			case "fallbackProvider":
				this.#closeStrip();
				this.#startAssignFallback(`${strip.item.model.provider}/*`, null);
				return;
		}
		const unhandled: never = chip;
		return unhandled;
	}

	#activateScopeStripChip(strip: ScopeStripState): void {
		const chip = strip.chips[strip.index];
		if (!chip) return;
		this.#strip = null;
		this.#assignRole(strip.item, strip.role, strip.returnToRoles, chip.scope);
	}

	#activateThinkingStripChip(strip: ThinkingStripState): void {
		const chip = strip.chips[strip.index];
		if (!chip) return;
		this.#callbacks.onAssign(strip.item.model, strip.role, chip.thinkingLevel, strip.item.selector, strip.scope);
		this.#refreshAfterMutation();
		this.#closeStrip();
	}

	#activateSettingsTargetStripChip(strip: SettingsTargetStripState): void {
		const chip = strip.chips[strip.index];
		if (!chip) return;
		this.#openModelSettingsScopeStrip(strip.item, chip.settingsTarget, strip.returnToRoles);
	}

	#activateSettingsScopeStripChip(strip: SettingsScopeStripState): void {
		const chip = strip.chips[strip.index];
		if (!chip) return;
		this.#openModelSettingsFieldStrip(strip.item, strip.target, chip.scope, strip.returnToRoles);
	}

	#activateSettingsFieldStripChip(strip: SettingsFieldStripState): void {
		const chip = strip.chips[strip.index];
		if (!chip) return;
		this.#openModelSettingsValueStrip(strip.item, strip.target, strip.scope, chip.settingsField, strip.returnToRoles);
	}

	#activateSettingsValueStripChip(strip: SettingsValueStripState): void {
		const chip = strip.chips[strip.index];
		if (!chip) return;
		switch (chip.action) {
			case "settingsReset": {
				const onReset = this.#callbacks.onResetModelSettingsField;
				if (onReset) {
					onReset(strip.scope, strip.target, strip.field);
					this.#refreshAfterMutation();
				}
				this.#closeStrip();
				return;
			}
			case "settingsValue": {
				const onSet = this.#callbacks.onSetModelSettingsField;
				if (onSet) {
					onSet(strip.scope, strip.target, strip.field, chip.settingsValue);
					this.#refreshAfterMutation();
				}
				this.#closeStrip();
				return;
			}
		}
		const unhandled: never = chip;
		return unhandled;
	}

	/** Switch the body into assign mode for `role`: full catalog, cleared query, current model preselected. */
	#startAssign(role: string): void {
		this.#assigning = { kind: "role", role };
		this.#focus = "scope";
		this.#browser.setShowProvider(true);
		this.#browser.setItems([...this.#availableItems]);
		this.#browser.setQuery("");
		const current = this.#roles[role];
		if (current) {
			this.#browser.selectSelector(`${current.model.provider}/${current.model.id}`);
		}
	}

	/** Browse the catalog to fill a fallback-chain slot: `index` replaces an entry, `null` appends. */
	#startAssignFallback(role: string, index: number | null): void {
		this.#assigning = { kind: "fallback", role, index };
		this.#focus = "scope";
		this.#browser.setShowProvider(true);
		this.#browser.setItems([...this.#availableItems]);
		this.#browser.setQuery("");
		if (index !== null) {
			const selector = this.#fallbackChains()[role]?.[index];
			if (selector) this.#browser.selectSelector(selector);
		}
	}

	/** Browse the catalog for the primary model a brand-new fallback chain protects. */
	#startAssignFallbackKey(): void {
		this.#assigning = { kind: "fallbackKey" };
		this.#focus = "scope";
		this.#browser.setShowProvider(true);
		this.#browser.setItems([...this.#availableItems]);
		this.#browser.setQuery("");
	}

	/** Second step of "+ New fallback…": key the chain by the picked model or its whole provider. */
	#openFallbackKeyStrip(item: ModelBrowserItem): void {
		const chips: RoleStripChip[] = [
			{
				label: `for ${item.selector}`,
				styled: theme.fg("muted", `for ${item.selector}`),
				action: "fallbackModel",
			},
			{
				label: `for ${item.model.provider}/*`,
				styled: theme.fg("muted", `for ${item.model.provider}/*`),
				action: "fallbackProvider",
			},
		];
		this.#strip = { kind: "role", item, chips, index: 0, returnToRoles: false };
	}

	/** Write the picked model into the target chain slot, dedupe, and land back on its Roles row. */
	#commitFallback(item: ModelBrowserItem, target: { role: string; index: number | null }): void {
		const chain = [...(this.#fallbackChains()[target.role] ?? [])];
		const selector = item.selector;
		if (target.index !== null && target.index < chain.length) {
			chain[target.index] = selector;
			for (let i = chain.length - 1; i >= 0; i--) {
				if (i !== target.index && chain[i] === selector) chain.splice(i, 1);
			}
		} else if (!chain.includes(selector)) {
			chain.push(selector);
		}
		this.#setFallbackChain(target.role, chain);
		this.#browser.setQuery("");
		this.#setActiveEntry("roles");
		this.#focus = "list";
		const rowIndex = this.#rolesRows.findIndex(
			row => row.kind === "fallback" && row.role === target.role && row.selector === selector,
		);
		if (rowIndex >= 0) this.#roleIndex = rowIndex;
	}

	/** Persist `role`'s chain through the host callback and rebuild dependent state. */
	#setFallbackChain(role: string, chain: string[]): void {
		this.#callbacks.onFallbackChainChange?.(role, chain);
		this.#refreshAfterMutation();
	}

	/** Append `item` to `role`'s fallback chain (no-op when already present). */
	#appendFallback(item: ModelBrowserItem, role: string): void {
		const chain = [...(this.#fallbackChains()[role] ?? [])];
		if (chain.includes(item.selector)) return;
		chain.push(item.selector);
		this.#setFallbackChain(role, chain);
	}

	/** Remove one chain entry; the cursor stays on the nearest surviving row. */
	#removeFallback(row: { role: string; chainIndex: number }): void {
		const chain = [...(this.#fallbackChains()[row.role] ?? [])];
		if (row.chainIndex >= chain.length) return;
		chain.splice(row.chainIndex, 1);
		this.#setFallbackChain(row.role, chain);
		this.#roleIndex = Math.min(this.#roleIndex, Math.max(0, this.#rolesRows.length - 1));
	}

	/** Move a chain entry one slot earlier/later; the cursor follows the moved entry. */
	#moveFallback(row: { role: string; chainIndex: number }, delta: -1 | 1): void {
		const chain = [...(this.#fallbackChains()[row.role] ?? [])];
		const target = row.chainIndex + delta;
		if (row.chainIndex >= chain.length || target < 0 || target >= chain.length) return;
		[chain[row.chainIndex], chain[target]] = [chain[target], chain[row.chainIndex]];
		this.#setFallbackChain(row.role, chain);
		this.#roleIndex += delta;
	}

	#cancelAssign(): void {
		this.#assigning = null;
		this.#browser.setQuery("");
		this.#setActiveEntry("roles");
		this.#focus = "list";
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Quick-switch cycle (ctrl+p) editing
	// ═══════════════════════════════════════════════════════════════════════

	#cycleOrder(): string[] {
		try {
			return [...this.#settings.get("cycleOrder")];
		} catch {
			return [];
		}
	}

	/** Toggle `role`'s membership in the quick-switch cycle (appended at the end). */
	#toggleCycleMembership(role: string): void {
		const order = this.#cycleOrder();
		const index = order.indexOf(role);
		if (index >= 0) {
			order.splice(index, 1);
		} else {
			order.push(role);
		}
		this.#callbacks.onCycleOrderChange?.(order);
		this.#refreshAfterMutation();
	}

	/** Move `role` one slot earlier/later within the cycle order. */
	#moveCycleMembership(role: string, delta: -1 | 1): void {
		const order = this.#cycleOrder();
		const index = order.indexOf(role);
		const target = index + delta;
		if (index < 0 || target < 0 || target >= order.length) return;
		[order[index], order[target]] = [order[target], order[index]];
		this.#callbacks.onCycleOrderChange?.(order);
		this.#refreshAfterMutation();
	}

	/** Open the footer name input that creates a new custom role. */
	#openRoleNameStrip(): void {
		this.#strip = { kind: "roleName", input: new Input() };
	}

	/** Validate and commit the new-role name: jump straight into assigning it. */
	#submitRoleName(): void {
		const strip = this.#strip;
		if (strip?.kind !== "roleName") return;
		const name = strip.input.getValue().trim();
		if (!/^[a-zA-Z][\w-]*$/.test(name)) return;
		if (this.#visibleRoleIds().includes(name)) return;
		this.#strip = null;
		this.#chipRanges = [];
		this.#startAssign(name);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Input
	// ═══════════════════════════════════════════════════════════════════════

	handleInput(data: string): void {
		const entry = this.#activeEntry();
		const sidebarColStart = 2;
		const bodyColStart = this.#sidebarWidthLast + 5;
		const routed = this.#mouse.route(data, () => ({
			regions: [
				{
					id: "models-footer",
					rowStart: this.#footerRow,
					rowCount: 1,
					onMouse: (event: OverlayMouseEvent) => {
						if (event.clickCount === 0 || !this.#strip || this.#strip.kind === "roleName") return;
						for (const range of this.#chipRanges) {
							if (event.col >= range.start && event.col < range.end) {
								this.#strip.index = range.index;
								this.#activateStripChip();
								return;
							}
						}
					},
				},
				{
					id: "models-sidebar",
					rowStart: this.#contentRowStart,
					rowCount: this.#contentRowCount,
					colStart: sidebarColStart,
					colCount: this.#sidebarWidthLast,
					onMouse: (event: OverlayMouseEvent) => {
						const index = this.#sidebarEntryIndexAt(event.localRow);
						if (event.wheel !== null) {
							const maxScroll = Math.max(0, this.#entries.length - this.#contentRowCount);
							this.#sidebarScroll = Math.max(0, Math.min(this.#sidebarScroll + event.wheel, maxScroll));
							this.#sidebarHover = this.#sidebarEntryIndexAt(event.localRow);
							return;
						}
						if (event.motion) {
							this.#sidebarHover = index;
							return;
						}
						if (event.clickCount > 0) {
							const clicked = index !== null ? this.#entries[index] : undefined;
							if (!clicked || clicked.kind === "separator") return;
							if (clicked.kind === "roles") this.#assigning = null;
							this.#setActiveEntry(clicked.id);
							if (clicked.kind === "roles") this.#focus = "list";
							if (event.clickCount === 2 && clicked.kind === "provider" && clicked.locked) {
								this.#requestLogin(clicked);
							}
						}
					},
				},
				{
					id: "models-body",
					rowStart: this.#contentRowStart,
					rowCount: this.#contentRowCount,
					colStart: bodyColStart,
					onMouse: (event: OverlayMouseEvent) => {
						const bodyLine = event.localRow - 1;
						if (event.wheel !== null) {
							if (entry.kind === "roles" && this.#assigning === null) {
								this.#roleIndex = this.#stepRoleIndex(this.#roleIndex, event.wheel > 0 ? 1 : -1, {
									wrap: false,
								});
							} else if (this.#isBrowserView(entry)) {
								this.#browser.routeMouse(event, bodyLine);
							}
							return;
						}
						if (event.motion) {
							if (entry.kind === "roles" && this.#assigning === null) {
								const roleLine = bodyLine - this.#rolesRowStart;
								this.#roleHover =
									roleLine >= 0 && roleLine < this.#rolesVisibleCount
										? roleLine + this.#roleScrollStart
										: null;
							} else {
								this.#roleHover = null;
								if (this.#isBrowserView(entry)) this.#browser.routeMouse(event, bodyLine);
								else this.#browser.clearHover();
							}
							return;
						}
						if (event.clickCount === 0) return;
						if (entry.kind === "roles" && this.#assigning === null) {
							this.#focus = "list";
							const listLine = bodyLine - this.#rolesRowStart;
							if (listLine < 0 || listLine >= this.#rolesVisibleCount) return;
							const roleLine = listLine + this.#roleScrollStart;
							const rowDef = this.#rolesRows[roleLine];
							if (!rowDef || rowDef.kind === "separator") return;
							this.#roleIndex = roleLine;
							if (event.clickCount === 2) this.#activateRolesRow(rowDef);
						} else if (entry.kind === "provider" && entry.locked && this.#assigning === null) {
							if (this.#lockedLoginLine !== null && bodyLine === this.#lockedLoginLine) {
								this.#requestLogin(entry);
							}
						} else if (this.#isBrowserView(entry)) {
							this.#browser.routeMouse(event, bodyLine);
						}
					},
				},
			],
			fallback: (event: OverlayMouseEvent) => {
				if (event.motion) {
					this.#sidebarHover = null;
					this.#roleHover = null;
					this.#browser.clearHover();
				}
			},
		}));
		if (routed) return;

		if (this.#strip) {
			this.#handleStripInput(data);
			return;
		}

		if (matchesSelectCancel(data)) {
			if (this.#assigning !== null) {
				this.#cancelAssign();
				return;
			}
			const entry = this.#activeEntry();
			if (this.#isBrowserView(entry) && this.#browser.query.length > 0) {
				this.#browser.handleCancel();
				return;
			}
			this.#callbacks.onCancel();
			return;
		}

		const rolesView = entry.kind === "roles" && this.#assigning === null;
		const lockedView = entry.kind === "provider" && entry.locked && this.#assigning === null;

		if (this.#settings.get("settings.tier") === "advanced" && this.#focus === "list" && matchesKey(data, "ctrl+e")) {
			if (!this.#canCustomizeModelSettings()) return;
			if (rolesView) {
				const row = this.#rolesRows[this.#roleIndex];
				const role = row?.kind === "role" ? row.role : undefined;
				const assignment = role ? this.#roles[role] : undefined;
				if (role && assignment) {
					this.#openModelSettingsTargetStrip(
						{
							provider: assignment.model.provider,
							id: assignment.model.id,
							model: assignment.model,
							selector: `${assignment.model.provider}/${assignment.model.id}`,
						},
						role,
						true,
					);
				}
				return;
			}
			if (this.#assigning === null && this.#isBrowserView(entry)) {
				const item = this.#browser.getSelected();
				if (item) this.#openModelSettingsTargetStrip(item, undefined, false);
				return;
			}
		}

		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#focus = this.#focus === "scope" ? "list" : "scope";
			return;
		}
		if (matchesKey(data, "f5")) {
			if (entry.kind === "provider" && !entry.locked) {
				this.#scheduleProviderRefresh(entry.providerId ?? "", { force: true });
			}
			return;
		}

		// ←/→ are spatial pane switches: the sidebar sits left of the rows.
		// They never reach the search caret — fuzzy queries don't need one.
		if (matchesKey(data, "left")) {
			this.#focus = "scope";
			return;
		}
		if (matchesKey(data, "right")) {
			// Only views with rows can take list focus (not the locked pane).
			if (rolesView || this.#isBrowserView(entry)) {
				this.#focus = "list";
			}
			return;
		}

		// Arrow ownership: scope mode hops the sidebar; list mode navigates rows.
		if (this.#focus === "scope") {
			if (matchesSelectUp(data)) {
				this.#moveSidebar(-1);
				return;
			}
			if (matchesSelectDown(data)) {
				this.#moveSidebar(1);
				return;
			}
		}

		if (rolesView) {
			const printable = extractPrintableText(data);
			if (this.#focus === "scope" && printable !== undefined && printable.trim().length > 0) {
				this.#setActiveEntry("all");
				this.#focus = "list";
				this.#browser.handleInput(data);
				return;
			}
			this.#handleRolesViewInput(data);
			return;
		}
		if (lockedView) {
			const printable = extractPrintableText(data);
			if (printable !== undefined && printable.trim().length > 0) {
				this.#setActiveEntry("all");
				this.#focus = "list";
				this.#browser.handleInput(data);
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				this.#requestLogin(entry);
			}
			return;
		}

		const beforeQuery = this.#browser.query;
		const isPrintable = extractPrintableText(data) !== undefined;
		this.#browser.handleInput(data);
		if (isPrintable || this.#browser.query !== beforeQuery) {
			this.#focus = "list";
		}
	}

	#isBrowserView(entry: SidebarEntry): boolean {
		if (this.#assigning !== null) return true;
		return entry.kind === "recent" || entry.kind === "all" || (entry.kind === "provider" && !entry.locked);
	}

	#handleStripInput(data: string): void {
		const strip = this.#strip;
		if (!strip) return;
		if (matchesSelectCancel(data)) {
			this.#closeStrip();
			return;
		}
		if (strip.kind === "roleName") {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				this.#submitRoleName();
				return;
			}
			strip.input.handleInput(data);
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
			strip.index = (strip.index - 1 + strip.chips.length) % strip.chips.length;
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "down") || matchesKey(data, "tab")) {
			strip.index = (strip.index + 1) % strip.chips.length;
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#activateStripChip();
			return;
		}
	}

	#moveSidebar(delta: number): void {
		const count = this.#entries.length;
		if (count === 0) return;
		let index = this.#entries.findIndex(entry => entry.id === this.#activeEntryId);
		if (index < 0) index = 0;
		for (let step = 0; step < count; step++) {
			index = (index + delta + count) % count;
			const entry = this.#entries[index];
			if (entry && !this.#isHopSkipped(entry)) {
				// Scope changes keep an active assignment (scoping helps find the
				// model); landing on the Roles view cancels it.
				if (entry.kind === "roles") this.#assigning = null;
				this.#setActiveEntry(entry.id);
				return;
			}
		}
	}

	/** Row count of the roles view (roles, their fallback entries, and the trailing "+ New role…" row). */
	get #rolesRowCount(): number {
		return this.#rolesRows.length;
	}

	/** Enter/click activation for a Roles-view row. */
	#activateRolesRow(row: RolesRow): void {
		switch (row.kind) {
			case "role":
				this.#startAssign(row.role);
				return;
			case "chainKey":
				this.#startAssignFallback(row.role, null);
				return;
			case "fallback":
				this.#startAssignFallback(row.role, row.chainIndex);
				return;
			case "newFallback":
				this.#startAssignFallbackKey();
				return;
			case "newRole":
				this.#openRoleNameStrip();
				return;
			case "separator":
				return;
		}
	}

	/** Scroll `#roleScrollStart` just enough to keep `#roleIndex` inside a window of `viewHeight` rows, clamped to the list. */
	#ensureRoleVisible(viewHeight: number, total: number): number {
		if (viewHeight <= 0) return 0;
		let start = this.#roleScrollStart;
		if (this.#roleIndex < start) start = this.#roleIndex;
		else if (this.#roleIndex >= start + viewHeight) start = this.#roleIndex - viewHeight + 1;
		return Math.max(0, Math.min(start, Math.max(0, total - viewHeight)));
	}

	/** Step the roles cursor by one row, skipping separator rows. Wraps at the ends unless `wrap: false` (then the cursor stays put). */
	#stepRoleIndex(from: number, delta: -1 | 1, options: { wrap?: boolean } = {}): number {
		const wrap = options.wrap ?? true;
		const count = this.#rolesRows.length;
		if (count === 0) return 0;
		let index = from;
		for (let i = 0; i < count; i++) {
			const next = index + delta;
			if (next < 0 || next >= count) {
				if (!wrap) return from;
				index = (next + count) % count;
			} else {
				index = next;
			}
			if (this.#rolesRows[index]?.kind !== "separator") return index;
		}
		return from;
	}

	#handleRolesViewInput(data: string): void {
		// Scope focus treats the roles view as a preview: Enter/Space dives
		// into the rows, everything else is inert (arrows already hop).
		if (this.#focus === "scope") {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n" || matchesKey(data, "space")) {
				this.#focus = "list";
			}
			return;
		}
		if (matchesSelectUp(data)) {
			this.#roleIndex = this.#stepRoleIndex(this.#roleIndex, -1);
			return;
		}
		if (matchesSelectDown(data)) {
			this.#roleIndex = this.#stepRoleIndex(this.#roleIndex, 1);
			return;
		}
		const row = this.#rolesRows[this.#roleIndex];
		const role = row?.kind === "role" ? row.role : undefined;
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			if (row) this.#activateRolesRow(row);
			return;
		}
		if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
			if (role) this.#unassignRole(role);
			else if (row?.kind === "fallback") this.#removeFallback(row);
			else if (row?.kind === "chainKey") this.#setFallbackChain(row.role, []);
			return;
		}
		// Reordering: [ / shift+↑ moves the row earlier, ] / shift+↓ later —
		// cycle order on a role row, chain order on a fallback row.
		if (matchesKey(data, "shift+up")) {
			if (role) this.#moveCycleMembership(role, -1);
			else if (row?.kind === "fallback") this.#moveFallback(row, -1);
			return;
		}
		if (matchesKey(data, "shift+down")) {
			if (role) this.#moveCycleMembership(role, 1);
			else if (row?.kind === "fallback") this.#moveFallback(row, 1);
			return;
		}
		const printable = extractPrintableText(data);
		if (printable === "x") {
			if (role) this.#unassignRole(role);
			else if (row?.kind === "fallback") this.#removeFallback(row);
			else if (row?.kind === "chainKey") this.#setFallbackChain(row.role, []);
			return;
		}
		if (printable === "f") {
			if (row?.kind === "newFallback") this.#startAssignFallbackKey();
			else if (row && row.kind !== "newRole" && row.kind !== "separator") {
				this.#startAssignFallback(row.role, null);
			}
			return;
		}
		if (printable === "c") {
			if (role) this.#toggleCycleMembership(role);
			return;
		}
		if (printable === "[") {
			if (role) this.#moveCycleMembership(role, -1);
			else if (row?.kind === "fallback") this.#moveFallback(row, -1);
			return;
		}
		if (printable === "]") {
			if (role) this.#moveCycleMembership(role, 1);
			else if (row?.kind === "fallback") this.#moveFallback(row, 1);
			return;
		}
		if (printable === "n") {
			this.#openRoleNameStrip();
			return;
		}
		if (printable === "t") {
			const assignment = role ? this.#roles[role] : undefined;
			if (role && assignment) {
				const source =
					this.#settings.get("modelRoleStorage") === "project"
						? this.#settings.getModelRoleSource(role)
						: "default";
				const scope = source === "project" || source === "global" ? source : undefined;
				const scopedModel = scope ? this.#roleForScope(role, scope).model : assignment.model;
				if (!scopedModel) return;
				const item: ModelBrowserItem = {
					provider: scopedModel.provider,
					id: scopedModel.id,
					model: scopedModel,
					selector: `${scopedModel.provider}/${scopedModel.id}`,
				};
				this.#openThinkingStrip(item, role, true, scope);
			}
			return;
		}
	}

	#requestLogin(entry: SidebarEntry): void {
		if (!entry.providerId) return;
		if (entry.oauth) {
			this.#callbacks.onLoginRequest?.(entry.providerId);
		}
	}

	/** Map a content-line index to a sidebar entry index (accounting for scroll). */
	#sidebarEntryIndexAt(contentLine: number): number | null {
		const index = this.#sidebarScroll + contentLine;
		if (index < 0 || index >= this.#entries.length) return null;
		return index;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════════

	#sidebarWidth(): number {
		let longest = 0;
		for (const entry of this.#entries) {
			const annotation = entry.annotation ?? "";
			longest = Math.max(longest, visibleWidth(entry.label) + visibleWidth(annotation) + 5);
		}
		return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, longest));
	}

	#renderSidebar(width: number, rows: number): string[] {
		// The scroll offset is persistent: the wheel pans it freely. Only an
		// activation (keys, click, programmatic) snaps the viewport to the
		// active entry, and only far enough to reveal it.
		if (this.#sidebarFollowActive) {
			const activeIndex = Math.max(
				0,
				this.#entries.findIndex(entry => entry.id === this.#activeEntryId),
			);
			if (activeIndex < this.#sidebarScroll) {
				this.#sidebarScroll = activeIndex;
			} else if (activeIndex >= this.#sidebarScroll + rows) {
				this.#sidebarScroll = activeIndex - rows + 1;
			}
			this.#sidebarFollowActive = false;
		}
		this.#sidebarScroll = Math.max(0, Math.min(this.#sidebarScroll, Math.max(0, this.#entries.length - rows)));

		const lines: string[] = [];
		for (let i = this.#sidebarScroll; i < Math.min(this.#entries.length, this.#sidebarScroll + rows); i++) {
			const entry = this.#entries[i];
			if (!entry) continue;
			if (entry.kind === "separator") {
				lines.push(theme.fg("border", "─".repeat(width)));
				continue;
			}
			const active = entry.id === this.#activeEntryId;
			const hovered = i === this.#sidebarHover;
			const searching = this.#searchCounts !== null;
			let matchCount: number | undefined;
			if (searching) {
				if (entry.kind === "provider" && !entry.locked) {
					matchCount = this.#searchCounts?.get(entry.providerId ?? "") ?? 0;
				} else if (entry.kind === "recent") {
					matchCount = this.#recentSearchCount;
				} else if (entry.kind === "all") {
					matchCount = this.#searchTotal;
				}
			}
			// While searching, entries the hop skips gray out: locked and
			// zero-match providers, an empty Recent, and the Roles view.
			const muted = entry.locked || matchCount === 0 || (searching && entry.kind === "roles");
			// The sidebar's active entry is state, not a cursor: accent label
			// plus a cursor glyph while the sidebar owns the arrows. The band
			// stays in the body pane so the two never look alike.
			const cursor = active && this.#focus === "scope" ? theme.fg("accent", theme.nav.cursor) : " ";

			let icon: string;
			if (entry.kind === "recent") {
				icon = theme.icon.time;
			} else if (entry.kind === "roles") {
				icon = theme.icon.extensionSkill;
			} else if (entry.kind === "all") {
				icon = theme.icon.model;
			} else {
				icon = muted ? theme.status.shadowed : theme.status.enabled;
			}
			const labelStyled = muted
				? theme.fg("dim", entry.label)
				: active
					? theme.bold(theme.fg("accent", entry.label))
					: entry.label;

			const refreshing = entry.providerId ? this.#refreshingProviders.has(entry.providerId) : false;
			const annotationText = matchCount !== undefined ? String(matchCount) : (entry.annotation ?? "");
			const annotationStyled = refreshing
				? theme.fg("warning", theme.spinnerFrames[this.#refreshSpinnerFrame % theme.spinnerFrames.length] ?? "")
				: theme.fg("dim", annotationText);

			const left = `${cursor} ${muted ? theme.fg("dim", icon) : theme.fg(entry.kind === "provider" ? "success" : "accent", icon)} ${labelStyled}`;
			const leftWidth = visibleWidth(left);
			const annWidth = visibleWidth(annotationStyled);
			let line: string;
			if (leftWidth + annWidth + 1 <= width) {
				line = `${left}${" ".repeat(width - leftWidth - annWidth)}${annotationStyled}`;
			} else {
				line = truncateToWidth(left, width);
				const lineWidth = visibleWidth(line);
				if (lineWidth < width) line += " ".repeat(width - lineWidth);
			}
			if (hovered) {
				line = theme.bg("selectedBg", line);
			}
			lines.push(line);
		}
		return lines;
	}

	#statusRow(width: number): string {
		if (this.#assigning !== null) {
			if (this.#assigning.kind === "fallbackKey") {
				return truncateToWidth(
					theme.fg("accent", " New fallback chain — Enter picks the model it protects, Esc cancels"),
					width,
				);
			}
			const info = getRoleInfo(this.#assigning.role, this.#settings);
			const label = info.tag ?? info.name ?? this.#assigning.role;
			if (this.#assigning.kind === "fallback") {
				const verb = this.#assigning.index === null ? "Adding fallback for" : "Replacing fallback of";
				return truncateToWidth(
					theme.fg("accent", ` ${verb} ${theme.bold(label)} — Enter picks the fallback model, Esc cancels`),
					width,
				);
			}
			return truncateToWidth(
				theme.fg("accent", ` Assigning ${theme.bold(label)} — Enter assigns, Esc cancels`),
				width,
			);
		}
		const entry = this.#activeEntry();
		const scopedSuffix = this.#scopedModels.length > 0 ? " · --models scope" : "";
		let text: string;
		switch (entry.kind) {
			case "recent":
				text = `Recently used models${scopedSuffix}`;
				break;
			case "roles":
				text = "Role assignments — agents resolve @role here; Enter changes the selected provider/model";
				break;
			case "provider":
				if (entry.locked) {
					text = `${entry.label} · not configured`;
				} else if (entry.providerId && this.#refreshingProviders.has(entry.providerId)) {
					text = `${entry.label} · refreshing model list…`;
				} else {
					text = `${entry.label} · ${entry.annotation ?? "0"} models${scopedSuffix}`;
				}
				break;
			default:
				text = `All available models${scopedSuffix}`;
				break;
		}
		if (this.#configError && entry.kind !== "provider") {
			text = this.#configError;
			return truncateToWidth(theme.fg("error", ` ${text}`), width);
		}
		return truncateToWidth(theme.fg("muted", ` ${text}`), width);
	}

	/** Clamp a roles row to `width`; the bg band is reserved for mouse hover. */
	#finishRolesRow(line: string, width: number, hovered: boolean): string {
		let out = truncateToWidth(line, width);
		if (hovered) {
			const w = visibleWidth(out);
			if (w < width) out += " ".repeat(width - w);
			return theme.bg("selectedBg", out);
		}
		return out;
	}

	#renderRolesView(width: number, rows: number): string[] {
		const lines: string[] = [];
		lines.push("");
		// First row's offset in bodyLine coordinates: the mouse router's
		// `bodyLine` has already dropped the status row, so this is just the
		// leading blank line — no extra status-row offset here.
		this.#rolesRowStart = lines.length;

		let tagWidth = 0;
		for (const rowDef of this.#rolesRows) {
			if (rowDef.kind !== "role") continue;
			const info = getRoleInfo(rowDef.role, this.#settings);
			tagWidth = Math.max(tagWidth, visibleWidth(info.tag ?? info.name ?? rowDef.role));
		}

		const cycleOrder = this.#cycleOrder();
		const listFocused = this.#focus === "list";
		const tier = this.#settings.get("settings.tier");
		const selectedRoleRow = this.#rolesRows[this.#roleIndex];
		const selectedRole = selectedRoleRow?.kind === "role" ? selectedRoleRow.role : undefined;
		const selectedAssignment = selectedRole ? this.#roles[selectedRole] : undefined;
		const effectiveLines = selectedAssignment
			? this.#effectiveModelSettingsLines(selectedAssignment.model, selectedRole, true)
			: [];
		// Window the list around the cursor so entries past the panel height stay
		// reachable; the trailing indicator line steals one row when clipped.
		const total = this.#rolesRows.length;
		const capacity = Math.max(0, rows - 2 - this.#rolesRowStart - effectiveLines.length);
		const overflow = total > capacity;
		const viewHeight = overflow ? Math.max(0, capacity - 1) : capacity;
		this.#roleScrollStart = this.#ensureRoleVisible(viewHeight, total);
		const endIndex = Math.min(this.#roleScrollStart + viewHeight, total);
		this.#rolesVisibleCount = Math.max(0, endIndex - this.#roleScrollStart);
		for (let i = this.#roleScrollStart; i < endIndex; i++) {
			const rowDef = this.#rolesRows[i];
			if (!rowDef) continue;
			const selected = i === this.#roleIndex;
			const hovered = i === this.#roleHover;
			// The unfocused pane draws no cursor; accent text still marks the row.
			const cursor = selected && listFocused ? theme.fg("accent", theme.nav.cursor) : " ";

			if (rowDef.kind === "separator") {
				lines.push(`   ${theme.fg("border", "─".repeat(Math.max(1, width - 6)))}`);
				continue;
			}

			if (rowDef.kind === "newRole" || rowDef.kind === "newFallback") {
				const label = rowDef.kind === "newRole" ? "+ New role…" : "+ New fallback…";
				let line = ` ${cursor} ${theme.fg(selected ? "accent" : "dim", label)}`;
				line = this.#finishRolesRow(line, width, hovered);
				lines.push(line);
				continue;
			}

			if (rowDef.kind === "chainKey") {
				const key = rowDef.role;
				const slash = key.lastIndexOf("/");
				const tail = key.slice(slash + 1);
				const keyStyled = theme.fg("dim", key.slice(0, slash + 1)) + (selected ? theme.fg("accent", tail) : tail);
				let line = ` ${cursor} ${theme.fg("dim", theme.status.shadowed)} ${keyStyled}`;
				line = this.#finishRolesRow(line, width, hovered);
				lines.push(line);
				continue;
			}

			if (rowDef.kind === "fallback") {
				const branch = theme.fg("dim", `${"".padEnd(tagWidth + 3)}↳`);
				const selector = selected ? theme.fg("accent", rowDef.selector) : theme.fg("muted", rowDef.selector);
				let line = ` ${cursor} ${branch} ${selector}`;
				line = this.#finishRolesRow(line, width, hovered);
				lines.push(line);
				continue;
			}

			const role = rowDef.role;
			const info = getRoleInfo(role, this.#settings);
			const assignment = this.#roles[role];
			const tag = (info.tag ?? info.name ?? role).padEnd(tagWidth);

			let dot: string;
			let tagStyled: string;
			let value: string;
			let levelStyled = "";
			if (assignment && !assignment.autoSelected) {
				dot = theme.fg(info.color ?? "muted", theme.status.enabled);
				tagStyled = theme.fg(info.color ?? "muted", tag);
				value = `${theme.fg("dim", `${assignment.model.provider}/`)}${selected ? theme.fg("accent", assignment.model.id) : assignment.model.id}`;
				const glyph = thinkingLevelGlyph(assignment.thinkingLevel);
				const configuredLabel = getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label;
				const label = configuredLabel === "inherit" ? "provider default" : configuredLabel;
				levelStyled = theme.fg("dim", `${glyph ? `${glyph} ` : ""}effort ${label}`);
			} else if (assignment) {
				dot = theme.fg("dim", theme.status.shadowed);
				tagStyled = theme.fg("dim", tag);
				value = theme.fg("dim", `auto → ${assignment.model.provider}/${assignment.model.id}`);
				const glyph = thinkingLevelGlyph(assignment.thinkingLevel);
				const configuredLabel = getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label;
				const label = configuredLabel === "inherit" ? "provider default" : configuredLabel;
				levelStyled = theme.fg("dim", `${glyph ? `${glyph} ` : ""}effort ${label}`);
			} else {
				dot = theme.fg("dim", theme.status.shadowed);
				tagStyled = theme.fg("dim", tag);
				value = theme.fg("dim", "—");
			}

			// Quick-cycle membership badge (`⟳ 2` = second stop of the ctrl+p cycle).
			const cycleIndex = cycleOrder.indexOf(role);
			const cycleStyled = cycleIndex >= 0 ? theme.fg("accent", `${theme.icon.loop} ${cycleIndex + 1}`) : "";

			let line = ` ${cursor} ${dot} ${tagStyled}  ${value}`;
			const right = [levelStyled, cycleStyled].filter(part => part.length > 0).join("  ");
			const rightWidth = visibleWidth(right);
			const lineWidth = visibleWidth(line);
			if (rightWidth > 0 && lineWidth + rightWidth + 2 <= width) {
				line = `${line}${" ".repeat(width - lineWidth - rightWidth - 1)}${right}`;
			}
			line = this.#finishRolesRow(line, width, hovered);
			lines.push(line);
		}

		if (overflow) {
			const hiddenAbove = this.#roleScrollStart;
			const hiddenBelow = total - endIndex;
			const parts: string[] = [];
			if (hiddenAbove > 0) parts.push(`↑ ${hiddenAbove} more`);
			if (hiddenBelow > 0) parts.push(`↓ ${hiddenBelow} more`);
			lines.push(truncateToWidth(theme.fg("dim", `   ${parts.join("   ")}`), width));
		}

		// Live preview of the quick-switch cycle, rendered with the exact
		// segment track the ctrl+p status uses; the selected role's chip fills.
		const cycleRow = rows - effectiveLines.length - 1;
		while (lines.length <= cycleRow) lines.push("");
		if (cycleRow >= 0) {
			const cycleKey = getKeybindings().getKeys("app.model.cycleForward")[0] ?? "ctrl+p";
			if (cycleOrder.length > 0) {
				const activeIndex = cycleOrder.indexOf(selectedRole ?? "");
				const track = renderSegmentTrack(
					cycleOrder.map(role => ({ label: role })),
					activeIndex,
				);
				lines[cycleRow] = truncateToWidth(`  ${theme.fg("dim", `${cycleKey} cycle:`)} ${track}`, width);
			} else {
				lines[cycleRow] = truncateToWidth(
					theme.fg("dim", `  ${cycleKey} cycle is empty — press c on a role to add it`),
					width,
				);
			}
		}
		for (let i = 0; i < effectiveLines.length; i++) {
			const color = tier === "advanced" && i === 0 ? "accent" : "dim";
			lines.push(truncateToWidth(theme.fg(color, `  ${effectiveLines[i]}`), width));
		}
		return lines.slice(0, rows);
	}

	#renderLockedView(entry: SidebarEntry, width: number, rows: number): string[] {
		const lines: string[] = [];
		this.#lockedLoginLine = null;
		lines.push("");
		lines.push(truncateToWidth(theme.fg("warning", `  ${entry.label} has no credentials configured`), width));
		lines.push("");
		const envVars = entry.providerId ? (getCatalogProviderEntry(entry.providerId)?.envVars ?? []) : [];
		if (envVars.length > 0) {
			lines.push(
				truncateToWidth(
					theme.fg("muted", `  Set ${envVars.join(" or ")} in your environment, or add a key in config.`),
					width,
				),
			);
		} else {
			lines.push(truncateToWidth(theme.fg("muted", "  Add an API key for this provider in config."), width));
		}
		if (entry.oauth) {
			this.#lockedLoginLine = lines.length + 1; // +1 for the status row offset handled by caller
			lines.push(truncateToWidth(theme.fg("accent", `  ${theme.nav.cursor} Log in with OAuth (Enter)`), width));
		}
		lines.push("");
		const catalogCount = entry.catalogCount ?? 0;
		if (catalogCount > 0) {
			lines.push(truncateToWidth(theme.fg("dim", `  ${catalogCount} models in catalog:`), width));
			const preview = this.#scopedModels.length > 0 ? [] : this.#registry.getAll();
			for (const model of preview) {
				if (model.provider !== entry.providerId) continue;
				if (lines.length >= rows) break;
				lines.push(truncateToWidth(theme.fg("dim", `    ${model.id}`), width));
			}
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	#footerHint(): string {
		const strip = this.#strip;
		if (strip) {
			if (strip.kind === "roleName") {
				return "Enter create + pick model · Esc cancel";
			}
			if (strip.kind === "role") return "←/→ choose · Enter assign/clear · Esc cancel";
			if (strip.kind === "scope") return "←/→ save scope · Enter choose · Esc cancel";
			if (strip.kind === "thinking") return "←/→ thinking level · Enter apply · Esc keep";
			if (strip.kind === "settingsValue") return "←/→ value · Enter apply/reset · Esc cancel";
			return "←/→ choose · Enter continue · Esc cancel";
		}
		if (this.#assigning !== null) {
			switch (this.#assigning.kind) {
				case "fallback":
					return "Enter pick fallback · ↑/↓ providers · type to search · Esc cancel";
				case "fallbackKey":
					return "Enter pick the protected model · ↑/↓ providers · type to search · Esc cancel";
				default:
					return "Enter assign · ↑/↓ providers · type to search · Esc cancel";
			}
		}
		const entry = this.#activeEntry();
		if (entry.kind === "roles") {
			if (this.#focus !== "list") {
				return "↑/↓ providers · → roles · Esc close";
			}
			const row = this.#rolesRows[this.#roleIndex];
			if (row?.kind === "fallback") {
				return "↑/↓ rows · Enter replace · f add another · x remove · [/] reorder · ← providers";
			}
			if (row?.kind === "chainKey") {
				return "↑/↓ rows · Enter/f add fallback · x clear chain · ← providers";
			}
			if (row?.kind === "newFallback") {
				return "↑/↓ rows · Enter new model/provider fallback chain · ← providers";
			}
			const base = "↑/↓ rows · Enter pick · f fallback · x clear · t thinking · c cycle · [/] reorder · n new";
			const assignment = row?.kind === "role" ? this.#roles[row.role] : undefined;
			return this.#canCustomizeModelSettings() && this.#settings.get("settings.tier") === "advanced" && assignment
				? `${base} · Ctrl+E customize`
				: base;
		}
		if (entry.kind === "provider" && entry.locked) {
			return entry.oauth ? "Enter log in · ↑/↓ providers · Esc close" : "↑/↓ providers · Esc close";
		}
		const arrows = this.#focus === "scope" ? "↑/↓ providers · → models" : "↑/↓ models · ← providers";
		const refresh = entry.kind === "provider" ? " · F5 refresh" : "";
		const customize =
			this.#canCustomizeModelSettings() &&
			this.#settings.get("settings.tier") === "advanced" &&
			this.#focus === "list" &&
			this.#browser.getSelected()
				? " · Ctrl+E customize"
				: "";
		return `Enter assign roles · ${arrows} · type to search${refresh}${customize} · Esc close`;
	}

	/** Footer row: active strip (chips) or the contextual hint line. */
	#renderFooter(width: number): string {
		this.#chipRanges = [];
		const strip = this.#strip;
		if (!strip) {
			return truncateToWidth(theme.fg("dim", this.#footerHint()), width);
		}

		if (strip.kind === "roleName") {
			const label = theme.fg("accent", "New role name:");
			const inputWidth = Math.max(8, Math.min(32, width - visibleWidth("New role name:") - 24));
			const inputLine = strip.input.render(inputWidth)[0] ?? "";
			return truncateToWidth(`${label} ${inputLine} ${theme.fg("dim", "(letters, digits, - and _)")}`, width);
		}

		let prefix: string;
		switch (strip.kind) {
			case "role":
				prefix = `${theme.fg("accent", strip.item.id)}${theme.fg("dim", " →")} `;
				break;
			case "scope":
			case "thinking": {
				const info = getRoleInfo(strip.role ?? "", this.#settings);
				prefix = `${theme.fg(info.color ?? "muted", (info.tag ?? strip.role ?? "").toLowerCase())}${theme.fg("dim", ` · ${strip.item.id} →`)} `;
				break;
			}
			case "settingsTarget":
				prefix = `${theme.fg("accent", "Customize")}${theme.fg("dim", ` · ${strip.item.id} → target`)} `;
				break;
			case "settingsScope":
			case "settingsField":
			case "settingsValue": {
				const targetLabel = strip.target.kind === "role" ? `role ${strip.target.role}` : strip.target.model;
				const step =
					strip.kind === "settingsScope"
						? "scope"
						: strip.kind === "settingsField"
							? "field"
							: strip.field === "thinking"
								? "Thinking"
								: "Prompt cache";
				prefix = `${theme.fg("accent", targetLabel)}${theme.fg("dim", ` · ${step} →`)} `;
				break;
			}
		}

		// Horizontal window: once the strip overflows, drop leading chips behind
		// a dim ellipsis so the selected chip (plus one chip of lookahead when it
		// fits) stays visible while cycling right.
		const prefixWidth = visibleWidth(prefix);
		const available = Math.max(1, width - prefixWidth);
		const chipWidths = strip.chips.map(
			(chip, i) => visibleWidth(` ${chip.styled} `) + (i === strip.index ? 2 : 0) + 1,
		);
		// Smallest start index whose window [start..target] (with its "… " lead-in
		// when start > 0) fits in the available width; `target` itself may still
		// overflow when a single chip is wider than the row.
		const startFor = (target: number): number => {
			let start = 0;
			while (start < target) {
				let sum = start > 0 ? 2 : 0;
				for (let i = start; i <= target; i++) sum += chipWidths[i] ?? 0;
				if (sum <= available) break;
				start++;
			}
			return start;
		};
		let start = startFor(Math.min(strip.index + 1, strip.chips.length - 1));
		if (start > strip.index) start = startFor(strip.index);

		let line = prefix;
		// Columns are relative to the frame: row() insets content by 2.
		let col = 2 + prefixWidth;
		if (start > 0) {
			line += theme.fg("dim", "… ");
			col += 2;
		}
		for (let i = start; i < strip.chips.length; i++) {
			const chip = strip.chips[i];
			if (!chip) continue;
			const selected = i === strip.index;
			const body = ` ${chip.styled} `;
			const rendered = selected
				? theme.bg("selectedBg", `${theme.fg("accent", "[")}${body}${theme.fg("accent", "]")}`)
				: body;
			const w = visibleWidth(body) + (selected ? 2 : 0);
			this.#chipRanges.push({ start: col, end: col + w, index: i });
			line += rendered;
			col += w;
			line += " ";
			col += 1;
		}
		return truncateToWidth(line, width);
	}

	render(width: number): string[] {
		const height = Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		const sidebarWidth = this.#sidebarWidth();
		this.#sidebarWidthLast = sidebarWidth;
		const bodyWidth = splitBodyWidth(width, sidebarWidth);
		const contentRows = Math.max(10, height - 4);
		this.#contentRowCount = contentRows;

		const entry = this.#activeEntry();
		const bodyLines: string[] = [this.#statusRow(bodyWidth)];
		if (entry.kind === "roles" && this.#assigning === null) {
			bodyLines.push(...this.#renderRolesView(bodyWidth, contentRows - 1));
		} else if (entry.kind === "provider" && entry.locked && this.#assigning === null) {
			bodyLines.push(...this.#renderLockedView(entry, bodyWidth, contentRows - 1));
		} else {
			const selected = this.#browser.getSelected();
			const role = this.#assigning?.kind === "role" ? this.#assigning.role : undefined;
			const tier = this.#settings.get("settings.tier");
			const effectiveLines = selected
				? this.#effectiveModelSettingsLines(selected.model, role, this.#assigning === null)
				: [];
			this.#browser.setMaxVisible(contentRows - 1 - 5 - effectiveLines.length);
			this.#browser.setFocused(this.#focus === "list");
			bodyLines.push(...this.#browser.render(bodyWidth));
			for (let i = 0; i < effectiveLines.length; i++) {
				const color = tier === "advanced" && i === 0 ? "accent" : "dim";
				bodyLines.push(truncateToWidth(theme.fg(color, `  ${effectiveLines[i]}`), bodyWidth));
			}
		}

		const sidebarLines = this.#renderSidebar(sidebarWidth, contentRows);

		const out: string[] = [];
		out.push(topBorderSplit(width, "Models", sidebarWidth));
		this.#contentRowStart = out.length;
		for (let i = 0; i < contentRows; i++) {
			out.push(splitRow(sidebarLines[i] ?? "", bodyLines[i] ?? "", width, sidebarWidth));
		}
		out.push(dividerSplit(width, sidebarWidth));
		this.#footerRow = out.length;
		out.push(row(this.#renderFooter(width - 4), width));
		out.push(bottomBorder(width));
		return out;
	}
}
