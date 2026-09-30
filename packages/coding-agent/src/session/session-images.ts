export interface SessionImageRef {
	index: number;
	mimeType: string;
	role: string;
	data: string;
}

/** Traverse the same content blocks, including paired tool results, in transcript order. */
export function collectSessionImages(messages: readonly unknown[]): SessionImageRef[] {
	const results = new Map<string, unknown>();
	for (const raw of messages) {
		if (typeof raw !== "object" || raw === null) continue;
		const message = raw as Record<string, unknown>;
		if (message.role === "toolResult" && typeof message.toolCallId === "string")
			results.set(message.toolCallId, message.content);
	}
	const images: SessionImageRef[] = [];
	const collect = (role: string, content: unknown): void => {
		if (!Array.isArray(content)) return;
		for (const block of content) {
			if (typeof block !== "object" || block === null) continue;
			const image = block as Record<string, unknown>;
			if (image.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string") {
				images.push({ index: images.length + 1, role, data: image.data, mimeType: image.mimeType });
			}
		}
	};
	const consumed = new Set<string>();
	for (const raw of messages) {
		if (typeof raw !== "object" || raw === null) continue;
		const message = raw as Record<string, unknown>;
		if (message.role === "user" || message.role === "developer") collect(message.role, message.content);
		else if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (typeof block !== "object" || block === null) continue;
				const call = block as Record<string, unknown>;
				if (call.type === "toolCall" && typeof call.id === "string" && results.has(call.id)) {
					consumed.add(call.id);
					collect("toolResult", results.get(call.id));
				}
			}
		} else if (message.role === "toolResult" && !consumed.has(String(message.toolCallId ?? ""))) {
			collect("toolResult", message.content);
		}
	}
	return images;
}
