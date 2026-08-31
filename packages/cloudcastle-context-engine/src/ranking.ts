import type { IncidentEvidence, RankedContext } from "./types";

const CHARS_PER_ESTIMATED_TOKEN = 4;
const MIN_TRUNCATED_CONTENT_CHARS = 24;

export function rankAndMergeEvidence(evidence: readonly IncidentEvidence[], tokenBudget: number): RankedContext {
	const byClass = new Map<string, IncidentEvidence[]>();
	for (const item of evidence) {
		const classItems = byClass.get(item.className);
		if (classItems) classItems.push(item);
		else byClass.set(item.className, [item]);
	}

	const classes = [...byClass.entries()]
		.map(([className, items]) => ({
			className,
			classPriority: Math.max(...items.map(item => item.classPriority)),
			items: items.sort(compareEvidenceWithinClass),
		}))
		.sort(
			(left, right) => right.classPriority - left.classPriority || compareStrings(left.className, right.className),
		);

	const candidates: IncidentEvidence[] = [];
	const longestClass = Math.max(0, ...classes.map(group => group.items.length));
	for (let index = 0; index < longestClass; index += 1) {
		for (const group of classes) {
			const item = group.items[index];
			if (item) candidates.push(item);
		}
	}

	const maxChars = tokenBudget * CHARS_PER_ESTIMATED_TOKEN;
	const selected: IncidentEvidence[] = [];
	const lines: string[] = [];
	let usedChars = 0;
	let truncated = false;
	for (const candidate of candidates) {
		const separatorChars = lines.length === 0 ? 0 : 1;
		const fullLine = serializeEvidence(candidate);
		if (usedChars + separatorChars + fullLine.length <= maxChars) {
			selected.push(candidate);
			lines.push(fullLine);
			usedChars += separatorChars + fullLine.length;
			continue;
		}

		const available = maxChars - usedChars - separatorChars;
		const shortened = truncateEvidenceToChars(candidate, available);
		if (shortened) {
			selected.push(shortened);
			const shortenedLine = serializeEvidence(shortened);
			lines.push(shortenedLine);
			usedChars += separatorChars + shortenedLine.length;
		}
		truncated = true;
		break;
	}

	return {
		evidence: selected,
		renderedEvidence: lines.join("\n"),
		estimatedTokens: Math.ceil(usedChars / CHARS_PER_ESTIMATED_TOKEN),
		truncated: truncated || selected.length < evidence.length,
	};
}

export function lexicalRelevance(content: string, query: string, termLimit: number): number {
	const terms = [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])]
		.sort(compareStrings)
		.slice(0, termLimit);
	if (terms.length === 0) return 0;
	const haystack = content.toLowerCase();
	let matched = 0;
	for (const term of terms) {
		if (haystack.includes(term)) matched += 1;
	}
	return matched / terms.length;
}

function compareEvidenceWithinClass(left: IncidentEvidence, right: IncidentEvidence): number {
	if (left.evidencePriority !== right.evidencePriority) return right.evidencePriority - left.evidencePriority;
	if (left.relevance !== right.relevance) return right.relevance - left.relevance;
	const leftTimestamp = left.timestamp ?? "";
	const rightTimestamp = right.timestamp ?? "";
	if (leftTimestamp !== rightTimestamp) return compareStrings(rightTimestamp, leftTimestamp);
	if (left.id !== right.id) return compareStrings(left.id, right.id);
	if (left.sourceUrl !== right.sourceUrl) return compareStrings(left.sourceUrl, right.sourceUrl);
	return compareStrings(left.content, right.content);
}

function serializeEvidence(evidence: IncidentEvidence): string {
	return JSON.stringify({
		class: evidence.className,
		entity: evidence.entity,
		id: evidence.id,
		priority: evidence.evidencePriority,
		provenance: evidence.provenance,
		source_url: evidence.sourceUrl,
		...(evidence.timestamp ? { timestamp: evidence.timestamp } : {}),
		content: evidence.content,
	});
}

function truncateEvidenceToChars(evidence: IncidentEvidence, maxChars: number): IncidentEvidence | undefined {
	if (maxChars <= 0) return undefined;
	let low = 0;
	let high = evidence.content.length;
	let best: IncidentEvidence | undefined;
	while (low <= high) {
		const midpoint = Math.floor((low + high) / 2);
		const content = midpoint < evidence.content.length ? `${evidence.content.slice(0, midpoint)}…` : evidence.content;
		const candidate = { ...evidence, content };
		if (serializeEvidence(candidate).length <= maxChars) {
			best = candidate;
			low = midpoint + 1;
		} else {
			high = midpoint - 1;
		}
	}
	return best && best.content.length >= MIN_TRUNCATED_CONTENT_CHARS ? best : undefined;
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
