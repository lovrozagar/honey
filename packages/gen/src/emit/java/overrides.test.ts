/**
 * Per-call overrides through the one `RequestOptions` argument (bit 16 phase c1, W4; the C# `overrides.test.ts` port,
 * contract 47 §5.10): `headers` over the config's for that call alone, `timeout` in place of the client's (zero:
 * none), `baseUrl` to another origin, and the `raw` box, filled with the answer as it arrived on success and on error.
 * Driven in both styles of the `http` SDK, its client and its `safe()` mirror (bit 21 i6), on the same client shape,
 * so a per-call override applies whatever the method returns. The raw box's URL after a redirect is a consumer
 * program's leg and is not written here.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether the JDK is here: a missing JDK fails where it is required and skips these legs elsewhere (java-env). */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const ITEM: Call = { operation: "items.get", params: { id: "i1" }, route: { method: "GET", path: "/items/{id}" } }
const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 }

/** The style a leg drives the `http` SDK in: its client, or its `safe()` mirror. */
type Key = "client" | "client.safe()"

/* both error modes: a per-call override applies whatever the method returns */
const MODES = [
	["throw", "client"],
	["safe", "client.safe()"],
] as const

/** The `http` SDK with the driver aimed at it, which must compile. */
function driven(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("http")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** `calls` run in `key`'s style under `setup` against a server answering `replies`, with the hops. */
async function drive(key: Key, replies: readonly Reply[], calls: readonly Call[], setup: Setup = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const run = await sdk.runCalls(
			{ calls, setup },
			{ alt: server.alt, url: server.url },
			{ safe: key === "client.safe()" },
		)
		return { hops: [...server.hops], run }
	})
}

describe.skipIf(!JAVA)("a per-call header (RequestOptions.headers) over the client's headers", SLOW, () => {
	/* port: csharp overrides.test.ts "wins over the config's same name for that call only" */
	it.each(MODES)(
		"wins over the config's same name for that call only, every other config header inherited (%s, %s)",
		async (_, key) => {
			const setup: Setup = { headers: { "X-Keep": "k", "X-Trace": "d" } }
			const calls = [{ ...ECHO, headers: { "x-trace": "a" } }, ECHO]
			const { hops, run } = await drive(key, [OK, OK], calls, setup)
			expect(
				{ headers: hops.map((h) => [h.headers["x-trace"], h.headers["x-keep"]]), observed: run.observed },
				run.stderr,
			).toEqual({
				headers: [
					["a", "k"],
					["d", "k"],
				],
				observed: [OK_DATA, OK_DATA],
			})
		},
	)
})

describe.skipIf(!JAVA)("a per-call timeout (RequestOptions.timeout) in place of the client's", SLOW, () => {
	/* port: csharp overrides.test.ts "ends the call as a timeout when it is shorter"; an unbounded call first, as a cold
	   JVM's first request can outlast 300 ms */
	it.each(MODES)("ends the call as a timeout when it is shorter than the config's (%s, %s)", async (_, key) => {
		const calls = [
			{ ...ECHO, timeoutMs: 0 },
			{ ...ECHO, timeoutMs: 300 },
		]
		const { hops, run } = await drive(key, [OK, { ...OK, delayMs: 2000 }], calls, { timeoutMs: 10_000 })
		expect({ hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			hops: 2,
			observed: [OK_DATA, { kind: "timeout" }],
		})
	})

	/* port: csharp overrides.test.ts "removes the config's bound for that call only when zero" */
	it.each(MODES)(
		"removes the config's bound for that call only when zero, the client untouched (%s, %s)",
		async (_, key) => {
			const slow: Reply = { ...OK, delayMs: 1000 }
			const calls = [{ ...ECHO, timeoutMs: 0 }, ECHO]
			const { hops, run } = await drive(key, [slow, slow], calls, { timeoutMs: 300 })
			expect({ hops: hops.length, observed: run.observed }, run.stderr).toEqual({
				hops: 2,
				observed: [OK_DATA, { kind: "timeout" }],
			})
		},
	)
})

describe.skipIf(!JAVA)("a per-call base URL (RequestOptions.baseUrl)", SLOW, () => {
	/* port: csharp overrides.test.ts "sends that call to the other origin" */
	it.each(MODES)("sends that call to the other origin and the next to the config's (%s, %s)", async (_, key) => {
		const { hops, run } = await drive(key, [OK, OK], [{ ...ECHO, origin: "alt" }, ECHO])
		expect({ hops: hops.map((h) => [h.origin, h.url]), observed: run.observed }, run.stderr).toEqual({
			hops: [
				["alt", "/echo"],
				["primary", "/echo"],
			],
			observed: [OK_DATA, OK_DATA],
		})
	})
})

describe.skipIf(!JAVA)(
	"the raw box (RequestOptions.raw): the answer as it arrived, on success and on error",
	SLOW,
	() => {
		/* port: csharp overrides.test.ts "keeps a 200's status, every header and the body as sent" */
		it.each(MODES)("keeps a 200's status, every header and the body as sent (%s, %s)", async (_, key) => {
			/* items.get declares X-Item-Version as required, so a well-formed 200 carries it */
			const reply: Reply = {
				headers: { "x-item-version": "3", "x-total": "3" },
				json: { id: "i1", name: "n" },
				status: 200,
			}
			const { hops, run } = await drive(key, [reply], [{ ...ITEM, raw: true }])
			expect({ hops: hops.map((h) => h.url), observed: run.observed }, run.stderr).toEqual({
				hops: ["/items/i1"],
				observed: [
					{
						body: '{"id":"i1","name":"n"}',
						headers: expect.objectContaining({
							"content-length": "22",
							"content-type": "application/json",
							"x-total": "3",
						}),
						kind: "raw",
						status: 200,
					},
				],
			})
		})

		/* port: csharp overrides.test.ts "keeps an error status's response and its body too" */
		it.each(MODES)("keeps an error status's response and its body too (%s, %s)", async (_, key) => {
			const reply: Reply = { headers: { "x-total": "0" }, json: { message: "gone" }, status: 404 }
			const { run } = await drive(key, [reply], [{ ...ITEM, raw: true }])
			expect(run.observed, run.stderr).toEqual([
				{
					body: '{"message":"gone"}',
					headers: expect.objectContaining({ "content-type": "application/json", "x-total": "0" }),
					kind: "raw",
					status: 404,
				},
			])
		})
	},
)
