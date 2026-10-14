import { describe, expect, it } from "vitest"
import { isHoneyResponse, NODE_OUTBOUND, rawBodyOf } from "./builder.ts"
import { rangeResponse, type RangeBody, type RangeSource } from "./range.ts"

const TEN = new TextEncoder().encode("0123456789")

/** A seekable source over `bytes` that records the slices asked of it. */
function source(bytes: Uint8Array<ArrayBuffer>): RangeSource & { slices: [number, number][] } {
	const slices: [number, number][] = []
	return {
		size: bytes.byteLength,
		slice(start, endInclusive) {
			slices.push([start, endInclusive])
			return new Blob([bytes.subarray(start, endInclusive + 1)]).stream()
		},
		slices,
	}
}

function get(range?: string, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers)
	if (range !== undefined) headers.set("range", range)
	return new Request("http://h/file", { ...init, headers })
}

async function answer(response: Response) {
	return {
		body: await response.text(),
		length: response.headers.get("content-length"),
		range: response.headers.get("content-range"),
		status: response.status,
	}
}

describe("rangeResponse: one satisfiable range is 206 Partial Content", () => {
	it.each([
		["bytes=0-3", "0123", "bytes 0-3/10"],
		["bytes=7-", "789", "bytes 7-9/10"],
		["bytes=-3", "789", "bytes 7-9/10"],
		["bytes=8-100", "89", "bytes 8-9/10"],
		["bytes=0-0", "0", "bytes 0-0/10"],
		["bytes=-20", "0123456789", "bytes 0-9/10"],
		["Bytes=2-4", "234", "bytes 2-4/10"],
	])("%s → %j with %s", async (range, body, contentRange) => {
		expect(await answer(rangeResponse(get(range), TEN))).toEqual({
			body,
			length: String(body.length),
			range: contentRange,
			status: 206,
		})
	})

	it.each([
		["a Uint8Array", () => TEN],
		["a Blob", () => new Blob([TEN])],
		["a seekable source", () => source(TEN)],
	] as const)("the same answer from %s", async (_kind, body: () => RangeBody) => {
		expect(await answer(rangeResponse(get("bytes=2-5"), body()))).toEqual({
			body: "2345",
			length: "4",
			range: "bytes 2-5/10",
			status: 206,
		})
	})

	it("asks a seekable source only for the bytes the range names", async () => {
		const seekable = source(TEN)
		await rangeResponse(get("bytes=3-4"), seekable).text()
		await rangeResponse(get(), seekable).text()
		expect(seekable.slices).toEqual([
			[3, 4],
			[0, 9],
		])
	})
})

describe("rangeResponse: a range past the end is 416 Range Not Satisfiable", () => {
	it.each([
		["bytes=10-", TEN],
		["bytes=10-20", TEN],
		["bytes=-0", TEN],
		["bytes=0-", new Uint8Array(0)],
		["bytes=-5", new Uint8Array(0)],
	])("%s on %#", async (range, body) => {
		const response = rangeResponse(get(range), body)
		expect([response.status, response.headers.get("content-range"), await response.text()]).toEqual([
			416,
			`bytes */${body.byteLength}`,
			"",
		])
	})
})

describe("rangeResponse: anything else is the whole body, 200", () => {
	it.each([
		["no Range header", get()],
		["several ranges (no multipart/byteranges)", get("bytes=0-1,3-4")],
		["another unit", get("items=0-1")],
		["a range that ends before it starts", get("bytes=5-2")],
		["no positions", get("bytes=-")],
		["nothing after the unit", get("bytes=")],
		["letters for a position", get("bytes=a-b")],
		["whitespace inside the range", get("bytes = 2 - 4")],
		["a position longer than 15 digits", get("bytes=1234567890123456-")],
		["a suffix longer than 15 digits", get("bytes=-1234567890123456")],
		["an If-Range validator (honored once A4 adds them)", get("bytes=0-3", { headers: { "if-range": '"v1"' } })],
		["a method range handling is not defined for", get("bytes=0-3", { body: "x", method: "POST" })],
		["HEAD, as RFC 9110 defines ranges for GET only", get("bytes=0-3", { method: "HEAD" })],
	])("%s", async (_case, request) => {
		const response = rangeResponse(request, TEN)
		const body = request.method === "HEAD" ? "" : "0123456789"
		expect(await answer(response)).toEqual({ body, length: "10", range: null, status: 200 })
	})
})

describe("rangeResponse: headers", () => {
	it("says Accept-Ranges: bytes on a 200 and a 206", () => {
		expect(
			[rangeResponse(get(), TEN), rangeResponse(get("bytes=0-1"), TEN)].map((r) => r.headers.get("accept-ranges")),
		).toEqual(["bytes", "bytes"])
	})

	it.each([
		["octet-stream for bytes", TEN, undefined, "application/octet-stream"],
		["a Blob's own type", new Blob([TEN], { type: "video/mp4" }), undefined, "video/mp4"],
		["octet-stream for an untyped Blob", new Blob([TEN]), undefined, "application/octet-stream"],
		["the given type over both", new Blob([TEN], { type: "video/mp4" }), "video/webm", "video/webm"],
	] as const)("content-type: %s", (_case, body: RangeBody, contentType, expected) => {
		expect(rangeResponse(get("bytes=0-1"), body, { contentType }).headers.get("content-type")).toBe(expected)
	})

	it("keeps the headers it is given beside its own", () => {
		const response = rangeResponse(get("bytes=0-1"), TEN, { headers: { "cache-control": "max-age=60", etag: '"v1"' } })
		expect([response.headers.get("cache-control"), response.headers.get("etag"), response.status]).toEqual([
			"max-age=60",
			'"v1"',
			206,
		])
	})
})

describe("rangeResponse: on the Node bridge every answer is a HoneyResponse (the plain-path pin)", () => {
	function nodeGet(range?: string, method = "GET"): Request {
		const request = get(range, { method })
		Object.defineProperty(request, NODE_OUTBOUND, { value: true })
		return request
	}

	it.each([
		{ body: "234", kind: "bytes", name: "a 206 of bytes", range: "bytes=2-4", status: 206 },
		{ body: "789", kind: "blob", name: "a 206 of a Blob", range: "bytes=7-", status: 206 },
		{ body: "", kind: "bytes", name: "a 416", range: "bytes=50-", status: 416 },
		{ body: "0123456789", kind: "bytes", name: "a whole 200 of bytes", range: undefined, status: 200 },
		{ body: "0123456789", kind: "blob", name: "a whole 200 of a Blob", range: undefined, status: 200 },
	])("$name", async ({ body, kind, range, status }) => {
		const res = rangeResponse(nodeGet(range), kind === "blob" ? new Blob([TEN]) : TEN, {
			headers: { "Cache-Control": "max-age=60" },
		})
		expect([
			isHoneyResponse(res),
			res.status,
			await res.text(),
			res.headers.get("cache-control"),
			res.headers.get("accept-ranges"),
		]).toEqual([true, status, body, "max-age=60", "bytes"])
	})

	it("a range source that hands out a stream streams it", async () => {
		const streaming: RangeSource = {
			size: 10,
			slice: (start, end) => new Blob([TEN.subarray(start, end + 1)]).stream(),
		}
		const res = rangeResponse(nodeGet("bytes=1-2"), streaming)
		expect([isHoneyResponse(res), res.status, await res.text()]).toEqual([true, 206, "12"])
	})

	it("a HEAD is a bodiless HoneyResponse with the length a GET would send", () => {
		const res = rangeResponse(nodeGet(undefined, "HEAD"), TEN)
		expect([isHoneyResponse(res), res.body, res.headers.get("content-length")]).toEqual([true, null, "10"])
	})

	it("a whole body of bytes keeps them as its raw body, there as off the bridge", () => {
		expect([rawBodyOf(rangeResponse(nodeGet(), TEN)), rawBodyOf(rangeResponse(get(), TEN))]).toEqual([TEN, TEN])
	})
})
