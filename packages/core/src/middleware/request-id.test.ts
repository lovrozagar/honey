import { describe, expect, it } from "vitest"
import { honey } from "../routing/app.ts"
import { createLogger } from "../telemetry/logger.ts"
import { type InboundTrust, requestId, type RequestIdOptions } from "./request-id.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** GET /t behind requestId(options), answering with the id the handler saw. */
function app(options?: RequestIdOptions) {
	const a = honey<{}>()
	a.use(requestId(options))
		.get("/t")
		.handler((ctx) => ctx.res.json("ok", { seen: ctx.requestId }))
	return a
}

async function answer(options: RequestIdOptions | undefined, headers: Record<string, string> = {}) {
	const res = await app(options).fetch(new Request("https://app.example.com/t", { headers }), {})
	const { seen } = (await res.json()) as { seen: string }
	return { header: res.headers.get(options?.header ?? "x-request-id"), seen }
}

describe("requestId(): a fresh id by default", () => {
	// v0: 2f8b8849d3
	// v0: 9bfc90b010
	// v0: b2ce55e31e
	// v0: 9c9faa5f18
	// v0: 201e56afc1
	it("a UUID on ctx.requestId and echoed on the answer, a new one per request", async () => {
		const [a, b] = [await answer(undefined), await answer(undefined)]
		expect([UUID.test(a.seen), a.header === a.seen, a.seen === b.seen]).toEqual([true, true, false])
	})

	it("an inbound id is never reused unless trusted: a client cannot pick the id", async () => {
		const res = await answer(undefined, { "x-request-id": "client-chosen" })
		expect([UUID.test(res.seen), res.header]).toEqual([true, res.seen])
	})

	// v0: c063cd66cd
	// v0: 3127089ddf
	it("a custom header name and generator", async () => {
		let n = 0
		const res = await answer({ generate: () => `id-${++n}`, header: "x-trace" })
		expect(res).toEqual({ header: "id-1", seen: "id-1" })
	})
})

describe("requestId(): trustInbound reuses a valid inbound id (b1)", () => {
	// v0: 97677afb42 — v1: an inbound id is reused only when trustInbound says so (the trust cut, H23)
	// v0: d1768bf7aa
	// v0: 79572c886d
	it.each<[string, InboundTrust, Record<string, string>, boolean]>([
		["true: always", true, { "x-request-id": "upstream-1" }, true],
		[
			"a predicate on the peer, yes",
			({ req }) => req.headers.get("x-gateway") === "secret",
			{ "x-gateway": "secret", "x-request-id": "upstream-1" },
			true,
		],
		["a predicate on the peer, no", ({ ip }) => ip === "10.0.0.5", { "x-request-id": "upstream-1" }, false],
		["false: never", false, { "x-request-id": "upstream-1" }, false],
	])("%s", async (_name, trustInbound, headers, reused) => {
		const res = await answer({ trustInbound }, headers)
		expect([res.seen === "upstream-1", res.header === res.seen]).toEqual([reused, true])
	})

	// v0: 8424696546
	// v0: e2f0f1b365
	it.each([
		["text no id should hold", "has spaces"],
		["control characters", "a\tb"],
		["an overlong id", "x".repeat(129)],
		["an empty id", ""],
	])("a trusted but unsafe inbound id (%s) is replaced: validation always applies", async (_name, inbound) => {
		const res = await answer({ trustInbound: true }, { "x-request-id": inbound })
		expect(res.seen === inbound).toBe(false)
	})

	it("a custom validate replaces the default one", async () => {
		const res = await answer({ trustInbound: true, validate: (id) => id.startsWith("ok-") }, { "x-request-id": "ok-1" })
		const refused = await answer(
			{ trustInbound: true, validate: (id) => id.startsWith("ok-") },
			{ "x-request-id": "abc" },
		)
		expect([res.seen, refused.seen === "abc"]).toEqual(["ok-1", false])
	})
})

describe("requestId(): everywhere the request goes", () => {
	it("echoed on an error answer, and bound into ctx.log and the request log", async () => {
		const lines: Record<string, unknown>[] = []
		const a = honey<{}>()
			.logger(
				createLogger({
					format: "json",
					level: "info",
					write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
				}),
			)
			.requestLog(true)
		a.use(requestId({ generate: () => "r-1" }))
			.get("/boom")
			.handler((ctx) => {
				ctx.log.info("handling")
				throw new Error("boom")
			})
		const res = await a.fetch(new Request("https://app.example.com/boom"), {})
		await res.text()
		expect([
			res.status,
			res.headers.get("x-request-id"),
			lines.map((line) => [line.msg, line.requestId ?? null]),
		]).toEqual([
			500,
			"r-1",
			[
				["handling", "r-1"],
				["unhandled error", "r-1"],
				["request", "r-1"],
			],
		])
	})
})
