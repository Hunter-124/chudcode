import type { Api, Model } from "./types";

interface ReleaseDateParts {
	year: number;
	month: number;
	day?: number;
}

const RELEASE_DATE_PATTERN = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
	switch (month) {
		case 2:
			return isLeapYear(year) ? 29 : 28;
		case 4:
		case 6:
		case 9:
		case 11:
			return 30;
		default:
			return 31;
	}
}

function parseReleaseDate(value: unknown): ReleaseDateParts | undefined {
	if (typeof value !== "string") return undefined;
	const match = RELEASE_DATE_PATTERN.exec(value.trim());
	if (!match) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = match[3] === undefined ? undefined : Number(match[3]);
	if (year === 0 || month < 1 || month > 12) return undefined;
	if (day !== undefined && (day < 1 || day > daysInMonth(year, month))) return undefined;
	return { year, month, day };
}

/** Validate and normalize upstream model release dates without inventing missing precision. */
export function normalizeModelReleaseDate(value: unknown): string | undefined {
	return parseReleaseDate(value) === undefined ? undefined : (value as string).trim();
}

/**
 * Return whether a model was released before the calendar date `months` before
 * `asOf`. Missing or invalid release dates are unknown and therefore never old.
 * Month-only dates use the month's last day so reduced precision cannot
 * incorrectly classify a model as old.
 */
export function isModelOlderThanMonths<TApi extends Api>(
	model: Pick<Model<TApi>, "releaseDate">,
	months: number,
	asOf: Date,
): boolean {
	if (!Number.isInteger(months) || months < 0) {
		throw new RangeError("months must be a non-negative integer");
	}
	if (Number.isNaN(asOf.getTime())) {
		throw new RangeError("asOf must be a valid Date");
	}
	const release = parseReleaseDate(model.releaseDate);
	if (!release) return false;

	const asOfMonth = asOf.getUTCMonth();
	const cutoffMonthIndex = asOf.getUTCFullYear() * 12 + asOfMonth - months;
	const cutoffYear = Math.floor(cutoffMonthIndex / 12);
	const cutoffMonth = cutoffMonthIndex - cutoffYear * 12 + 1;
	const cutoffDay = Math.min(asOf.getUTCDate(), daysInMonth(cutoffYear, cutoffMonth));
	const releaseDay = release.day ?? daysInMonth(release.year, release.month);

	if (release.year !== cutoffYear) return release.year < cutoffYear;
	if (release.month !== cutoffMonth) return release.month < cutoffMonth;
	return releaseDay < cutoffDay;
}
