import { describe, expect, it } from "vitest"
import {
	bufferedAmountOf,
	DEFAULT_BACKPRESSURE_LIMIT,
	DEFAULT_IDLE_TIMEOUT,
	DEFAULT_MAX_PAYLOAD,
	exceedsPayload,
	offeredProtocols,
	resolveWSOptions,
	selectProtocol,
	sendableCloseCode,
	toArrayBuffer,
	truncateUtf8,
} from "./shared.ts"

const protocol = () => "x"

/** Options whose protocol chooser answers `pick`. */
const choose = (pick: string | null | undefined) => resolveWSOptions({ protocol: () => pick })

const offering = (protocols?: string) =>
	new Request("http://h/ws", { headers: protocols === undefined ? {} : { "sec-websocket-protocol": protocols } })

describe("resolveWSOptions: one meaning and one default on every runtime", () => {
	it("fills the defaults: 1 MiB payload, 8 MiB backpressure that closes, 120 s idle, the first protocol offered", () => {
		const resolved = resolveWSOptions(undefined)
		expect({ ...resolved, protocol: resolved.protocol(["a", "b"], offering()) }).toEqual({
			backpressureLimit: DEFAULT_BACKPRESSURE_LIMIT,
			backpressurePolicy: "close",
			idleTimeout: DEFAULT_IDLE_TIMEOUT,
			maxPayload: DEFAULT_MAX_PAYLOAD,
			protocol: "a",
		})
		expect([DEFAULT_MAX_PAYLOAD, DEFAULT_BACKPRESSURE_LIMIT, DEFAULT_IDLE_TIMEOUT]).toEqual([
			1024 * 1024,
			8 * 1024 * 1024,
			120_000,
		])
	})

	it("keeps what it is given, 0 included where 0 means off", () => {
		expect(
			resolveWSOptions({ backpressureLimit: 0, backpressurePolicy: "drop", idleTimeout: 0, maxPayload: 10, protocol }),
		).toEqual({ backpressureLimit: 0, backpressurePolicy: "drop", idleTimeout: 0, maxPayload: 10, protocol })
	})

	it.each([
		[{ maxPayload: -1 }, "maxPayload must be a non-negative number"],
		[{ maxPayload: 0 }, "maxPayload must be positive"],
		[{ backpressureLimit: Number.NaN }, "backpressureLimit must be a non-negative number"],
		[{ idleTimeout: Number.POSITIVE_INFINITY }, "idleTimeout must be a non-negative number"],
		[{ idleTimeout: "5" as unknown as number }, "idleTimeout must be a non-negative number"],
		[{ backpressurePolicy: "block" as "drop" }, 'backpressurePolicy must be "close" or "drop"'],
	])("refuses %j", (options, message) => {
		expect(() => resolveWSOptions(options)).toThrow(message)
	})
})

describe("subprotocols", () => {
	it.each([
		[undefined, []],
		["chat", ["chat"]],
		[" chat , superchat ,, ", ["chat", "superchat"]],
	])("offered %j → %j", (header, list) => {
		expect(offeredProtocols(offering(header))).toEqual(list)
	})

	it("answers the one chosen when the client offered it, otherwise none", () => {
		expect([
			selectProtocol(offering("a, b"), resolveWSOptions(undefined)),
			selectProtocol(offering("a, b"), choose("b")),
			selectProtocol(offering("a, b"), choose("c")),
			selectProtocol(offering("a, b"), choose(null)),
			selectProtocol(offering("a, b"), choose(undefined)),
			selectProtocol(offering(), choose("a")),
		]).toEqual(["a", "b", null, null, null, null])
	})
})

describe("payload size and bytes", () => {
	it.each([
		["a short string", "abc", 3, false],
		["a string with more units than the limit", "abcd", 3, true],
		["a string whose UTF-8 bytes pass the limit", "é".repeat(3), 5, true],
		["a string whose UTF-8 bytes fit", "é".repeat(2), 5, false],
		["bytes over", new Uint8Array(6), 5, true],
		["an ArrayBuffer within", new ArrayBuffer(5), 5, false],
		["a Blob over", new Blob(["123456"]), 5, true],
	])("%s", (_case, data, limit, over) => {
		expect(exceedsPayload(data, limit)).toBe(over)
	})

	it("toArrayBuffer gives exactly the view's bytes, the buffer itself when the view covers it", () => {
		const whole = new Uint8Array([1, 2, 3])
		const part = new Uint8Array(whole.buffer, 1, 2)
		const raw = new ArrayBuffer(2)
		expect([
			toArrayBuffer(whole) === whole.buffer,
			[...new Uint8Array(toArrayBuffer(part))],
			toArrayBuffer(raw) === raw,
		]).toEqual([true, [2, 3], true])
	})

	it("bufferedAmountOf reads either runtime's spelling, 0 when there is none", () => {
		expect([
			bufferedAmountOf({ bufferedAmount: 7 }),
			bufferedAmountOf({ getBufferedAmount: () => 9 }),
			bufferedAmountOf({ getBufferedAmount: () => "9" }),
			bufferedAmountOf({ bufferedAmount: "7" }),
			bufferedAmountOf(null),
			bufferedAmountOf("socket"),
		]).toEqual([7, 9, 0, 0, 0, 0])
	})
})

describe("close frames", () => {
	it.each([
		[undefined, 1000],
		[1000, 1000],
		[1001, 1001],
		[1011, 1011],
		[1014, 1014],
		[1004, 1000],
		[1005, 1000],
		[1006, 1000],
		[1015, 1000],
		[2000, 1000],
		[3000, 3000],
		[4999, 4999],
		[5000, 1000],
	])("code %s is sent as %i", (code, sent) => {
		expect(sendableCloseCode(code)).toBe(sent)
	})

	it.each([
		["a short reason", "bye", 123, "bye"],
		["ASCII past the limit", "x".repeat(130), 123, "x".repeat(123)],
		["multi-byte text, cut on a code point", "é".repeat(70), 123, "é".repeat(61)],
		["an emoji that would not fit whole", `${"x".repeat(121)}🍯`, 123, "x".repeat(121)],
		["text whose units overstate its bytes", "é".repeat(50), 123, "é".repeat(50)],
	])("truncateUtf8: %s", (_case, reason, max, cut) => {
		const out = truncateUtf8(reason, max)
		expect([out, new TextEncoder().encode(out).byteLength <= max]).toEqual([cut, true])
	})
})
