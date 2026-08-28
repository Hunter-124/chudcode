export interface ValgrindFrame {
	ip?: string;
	object?: string;
	function?: string;
	directory?: string;
	file?: string;
	line?: number;
}

export interface ValgrindError {
	kind: string;
	message: string;
	frames: ValgrindFrame[];
}

function decodeXml(value: string): string {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

function tag(block: string, name: string): string | undefined {
	const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`).exec(block);
	return match?.[1] === undefined ? undefined : decodeXml(match[1].trim());
}

export function parseValgrindXml(xml: string): ValgrindError[] {
	const errors: ValgrindError[] = [];
	for (const match of xml.matchAll(/<error>([\s\S]*?)<\/error>/g)) {
		const block = match[1]!;
		const frames: ValgrindFrame[] = [];
		for (const frameMatch of block.matchAll(/<frame>([\s\S]*?)<\/frame>/g)) {
			const frame = frameMatch[1]!;
			frames.push({
				...(tag(frame, "ip") ? { ip: tag(frame, "ip") } : {}),
				...(tag(frame, "obj") ? { object: tag(frame, "obj") } : {}),
				...(tag(frame, "fn") ? { function: tag(frame, "fn") } : {}),
				...(tag(frame, "dir") ? { directory: tag(frame, "dir") } : {}),
				...(tag(frame, "file") ? { file: tag(frame, "file") } : {}),
				...(tag(frame, "line") ? { line: Number(tag(frame, "line")) } : {}),
			});
			if (frames.length >= 100) break;
		}
		errors.push({
			kind: tag(block, "kind") ?? "Unknown",
			message: tag(block, "what") ?? tag(block, "auxwhat") ?? "Valgrind error",
			frames,
		});
		if (errors.length >= 100) break;
	}
	return errors;
}
