import { describe, expect, test } from "bun:test";
import {
	applyThemePreferences,
	loadThemePreferences,
	MOTION_CLASSES,
	normalizeAccentHex,
	type PreferenceStorage,
	parseThemePreferences,
	persistThemePreferences,
	setMotionScale,
	THEME_PREFERENCE_STORAGE_KEY,
	type ThemeRoot,
} from "../src/web/theme";

const tokensCss = await Bun.file(new URL("../src/web/styles/tokens.css", import.meta.url)).text();
const motionCss = await Bun.file(new URL("../src/web/styles/motion.css", import.meta.url)).text();

const ANSI_TOKEN_NAMES = [
	"ansi-black",
	"ansi-blue",
	"ansi-bright-black",
	"ansi-bright-blue",
	"ansi-bright-cyan",
	"ansi-bright-green",
	"ansi-bright-magenta",
	"ansi-bright-red",
	"ansi-bright-white",
	"ansi-bright-yellow",
	"ansi-cyan",
	"ansi-green",
	"ansi-magenta",
	"ansi-red",
	"ansi-white",
	"ansi-yellow",
] as const;

function blockFor(marker: string): string {
	const start = tokensCss.indexOf(marker);
	if (start < 0) throw new Error(`Missing CSS block ${marker}`);
	const bodyStart = tokensCss.indexOf("{", start) + 1;
	const bodyEnd = tokensCss.indexOf("\n}", bodyStart);
	return tokensCss.slice(bodyStart, bodyEnd);
}

function numericToken(block: string, name: string): number {
	const match = block.match(new RegExp(`--${name}:\\s*([0-9.]+)`));
	if (!match?.[1]) throw new Error(`Missing numeric token --${name}`);
	return Number(match[1]);
}

class MemoryStorage implements PreferenceStorage {
	readonly values = new Map<string, string>();

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}
}

class FakeClassTarget {
	readonly classes = new Set<string>();
	readonly classList = {
		remove: (...tokens: string[]) => {
			for (const token of tokens) this.classes.delete(token);
		},
	};
}

class FakeThemeRoot extends FakeClassTarget implements ThemeRoot {
	readonly attributes = new Map<string, string>();
	readonly properties = new Map<string, string>();
	readonly descendants: FakeClassTarget[] = [];
	readonly style = {
		setProperty: (name: string, value: string) => this.properties.set(name, value),
		removeProperty: (name: string) => {
			this.properties.delete(name);
		},
	};

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	querySelectorAll(): ArrayLike<FakeClassTarget> {
		return this.descendants;
	}
}

describe("web design tokens", () => {
	test("publishes the foundation values and complete IDE role families", () => {
		for (const declaration of [
			"--font-body:",
			"--font-code:",
			"--font-size-body: 17.5px",
			"--font-size-code: 15.5px",
			"--scrollbar-pill-width: 9px",
			"--scrollbar-chat-lane: 13px",
			"--gauge-start-angle: -90deg",
			"--color-editor-gutter:",
			"--color-editor-current-line:",
			"--color-search-match:",
			"--color-search-current:",
			"--color-tab-strip:",
			"--color-diagnostic-error:",
			"--color-graph-node-info:",
			"--color-status-success:",
			"--color-diff-add-wash:",
			"--color-glass-bg:",
			"--ansi-bright-white:",
		]) {
			expect(tokensCss).toContain(declaration);
		}
		const ansiTokenNames = (css: string) =>
			[...css.matchAll(/--(ansi-(?:bright-)?[a-z]+):/g)].map(match => match[1]).sort();
		expect([...new Set(ansiTokenNames(tokensCss))]).toEqual([...ANSI_TOKEN_NAMES]);
		expect(ansiTokenNames(blockFor(':root[data-theme="dark"]'))).toEqual([...ANSI_TOKEN_NAMES]);
		expect(ansiTokenNames(blockFor(':root[data-theme="light"]'))).toEqual([...ANSI_TOKEN_NAMES]);
		expect(tokensCss).toContain(':root[data-density="compact"]');
		expect(tokensCss).toContain(':root[data-density="cozy"]');
		expect(tokensCss).toContain(':root[data-density="roomy"]');
	});

	test("keeps persistent selection strictly stronger than hover in both themes", () => {
		const dark = blockFor(':root[data-theme="dark"]');
		const light = blockFor(':root[data-theme="light"]');
		expect(numericToken(dark, "alpha-selection")).toBeGreaterThan(numericToken(dark, "alpha-hover"));
		expect(numericToken(light, "alpha-selection")).toBeGreaterThan(numericToken(light, "alpha-hover"));
	});

	test("uses the normative motion values and covers every named surface", () => {
		for (const declaration of [
			"--motion-instant: calc(80ms",
			"--motion-fast: calc(140ms",
			"--motion-base: calc(220ms",
			"--motion-slow: calc(380ms",
			"--motion-stagger: calc(20ms",
			"--motion-breathe: calc(2400ms",
			"--motion-march: calc(1100ms",
			"--ease-out:",
			"--ease-in-out:",
			"--ease-out-back:",
			"--ease-spring:",
		]) {
			expect(motionCss).toContain(declaration);
		}
		for (const className of MOTION_CLASSES) expect(motionCss).toContain(`.${className}`);
	});

	test("has equivalent OS and runtime reduced-motion output", () => {
		expect(motionCss).toContain("@media (prefers-reduced-motion: reduce)");
		expect(motionCss).toContain(":root:not([data-motion-scale]) *");
		expect(motionCss).toContain(':root[data-motion-scale="0"] *');
		expect(motionCss.match(/animation-duration: 0s !important/g)).toHaveLength(2);
		expect(motionCss.match(/transition-duration: 0s !important/g)).toHaveLength(2);
		expect(motionCss.match(/scroll-behavior: auto !important/g)).toHaveLength(2);
	});

	test("keeps semantic color literals in the token authoring surface", () => {
		const literalValue = /:\s*(?:#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|transparent\b|black\b|white\b)/i;
		expect(motionCss).not.toMatch(literalValue);
	});

	test("contains no CAD-domain custom-property family", () => {
		const tokenNames = [...tokensCss.matchAll(/--([a-z0-9-]+)\s*:/g)].map(match => match[1] ?? "");
		const forbidden = /^(?:viewport|plane|sketch|sim|flow|cam|fit|plan|parts|ribbon|cp-menu|cp-chat|re-)/i;
		expect(tokenNames.filter(name => forbidden.test(name))).toEqual([]);
		expect(THEME_PREFERENCE_STORAGE_KEY.toLowerCase()).not.toContain("cad");
	});
});

describe("theme preferences", () => {
	test("rejects invalid accents, themes, motion preferences, densities, and scales", () => {
		for (const invalid of ["orange", "#123", "#12345g", "123456", " #123456", null]) {
			expect(() => normalizeAccentHex(invalid)).toThrow(TypeError);
		}
		expect(() => parseThemePreferences({ theme: "sepia" })).toThrow("Invalid theme");
		expect(() => parseThemePreferences({ motion: "slow" })).toThrow("Invalid motion");
		expect(() => parseThemePreferences({ density: "dense" })).toThrow("Invalid density");
		const root = new FakeThemeRoot();
		expect(() => setMotionScale(root, -0.01)).toThrow(RangeError);
		expect(() => setMotionScale(root, Number.NaN)).toThrow(RangeError);
		expect(() => setMotionScale(root, 1.01)).toThrow(RangeError);
	});

	test("round-trips only Chudcode product preferences", () => {
		const storage = new MemoryStorage();
		const expected = parseThemePreferences({
			theme: "light",
			motion: "reduced",
			density: "roomy",
			accentPrimary: "#12ab34",
			accentSecondary: "#4567cd",
		});
		persistThemePreferences(expected, storage);
		expect(loadThemePreferences(storage)).toEqual(expected);
		expect([...storage.values.keys()]).toEqual([THEME_PREFERENCE_STORAGE_KEY]);
		expect(storage.values.get(THEME_PREFERENCE_STORAGE_KEY)).not.toMatch(/workspace|provider|model|cad/i);
	});

	test("applies derived accent channels and snaps motion without lingering classes", () => {
		const root = new FakeThemeRoot();
		const child = new FakeClassTarget();
		for (const className of MOTION_CLASSES) {
			root.classes.add(className);
			child.classes.add(className);
		}
		root.descendants.push(child);

		applyThemePreferences(
			root,
			parseThemePreferences({
				theme: "system",
				motion: "system",
				density: "compact",
				accentPrimary: "#102030",
				accentSecondary: "#a0b0c0",
			}),
			{ prefersDark: false, prefersReducedMotion: true },
		);

		expect([...root.attributes]).toEqual([
			["data-theme", "light"],
			["data-theme-preference", "system"],
			["data-density", "compact"],
			["data-motion", "system"],
			["data-motion-scale", "0"],
		]);
		expect(root.properties.get("--accent-primary-rgb")).toBe("16 32 48");
		expect(root.properties.get("--accent-secondary-rgb")).toBe("160 176 192");
		expect(root.properties.get("--motion-scale")).toBe("0");
		expect(root.classes.size).toBe(0);
		expect(child.classes.size).toBe(0);
	});
});
