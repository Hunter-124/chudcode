const MAGIC = new TextEncoder().encode("OMPCAT1\0");
const HEADER_BYTES = 24;
const INDEX_FIXED_BYTES = 24;
const ALIGNMENT = 8;

export const MODEL_CATALOG_SCHEMA_VERSION = 1;

interface EncodedProvider {
	name: Uint8Array;
	payload: Uint8Array;
	ordinal: number;
	recordOffset: number;
	payloadOffset: number;
}

function align8(value: number): number {
	return Math.ceil(value / ALIGNMENT) * ALIGNMENT;
}

function assertSafeInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} exceeds JavaScript's safe integer range`);
}

/** Encode a model catalog without sorting or mutating its provider/model entries. */
export function encodeModelCatalog(models: Readonly<Record<string, unknown>>): Uint8Array {
	const encoder = new TextEncoder();
	const providers: EncodedProvider[] = [];
	let indexEnd = HEADER_BYTES;
	let ordinal = 0;
	for (const [provider, modelsForProvider] of Object.entries(models)) {
		const name = encoder.encode(provider);
		if (name.byteLength > 0xffff) throw new RangeError(`Provider name exceeds 65,535 UTF-8 bytes: ${provider}`);
		const payload = encoder.encode(JSON.stringify(modelsForProvider));
		assertSafeInteger(payload.byteLength, `Payload length for provider ${provider}`);
		const recordOffset = indexEnd;
		indexEnd = align8(indexEnd + INDEX_FIXED_BYTES + name.byteLength);
		assertSafeInteger(indexEnd, "Catalog index size");
		providers.push({ name, payload, ordinal, recordOffset, payloadOffset: 0 });
		ordinal += 1;
	}

	const payloadSectionOffset = align8(indexEnd);
	assertSafeInteger(payloadSectionOffset, "Payload section offset");
	let fileLength = payloadSectionOffset;
	for (const provider of providers) {
		provider.payloadOffset = fileLength;
		assertSafeInteger(provider.payloadOffset, `Payload offset for provider ordinal ${provider.ordinal}`);
		fileLength += provider.payload.byteLength;
		assertSafeInteger(fileLength, "Catalog file length");
		if (provider.ordinal + 1 < providers.length) fileLength = align8(fileLength);
	}

	const bytes = new Uint8Array(fileLength);
	bytes.set(MAGIC, 0);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	view.setUint32(8, MODEL_CATALOG_SCHEMA_VERSION, true);
	view.setUint32(12, providers.length, true);
	view.setBigUint64(16, BigInt(payloadSectionOffset), true);
	for (const provider of providers) {
		const offset = provider.recordOffset;
		view.setUint16(offset, provider.name.byteLength, true);
		view.setUint16(offset + 2, 0, true);
		view.setUint32(offset + 4, provider.ordinal, true);
		view.setBigUint64(offset + 8, BigInt(provider.payloadOffset), true);
		view.setBigUint64(offset + 16, BigInt(provider.payload.byteLength), true);
		bytes.set(provider.name, offset + INDEX_FIXED_BYTES);
		bytes.set(provider.payload, provider.payloadOffset);
	}
	return bytes;
}
