/**
 * Per-call overrides through the one keyword-only `options: RequestOptions` (contract 29 §5.9; G3): `headers` over
 * `ClientConfig.headers` for that call alone, `timeout` in place of the client's (zero: none), `base_url` to
 * another origin, and the `raw` box, filled with the answer as it arrived on success and on error. Driven in both
 * error modes on `http` and `http-safe`, every leg on `AsyncSDK` and `SDK` with one expectation (the G17 drift
 * check); the raw box after a redirect is a consumer program, and the missing `headers=` keyword a mypy check.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { checked, consume, once, seen } from "./__fixtures__/consumer.ts"
import { type DrivenPythonSdk, drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }

const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const ITEM: Call = { operation: "items.get", params: { id: "i1" }, route: { method: "GET", path: "/items/{id}" } }
const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 }

type Key = "http" | "http-safe"
type On = { readonly client: Client; readonly key: Key }
type Client = "async" | "sync"

/* both error modes on both clients: a per-call override applies whatever the method returns, on either client */
const GRID = (["async", "sync"] as const).flatMap((client) =>
	(
		[
			["throw", "http"],
			["safe", "http-safe"],
		] as const
	).map(([mode, key]) => [mode, client, key] as const),
)

/** The registry SDK `key` with the driver aimed at it, which must import. */
function driven(key: Key): DrivenPythonSdk {
	const sdk = drivenPythonSdk(key)
	expect(sdk.imported, sdk.stderr).toBe(true)
	return sdk
}

/** `calls` run by `key`'s driver on `client` under `setup` against a server answering `replies`, with the hops. */
async function drive({ client, key }: On, replies: readonly Reply[], calls: readonly Call[], setup: Setup = {}) {
	const sdk = driven(key)
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup }, { alt: server.alt, url: server.url }, { client })
		return { hops: [...server.hops], run }
	})
}

describe.skipIf(!PY)("a per-call header (options['headers']) over the client's headers", SLOW, () => {
	/* G3 as ruled: v0's headers= keyword becomes options["headers"] */
	// v0: f2020cd056
	it.each(GRID)(
		"wins over the config's same name for that call only, every other config header inherited (%s, %s)",
		async (_, client, key) => {
			const setup: Setup = { headers: { "X-Keep": "k", "X-Trace": "d" } }
			const calls = [{ ...ECHO, headers: { "x-trace": "a" } }, ECHO]
			const { hops, run } = await drive({ client, key }, [OK, OK], calls, setup)
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

describe.skipIf(!PY)("a per-call timeout (options['timeout']) in place of the client's", SLOW, () => {
	/* G3 as ruled: v0's timeout= keyword becomes options["timeout"] */
	// v0: 585607242b
	it.each(GRID)("ends the call as a timeout when it is shorter than the config's (%s, %s)", async (_, client, key) => {
		const slow: Reply = { ...OK, delayMs: 1000 }
		const { hops, run } = await drive({ client, key }, [slow], [{ ...ECHO, timeoutMs: 50 }], { timeoutMs: 10_000 })
		expect({ hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			hops: 1,
			observed: [{ kind: "timeout" }],
		})
	})

	// v0: 585607242b
	it.each(GRID)(
		"removes the config's bound for that call only when zero, the client untouched (%s, %s)",
		async (_, client, key) => {
			const slow: Reply = { ...OK, delayMs: 300 }
			const calls = [{ ...ECHO, timeoutMs: 0 }, ECHO]
			const { hops, run } = await drive({ client, key }, [slow, slow], calls, { timeoutMs: 100 })
			expect({ hops: hops.length, observed: run.observed }, run.stderr).toEqual({
				hops: 2,
				observed: [OK_DATA, { kind: "timeout" }],
			})
		},
	)
})

describe.skipIf(!PY)("a per-call base URL (options['base_url'])", SLOW, () => {
	it.each(GRID)("sends that call to the other origin and the next to the config's (%s, %s)", async (_, client, key) => {
		const { hops, run } = await drive({ client, key }, [OK, OK], [{ ...ECHO, origin: "alt" }, ECHO])
		expect({ hops: hops.map((h) => [h.origin, h.url]), observed: run.observed }, run.stderr).toEqual({
			hops: [
				["alt", "/echo"],
				["primary", "/echo"],
			],
			observed: [OK_DATA, OK_DATA],
		})
	})
})

describe.skipIf(!PY)("the raw box (options['raw']): the answer as it arrived, on success and on error", SLOW, () => {
	it.each(GRID)("keeps a 200's status, every header and the body as sent (%s, %s)", async (_, client, key) => {
		/* items.get declares X-Item-Version as required, so a well-formed 200 carries it (Fc5) */
		const reply: Reply = {
			headers: { "x-item-version": "3", "x-total": "3" },
			json: { id: "i1", name: "n" },
			status: 200,
		}
		const { hops, run } = await drive({ client, key }, [reply], [{ ...ITEM, raw: true }])
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

	it.each(GRID)("keeps an error status's response and its body too (%s, %s)", async (_, client, key) => {
		const reply: Reply = { headers: { "x-total": "0" }, json: { message: "gone" }, status: 404 }
		const { run } = await drive({ client, key }, [reply], [{ ...ITEM, raw: true }])
		expect(run.observed, run.stderr).toEqual([
			{
				body: '{"message":"gone"}',
				headers: expect.objectContaining({ "content-type": "application/json", "x-total": "0" }),
				kind: "raw",
				status: 404,
			},
		])
	})
})

/**
 * A safe-mode consumer per client: `hop.get` through a same-origin 302 to `/echo` with a raw box, then `echo.get`
 * answered 404 with another; each box read beside the `SDKResult` it came with.
 */
const RAW = (["sync", "async"] as const)
	.map((client) => {
		const make = client === "sync" ? "client()" : "aclient()"
		const call = client === "sync" ? "" : "await "
		return `section("${client}")
c = ${make}
raw = sdk.RawResponse()
r = ${call}c.hop.get(options={"raw": raw})
kind = {k.lower(): v for k, v in raw.headers.items()}.get("content-type")
note([raw.status, raw.url.endswith("/echo"), json.loads(raw.body), kind, r.response is raw, r.data])
gone = sdk.RawResponse()
e = ${call}c.echo.get(options={"raw": gone})
note([gone.status, json.loads(gone.body), e.response is gone, type(e.error).__name__, e.data])`
	})
	.join("\n")

/** One client's replies to RAW: the 302, the answer it lands on, and the 404. */
const RAW_REPLIES: readonly Reply[] = [
	{ redirect: { origin: "primary", path: "/echo" }, status: 302 },
	OK,
	{ json: { message: "gone" }, status: 404 },
]

/** The `raw` program run once on both clients against RAW_REPLIES twice, with the hops it sent. */
const raw = once(() =>
	served([...RAW_REPLIES, ...RAW_REPLIES], async (server) => {
		const run = await consume("http-safe", "raw", { base: server.url, body: RAW })
		return { hops: server.hops.map((h) => `${h.origin} ${h.method} ${h.url}`), run }
	}),
)

describe.skipIf(!PY)("RawResponse: the answer's status, headers, body and the URL it came from", SLOW, () => {
	it("is the last hop's after a redirect, the same box the SDKResult holds; an error status fills it too", async () => {
		const { hops, run } = await raw()
		const landed = [200, true, { ok: true }, "application/json", true, { ok: true }]
		const failed = [404, { message: "gone" }, true, "NotFoundError", null]
		const sent = ["primary GET /hop", "primary GET /echo", "primary GET /echo"]
		const read = (section: string) => ({
			...seen(run, section),
			out: seen(run, section).out?.map((n) => JSON.parse(n)),
		})
		expect({ async: read("async"), hops, sync: read("sync") }, run.stderr).toEqual({
			async: { out: [landed, failed], ran: true },
			hops: [...sent, ...sent],
			sync: { out: [landed, failed], ran: true },
		})
	})
})

/** The program's lines: a `headers=` keyword next to the `options` that carries them, on both clients. */
const KWARGS = [
	"import honey_sdk as sdk",
	"",
	"c = sdk.SDK()",
	'c.echo.get(headers={"x-trace": "a"})',
	'c.echo.get(options={"base_url": "http://alt", "headers": {"x-trace": "a"}, "raw": sdk.RawResponse(), "timeout": 0.0})',
	"",
	"",
	"async def run(a: sdk.AsyncSDK) -> None:",
	'    await a.echo.get(headers={"x-trace": "a"})',
	'    await a.echo.get(options={"headers": {"x-trace": "a"}, "timeout": None})',
]

describe.skipIf(!PY)("a method takes no transport keyword: options is the one per-call path (G3)", SLOW, () => {
	it("refuses a headers= keyword on both clients under mypy, and takes every RequestOptions member", () => {
		const findings = checked("http", `${KWARGS.join("\n")}\n`).map((line) =>
			line.replace(/^[^:]+:(\d+): error: /, "$1: "),
		)
		const at = (text: string) => KWARGS.indexOf(text) + 1
		expect(findings).toEqual([
			`${at('c.echo.get(headers={"x-trace": "a"})')}: Unexpected keyword argument "headers" for "get" of "EchoResource"  [call-arg]`,
			`${at('    await a.echo.get(headers={"x-trace": "a"})')}: Unexpected keyword argument "headers" for "get" of "AsyncEchoResource"  [call-arg]`,
		])
	})
})
