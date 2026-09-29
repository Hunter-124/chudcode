export interface DhatAllocationPoint {
	total_bytes: number;
	total_blocks: number;
	max_bytes: number;
	max_blocks: number;
	end_bytes: number;
	end_blocks: number;
	reads?: number;
	writes?: number;
	frames: string[];
}

function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined;
}

function finite(value: unknown): number {
	const number = Number(value);
	return Number.isFinite(number) ? number : 0;
}

export function parseDhatJson(input: string | unknown, top = 20): DhatAllocationPoint[] {
	let document: unknown;
	try {
		document = typeof input === "string" ? JSON.parse(input) : input;
	} catch {
		return [];
	}
	const points = field(document, "pps");
	const frameTable = field(document, "ftbl");
	if (!Array.isArray(points)) return [];
	const frameNames = Array.isArray(frameTable) ? frameTable.map(value => String(value)) : [];
	const parsed: DhatAllocationPoint[] = [];
	for (const point of points) {
		const frameIds = field(point, "fs");
		parsed.push({
			total_bytes: finite(field(point, "tb")),
			total_blocks: finite(field(point, "tbk")),
			max_bytes: finite(field(point, "mb")),
			max_blocks: finite(field(point, "mbk")),
			end_bytes: finite(field(point, "eb")),
			end_blocks: finite(field(point, "ebk")),
			...(field(point, "rb") !== undefined ? { reads: finite(field(point, "rb")) } : {}),
			...(field(point, "wb") !== undefined ? { writes: finite(field(point, "wb")) } : {}),
			frames: Array.isArray(frameIds)
				? frameIds.slice(0, 50).map(id => frameNames[finite(id)] ?? `<frame ${finite(id)}>`)
				: [],
		});
		if (parsed.length >= 10_000) break;
	}
	return parsed.sort((left, right) => right.total_bytes - left.total_bytes).slice(0, Math.max(1, Math.min(200, top)));
}
