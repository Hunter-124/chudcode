/**
 * Minimal D-Bus session-bus client — just enough wire protocol to hold a
 * `org.freedesktop.ScreenSaver.Inhibit` lock for the lifetime of a socket.
 *
 * Why hand-rolled instead of a binding or a CLI:
 * - There is no D-Bus binding in this repo, and adding one is out of scope.
 * - `gdbus call` / `busctl call` cannot hold a screensaver lock: the cookie
 *   returned by `Inhibit` is owned by the *calling connection*, so the lock is
 *   dropped the instant the CLI process exits. Holding requires a connection
 *   that outlives the call, which means speaking the protocol ourselves.
 * - The subset needed is tiny: EXTERNAL auth, `Hello`, one `(ss) -> u` call and
 *   one `(u) -> ()` call. No file-descriptor passing, no signals, no arrays.
 *
 * Connection-scoped ownership is also the safety property we want: if omp dies
 * for any reason (including SIGKILL), the kernel closes the socket and the bus
 * drops the inhibition. Nothing can leak.
 */

import * as os from "node:os";

/** Message type byte at header offset 1. */
const MSG_METHOD_CALL = 1;
const MSG_METHOD_RETURN = 2;
const MSG_ERROR = 3;

/** Header field codes (`a(yv)` at header offset 12). */
const FIELD_PATH = 1;
const FIELD_INTERFACE = 2;
const FIELD_MEMBER = 3;
const FIELD_ERROR_NAME = 4;
const FIELD_REPLY_SERIAL = 5;
const FIELD_DESTINATION = 6;
const FIELD_SIGNATURE = 8;

/** Fixed header is 12 bytes, then a u32 length prefix for the field array. */
const FIXED_HEADER_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Values this client can marshal/unmarshal. Deliberately basic types only. */
export type DBusValue = string | number;

/** Growable little-endian writer with D-Bus alignment rules. */
class Marshaller {
	#buf = new Uint8Array(256);
	#len = 0;

	get length(): number {
		return this.#len;
	}

	bytes(): Uint8Array {
		return this.#buf.subarray(0, this.#len);
	}

	#ensure(extra: number): void {
		const need = this.#len + extra;
		if (need <= this.#buf.length) return;
		let cap = this.#buf.length;
		while (cap < need) cap *= 2;
		const next = new Uint8Array(cap);
		next.set(this.#buf.subarray(0, this.#len));
		this.#buf = next;
	}

	/** Pad with NULs until the cursor is a multiple of `boundary`. */
	align(boundary: number): void {
		const pad = (boundary - (this.#len % boundary)) % boundary;
		if (pad === 0) return;
		this.#ensure(pad);
		this.#buf.fill(0, this.#len, this.#len + pad);
		this.#len += pad;
	}

	byte(value: number): void {
		this.#ensure(1);
		this.#buf[this.#len++] = value & 0xff;
	}

	u32(value: number): void {
		this.align(4);
		this.#ensure(4);
		const view = new DataView(this.#buf.buffer, this.#buf.byteOffset + this.#len, 4);
		view.setUint32(0, value >>> 0, true);
		this.#len += 4;
	}

	raw(data: Uint8Array): void {
		this.#ensure(data.length);
		this.#buf.set(data, this.#len);
		this.#len += data.length;
	}

	/** `s` / `o`: u32 byte length, UTF-8 payload, NUL terminator. */
	string(value: string): void {
		const data = encoder.encode(value);
		this.u32(data.length);
		this.raw(data);
		this.byte(0);
	}

	/** `g`: single-byte length, payload, NUL terminator. */
	signature(value: string): void {
		const data = encoder.encode(value);
		this.byte(data.length);
		this.raw(data);
		this.byte(0);
	}
}

/** Little-endian reader with D-Bus alignment rules. */
class Unmarshaller {
	#view: DataView;
	#pos = 0;

	constructor(private readonly buf: Uint8Array) {
		this.#view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}

	get position(): number {
		return this.#pos;
	}

	seek(offset: number): void {
		this.#pos = offset;
	}

	align(boundary: number): void {
		this.#pos += (boundary - (this.#pos % boundary)) % boundary;
	}

	byte(): number {
		const value = this.buf[this.#pos];
		if (value === undefined) throw new Error("d-bus: truncated message");
		this.#pos += 1;
		return value;
	}

	u32(): number {
		this.align(4);
		if (this.#pos + 4 > this.buf.length) throw new Error("d-bus: truncated message");
		const value = this.#view.getUint32(this.#pos, true);
		this.#pos += 4;
		return value;
	}

	string(): string {
		const len = this.u32();
		if (this.#pos + len + 1 > this.buf.length) throw new Error("d-bus: truncated message");
		const value = decoder.decode(this.buf.subarray(this.#pos, this.#pos + len));
		this.#pos += len + 1;
		return value;
	}

	signature(): string {
		const len = this.byte();
		if (this.#pos + len + 1 > this.buf.length) throw new Error("d-bus: truncated message");
		const value = decoder.decode(this.buf.subarray(this.#pos, this.#pos + len));
		this.#pos += len + 1;
		return value;
	}

	/** Read one basic value of `type`. Container types are unsupported by design. */
	basic(type: string): DBusValue {
		switch (type) {
			case "y":
				return this.byte();
			case "b":
			case "u":
			case "i":
			case "h":
				return this.u32();
			case "s":
			case "o":
				return this.string();
			case "g":
				return this.signature();
			default:
				throw new Error(`d-bus: unsupported type '${type}'`);
		}
	}
}

/** A parsed inbound D-Bus message, limited to what this client consumes. */
interface DBusMessage {
	type: number;
	replySerial: number | undefined;
	errorName: string | undefined;
	signature: string;
	body: Uint8Array;
}

/**
 * Serialize a METHOD_CALL. `body` must already be marshalled relative to offset
 * 0 — the body always starts on an 8-byte boundary, so relative and absolute
 * alignment agree.
 */
function encodeMethodCall(call: {
	serial: number;
	destination: string;
	path: string;
	iface: string;
	member: string;
	signature: string;
	body: Uint8Array;
}): Uint8Array {
	// The field array starts at offset 16, which is 8-aligned, so a fresh
	// marshaller reproduces the message-relative alignment exactly.
	const fields = new Marshaller();
	// `y v` structs: 8-align, field code, variant signature, then the value
	// marshalled as that signature demands (`s`/`o` carry a u32 length, `g` a byte).
	const stringField = (code: number, sig: "s" | "o", value: string): void => {
		fields.align(8);
		fields.byte(code);
		fields.signature(sig);
		fields.string(value);
	};
	stringField(FIELD_PATH, "o", call.path);
	stringField(FIELD_INTERFACE, "s", call.iface);
	stringField(FIELD_MEMBER, "s", call.member);
	stringField(FIELD_DESTINATION, "s", call.destination);
	if (call.signature) {
		fields.align(8);
		fields.byte(FIELD_SIGNATURE);
		fields.signature("g");
		fields.signature(call.signature);
	}

	const out = new Marshaller();
	out.byte(0x6c); // 'l' — little endian
	out.byte(MSG_METHOD_CALL);
	out.byte(0); // flags
	out.byte(1); // protocol version
	out.u32(call.body.length);
	out.u32(call.serial);
	out.u32(fields.length);
	out.raw(fields.bytes());
	out.align(8);
	out.raw(call.body);
	return out.bytes();
}

/** Parse one complete message; returns undefined when more bytes are needed. */
function decodeMessage(buf: Uint8Array): { message: DBusMessage; consumed: number } | undefined {
	if (buf.length < FIXED_HEADER_BYTES + 4) return undefined;
	if (buf[0] !== 0x6c) throw new Error("d-bus: big-endian messages are not supported");
	const reader = new Unmarshaller(buf);
	reader.seek(1);
	const type = reader.byte();
	reader.byte(); // flags
	reader.byte(); // protocol version
	const bodyLength = reader.u32();
	reader.u32(); // serial
	const fieldsLength = reader.u32();

	const fieldsStart = reader.position;
	const bodyStart = fieldsStart + fieldsLength + ((8 - ((fieldsStart + fieldsLength) % 8)) % 8);
	const total = bodyStart + bodyLength;
	if (buf.length < total) return undefined;

	let replySerial: number | undefined;
	let errorName: string | undefined;
	let signature = "";
	while (reader.position < fieldsStart + fieldsLength) {
		reader.align(8);
		const code = reader.byte();
		const variantSig = reader.signature();
		const value = reader.basic(variantSig);
		if (code === FIELD_REPLY_SERIAL && typeof value === "number") replySerial = value;
		else if (code === FIELD_ERROR_NAME && typeof value === "string") errorName = value;
		else if (code === FIELD_SIGNATURE && typeof value === "string") signature = value;
	}

	return {
		message: { type, replySerial, errorName, signature, body: buf.subarray(bodyStart, total) },
		consumed: total,
	};
}

/** Extract `unix:path=` (or `unix:abstract=`) from a bus address string. */
export function parseDBusUnixPath(address: string | undefined): string | undefined {
	if (!address) return undefined;
	for (const entry of address.split(";")) {
		if (!entry.startsWith("unix:")) continue;
		for (const pair of entry.slice("unix:".length).split(",")) {
			const eq = pair.indexOf("=");
			if (eq < 0) continue;
			const key = pair.slice(0, eq);
			const value = pair.slice(eq + 1);
			// Abstract sockets are Linux-only and Bun's `unix:` option cannot
			// address them; skip rather than connect to a bogus filesystem path.
			if (key === "path" && value) return value;
		}
	}
	return undefined;
}

/**
 * A live session-bus connection. One outstanding call at a time is enough for
 * this client, so calls are serialized through a single pending-reply slot.
 */
export class DBusSessionConnection {
	#socket: Bun.Socket<undefined>;
	#inbound = new Uint8Array(0);
	#serial = 1;
	#pending: { serial: number; resolvers: PromiseWithResolvers<DBusMessage> } | undefined;
	#closed = false;
	#authLine: PromiseWithResolvers<string> | undefined;
	#authMode = true;

	constructor(socket: Bun.Socket<undefined>) {
		this.#socket = socket;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Connect + EXTERNAL auth + `Hello`. Rejects when any step fails. */
	static async open(socketPath: string): Promise<DBusSessionConnection> {
		const ready = Promise.withResolvers<DBusSessionConnection>();
		let connection: DBusSessionConnection | undefined;
		const socket = await Bun.connect<undefined>({
			unix: socketPath,
			socket: {
				open() {
					/* resolved below via the awaited connect */
				},
				data(_socket, data) {
					connection?.ingest(new Uint8Array(data));
				},
				close() {
					connection?.markClosed();
				},
				error(_socket, error) {
					connection?.markClosed(error);
					ready.reject(error);
				},
			},
		});
		connection = new DBusSessionConnection(socket);
		ready.resolve(connection);
		await connection.#authenticate();
		await connection.call({
			destination: "org.freedesktop.DBus",
			path: "/org/freedesktop/DBus",
			iface: "org.freedesktop.DBus",
			member: "Hello",
			signature: "",
			args: [],
		});
		return connection;
	}

	/** Feed inbound bytes; drives the auth line reader then the message parser. */
	ingest(chunk: Uint8Array): void {
		const merged = new Uint8Array(this.#inbound.length + chunk.length);
		merged.set(this.#inbound);
		merged.set(chunk, this.#inbound.length);
		this.#inbound = merged;

		if (this.#authMode) {
			const text = decoder.decode(this.#inbound);
			const end = text.indexOf("\r\n");
			if (end < 0) return;
			const line = text.slice(0, end);
			this.#inbound = this.#inbound.subarray(encoder.encode(text.slice(0, end + 2)).length);
			this.#authLine?.resolve(line);
			this.#authLine = undefined;
			return;
		}

		for (;;) {
			let parsed: { message: DBusMessage; consumed: number } | undefined;
			try {
				parsed = decodeMessage(this.#inbound);
			} catch (error) {
				this.markClosed(error);
				return;
			}
			if (!parsed) return;
			this.#inbound = this.#inbound.subarray(parsed.consumed);
			this.#dispatch(parsed.message);
		}
	}

	markClosed(error?: unknown): void {
		if (this.#closed) return;
		this.#closed = true;
		const reason = error ?? new Error("d-bus: connection closed");
		this.#authLine?.reject(reason);
		this.#authLine = undefined;
		this.#pending?.resolvers.reject(reason);
		this.#pending = undefined;
	}

	#dispatch(message: DBusMessage): void {
		const pending = this.#pending;
		if (!pending) return;
		if (message.type !== MSG_METHOD_RETURN && message.type !== MSG_ERROR) return;
		if (message.replySerial !== pending.serial) return;
		this.#pending = undefined;
		if (message.type === MSG_ERROR) {
			pending.resolvers.reject(new Error(message.errorName ?? "d-bus: call failed"));
			return;
		}
		pending.resolvers.resolve(message);
	}

	async #authenticate(): Promise<void> {
		// The NUL byte is the mandatory credentials-passing preamble; EXTERNAL
		// authenticates by the peer uid the kernel already told the bus.
		const uid = process.getuid?.() ?? os.userInfo().uid;
		const uidHex = Buffer.from(String(uid), "ascii").toString("hex");
		this.#authLine = Promise.withResolvers<string>();
		this.#socket.write(new Uint8Array([0]));
		this.#socket.write(encoder.encode(`AUTH EXTERNAL ${uidHex}\r\n`));
		const reply = await this.#authLine.promise;
		if (!reply.startsWith("OK ")) throw new Error(`d-bus: auth rejected (${reply})`);
		this.#socket.write(encoder.encode("BEGIN\r\n"));
		this.#authMode = false;
		// Any bytes already buffered past the auth line are binary messages.
		if (this.#inbound.length > 0) {
			const buffered = this.#inbound;
			this.#inbound = new Uint8Array(0);
			this.ingest(buffered);
		}
	}

	/** Issue a method call and await its reply body values. */
	async call(call: {
		destination: string;
		path: string;
		iface: string;
		member: string;
		signature: string;
		args: readonly DBusValue[];
	}): Promise<DBusValue[]> {
		if (this.#closed) throw new Error("d-bus: connection closed");
		if (this.#pending) throw new Error("d-bus: a call is already in flight");
		const body = new Marshaller();
		let argIndex = 0;
		for (const type of call.signature) {
			const value = call.args[argIndex++];
			if (type === "s") {
				if (typeof value !== "string") throw new Error("d-bus: expected string argument");
				body.align(4);
				body.string(value);
			} else if (type === "u") {
				if (typeof value !== "number") throw new Error("d-bus: expected uint32 argument");
				body.u32(value);
			} else {
				throw new Error(`d-bus: unsupported argument type '${type}'`);
			}
		}

		const serial = ++this.#serial;
		const resolvers = Promise.withResolvers<DBusMessage>();
		this.#pending = { serial, resolvers };
		this.#socket.write(
			encodeMethodCall({
				serial,
				destination: call.destination,
				path: call.path,
				iface: call.iface,
				member: call.member,
				signature: call.signature,
				body: body.bytes(),
			}),
		);
		const reply = await resolvers.promise;
		const reader = new Unmarshaller(reply.body);
		const values: DBusValue[] = [];
		for (const type of reply.signature) values.push(reader.basic(type));
		return values;
	}

	/** Idempotent. Dropping the connection is what releases every lock it owns. */
	close(): void {
		this.markClosed();
		try {
			this.#socket.end();
		} catch {
			/* already gone */
		}
	}
}
