import { describe, expect, it } from "bun:test";
import {
	BlobStore,
	blobExtensionForImageMimeType,
	externalizeImageData,
	parseBlobRef,
	resolveImageData,
} from "@chudware/coding-agent/session/blob-store";
import { TempDir } from "@chudware/utils";
import * as fsx from "@chudware/utils/fsx";

describe("BlobStore image display paths", () => {
	it("creates an extension-bearing sidecar for image blobs while keeping canonical refs extensionless", async () => {
		using tempDir = TempDir.createSync("@chudcode-blob-store-image-link-");
		const store = new BlobStore(tempDir.path());
		const data = Buffer.from("image-bytes");

		const result = await store.put(data, { extension: "png" });
		expect(result.path.endsWith(result.hash)).toBe(true);
		expect(result.displayPath).toBe(`${result.path}.png`);
		expect(result.ref).toBe(`blob:sha256:${result.hash}`);
		expect(await fsx.readBytes(result.path)).toEqual(new Uint8Array(data));
		expect(await fsx.readBytes(result.displayPath)).toEqual(new Uint8Array(data));
	});

	it("externalizes image data with a mime-derived display extension", async () => {
		using tempDir = TempDir.createSync("@chudcode-blob-store-image-link-");
		const store = new BlobStore(tempDir.path());
		const data = Buffer.from("image-bytes");

		const ref = await externalizeImageData(store, data.toString("base64"), "image/webp");
		const hash = parseBlobRef(ref);

		expect(hash).toBeTruthy();
		expect(await fsx.readBytes(`${tempDir.path()}/${hash}.webp`)).toEqual(new Uint8Array(data));
		expect(await resolveImageData(store, ref)).toBe(data.toString("base64"));
	});

	it("maps common image mime types to clickable file extensions", () => {
		expect(blobExtensionForImageMimeType("image/jpeg")).toBe("jpg");
		expect(blobExtensionForImageMimeType("image/png")).toBe("png");
		expect(blobExtensionForImageMimeType("text/plain")).toBeUndefined();
	});
});
