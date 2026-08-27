export const THEME_MODES = ["system", "dark", "light"] as const;
export const MOTION_PREFERENCES = ["system", "full", "reduced"] as const;
export const DENSITIES = ["compact", "cozy", "roomy"] as const;

export type ThemeMode = (typeof THEME_MODES)[number];
export type MotionPreference = (typeof MOTION_PREFERENCES)[number];
export type Density = (typeof DENSITIES)[number];
export type AccentHex = string & { readonly __accentHex: unique symbol };

export interface ThemePreferences {
	theme: ThemeMode;
	motion: MotionPreference;
	density: Density;
	accentPrimary: AccentHex | null;
	accentSecondary: AccentHex | null;
}

export interface PreferenceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

interface StyleTarget {
	setProperty(name: string, value: string): void;
	removeProperty(name: string): void;
}

interface ClassTarget {
	classList?: { remove(...tokens: string[]): void };
}

export interface ThemeRoot extends ClassTarget {
	style: StyleTarget;
	setAttribute(name: string, value: string): void;
	querySelectorAll?(selector: string): ArrayLike<ClassTarget>;
}

export interface SystemPreferences {
	prefersDark: boolean;
	prefersReducedMotion: boolean;
}

export const THEME_PREFERENCE_STORAGE_KEY = "chudcode.ui.preferences.v1";

export const DEFAULT_THEME_PREFERENCES: Readonly<ThemePreferences> = Object.freeze({
	theme: "system",
	motion: "system",
	density: "cozy",
	accentPrimary: null,
	accentSecondary: null,
});

export const MOTION_CLASSES = Object.freeze([
	"motion-stream-row-enter",
	"motion-stream-row-static",
	"motion-stream-thinking",
	"motion-stream-live-edge",
	"motion-file-created",
	"motion-file-modified",
	"motion-file-deleted",
	"motion-file-recent",
	"motion-file-burst-summary",
	"motion-file-moved",
	"motion-diff-hunk",
	"motion-diff-line-enter",
	"motion-diff-navigate",
	"motion-graph-node-insert",
	"motion-graph-edge-insert",
	"motion-graph-node-remove",
	"motion-graph-settle",
	"motion-graph-changed",
	"motion-graph-flow",
	"motion-tab-underline",
	"motion-tab-content-enter",
	"motion-tab-dirty",
	"motion-tab-close",
	"motion-toast-enter",
	"motion-toast-exit",
	"motion-toast-countdown",
] as const);

const ACCENT_PATTERN = /^#[0-9a-f]{6}$/i;
const MOTION_SELECTOR = MOTION_CLASSES.map(className => `.${className}`).join(",");

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === "string" && allowed.includes(value as T);
}

export function normalizeAccentHex(value: unknown): AccentHex {
	if (typeof value !== "string" || !ACCENT_PATTERN.test(value)) {
		throw new TypeError("Accent must be a six-digit hexadecimal color prefixed with #");
	}
	return value.toUpperCase() as AccentHex;
}

function parseOptionalAccent(value: unknown, field: string): AccentHex | null {
	if (value === undefined || value === null) return null;
	try {
		return normalizeAccentHex(value);
	} catch {
		throw new TypeError(`${field} must be null or a valid accent hex`);
	}
}

export function parseThemePreferences(value: unknown): ThemePreferences {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("Theme preferences must be an object");
	}

	const theme = ("theme" in value ? value.theme : undefined) ?? DEFAULT_THEME_PREFERENCES.theme;
	const motion = ("motion" in value ? value.motion : undefined) ?? DEFAULT_THEME_PREFERENCES.motion;
	const density = ("density" in value ? value.density : undefined) ?? DEFAULT_THEME_PREFERENCES.density;
	if (!isOneOf(theme, THEME_MODES)) throw new TypeError(`Invalid theme preference: ${String(theme)}`);
	if (!isOneOf(motion, MOTION_PREFERENCES)) throw new TypeError(`Invalid motion preference: ${String(motion)}`);
	if (!isOneOf(density, DENSITIES)) throw new TypeError(`Invalid density preference: ${String(density)}`);

	return {
		theme,
		motion,
		density,
		accentPrimary: parseOptionalAccent("accentPrimary" in value ? value.accentPrimary : undefined, "accentPrimary"),
		accentSecondary: parseOptionalAccent(
			"accentSecondary" in value ? value.accentSecondary : undefined,
			"accentSecondary",
		),
	};
}

export function updateThemePreferences(current: ThemePreferences, patch: Partial<ThemePreferences>): ThemePreferences {
	return parseThemePreferences({ ...current, ...patch });
}

function browserStorage(): PreferenceStorage | undefined {
	const runtime = globalThis as typeof globalThis & { localStorage?: PreferenceStorage };
	const candidate = runtime.localStorage;
	return candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function"
		? candidate
		: undefined;
}

export function loadThemePreferences(storage: PreferenceStorage | undefined = browserStorage()): ThemePreferences {
	if (!storage) return { ...DEFAULT_THEME_PREFERENCES };
	try {
		const serialized = storage.getItem(THEME_PREFERENCE_STORAGE_KEY);
		return serialized === null ? { ...DEFAULT_THEME_PREFERENCES } : parseThemePreferences(JSON.parse(serialized));
	} catch {
		return { ...DEFAULT_THEME_PREFERENCES };
	}
}

export function persistThemePreferences(
	preferences: ThemePreferences,
	storage: PreferenceStorage | undefined = browserStorage(),
): ThemePreferences {
	const validated = parseThemePreferences(preferences);
	storage?.setItem(THEME_PREFERENCE_STORAGE_KEY, JSON.stringify(validated));
	return validated;
}

function accentChannels(hex: AccentHex): string {
	return [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(" ");
}

function applyAccent(root: ThemeRoot, property: string, accent: AccentHex | null): void {
	if (accent === null) root.style.removeProperty(property);
	else root.style.setProperty(property, accentChannels(accent));
}

export function readSystemPreferences(): SystemPreferences {
	const media = (
		globalThis as {
			matchMedia?: (query: string) => { matches: boolean };
		}
	).matchMedia;
	return {
		prefersDark: media?.("(prefers-color-scheme: dark)").matches ?? true,
		prefersReducedMotion: media?.("(prefers-reduced-motion: reduce)").matches ?? false,
	};
}

export function resolveTheme(theme: ThemeMode, system: SystemPreferences): Exclude<ThemeMode, "system"> {
	return theme === "system" ? (system.prefersDark ? "dark" : "light") : theme;
}

export function resolveMotionScale(motion: MotionPreference, system: SystemPreferences): number {
	if (motion === "reduced") return 0;
	if (motion === "full") return 1;
	return system.prefersReducedMotion ? 0 : 1;
}

export function clearMotionClasses(root: ThemeRoot): void {
	root.classList?.remove(...MOTION_CLASSES);
	const descendants = root.querySelectorAll?.(MOTION_SELECTOR);
	if (!descendants) return;
	for (let index = 0; index < descendants.length; index += 1) {
		descendants[index]?.classList?.remove(...MOTION_CLASSES);
	}
}

export function setMotionScale(root: ThemeRoot, scale: number): void {
	if (!Number.isFinite(scale) || scale < 0 || scale > 1) {
		throw new RangeError("Motion scale must be a finite number from 0 to 1");
	}
	const serialized = String(scale);
	root.setAttribute("data-motion-scale", serialized);
	root.style.setProperty("--motion-scale", serialized);
	if (scale === 0) clearMotionClasses(root);
}

export function applyThemePreferences(
	root: ThemeRoot,
	preferences: ThemePreferences,
	system: SystemPreferences = readSystemPreferences(),
): ThemePreferences {
	const validated = parseThemePreferences(preferences);
	root.setAttribute("data-theme", resolveTheme(validated.theme, system));
	root.setAttribute("data-theme-preference", validated.theme);
	root.setAttribute("data-density", validated.density);
	root.setAttribute("data-motion", validated.motion);
	applyAccent(root, "--accent-primary-rgb", validated.accentPrimary);
	applyAccent(root, "--accent-secondary-rgb", validated.accentSecondary);
	setMotionScale(root, resolveMotionScale(validated.motion, system));
	return validated;
}

export interface ThemeController {
	get(): ThemePreferences;
	update(patch: Partial<ThemePreferences>): ThemePreferences;
	setAccentColors(primary: string, secondary: string): ThemePreferences;
	resetAccentColors(): ThemePreferences;
	refreshSystemPreferences(system?: SystemPreferences): void;
}

export function createThemeController(
	root: ThemeRoot,
	storage: PreferenceStorage | undefined = browserStorage(),
): ThemeController {
	let preferences = loadThemePreferences(storage);
	applyThemePreferences(root, preferences);

	const commit = (next: ThemePreferences): ThemePreferences => {
		preferences = persistThemePreferences(next, storage);
		applyThemePreferences(root, preferences);
		return { ...preferences };
	};

	return {
		get: () => ({ ...preferences }),
		update: patch => commit(updateThemePreferences(preferences, patch)),
		setAccentColors: (primary, secondary) =>
			commit(
				updateThemePreferences(preferences, {
					accentPrimary: normalizeAccentHex(primary),
					accentSecondary: normalizeAccentHex(secondary),
				}),
			),
		resetAccentColors: () =>
			commit(updateThemePreferences(preferences, { accentPrimary: null, accentSecondary: null })),
		refreshSystemPreferences: system => {
			applyThemePreferences(root, preferences, system ?? readSystemPreferences());
		},
	};
}
