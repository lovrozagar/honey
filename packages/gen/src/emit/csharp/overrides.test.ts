/**
 * Per-call overrides through the one `RequestOptions? options` parameter (contract 47 §5.10, Python's
 * `overrides.test.ts` analog): `Headers` over `ClientConfig.Headers` for that call alone, `Timeout` in place of the
 * client's (zero: none), `BaseUrl` to another origin, and the `Raw` box, filled with the answer as it arrived on
 * success and on error. Driven in both error modes on `http` and `http-safe` on C#'s one async client; the raw
 * box's `Url` after a redirect is a consumer program. Python's mypy `headers=` leg has no C# analog:
 * `RequestOptions` is a type, so a method has no transport parameter to misspell.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, seen } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { type DrivenCSharpSdk, drivenCSharpSdk } from "./__fixtures__/driven.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const ITEM: Call = { operation: "items.get", params: { id: "i1" }, route: { method: "GET", path: "/items/{id}" } }
const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 }

type Key = "http" | "http-safe"

/* both error modes: a per-call override applies whatever the method returns */
const MODES = [
	["throw", "http"],
	["safe", "http-safe"],
] as const

/** The registry SDK `key` with the driver aimed at it, which must build. */
function driven(key: Key): DrivenCSharpSdk {
	const sdk = drivenCSharpSdk(key)
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** `calls` run by `key`'s driver under `setup` against a server answering `replies`, with the hops. */
async function drive(key: Key, replies: readonly Reply[], calls: readonly Call[], setup: Setup = {}) {
	const sdk = driven(key)
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup }, { alt: server.alt, url: server.url })
		return { hops: [...server.hops], run }
	})
}

describe.skipIf(!DOTNET)("a per-call header (RequestOptions.Headers) over the client's headers", SLOW, () => {
	/* ported from python/overrides.test.ts:58 */
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

describe.skipIf(!DOTNET)("a per-call timeout (RequestOptions.Timeout) in place of the client's", SLOW, () => {
	/* ported from python/overrides.test.ts:81; an unbounded call first, as .NET's cold first request can outlast 300 ms */
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

	/* ported from python/overrides.test.ts:91; its unbounded first call warms the client for the bounded second */
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

describe.skipIf(!DOTNET)("a per-call base URL (RequestOptions.BaseUrl)", SLOW, () => {
	/* ported from python/overrides.test.ts:106 */
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

describe.skipIf(!DOTNET)(
	"the raw box (RequestOptions.Raw): the answer as it arrived, on success and on error",
	SLOW,
	() => {
		/* ported from python/overrides.test.ts:119 */
		it.each(MODES)("keeps a 200's status, every header and the body as sent (%s, %s)", async (_, key) => {
			/* items.get declares X-Item-Version as required, so a well-formed 200 carries it (Fc7) */
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

		/* ported from python/overrides.test.ts:144 */
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

/**
 * The `raw` consumer (safe mode): `hop.get` through a same-origin 302 to `/echo` with a raw box, then `echo.get`
 * answered 404 with another; each box read beside the `SdkResult<T>` it came with, its `Url` as text.
 */
const RAW = `Section("raw");
using var c = Client();
var raw = new RawResponse();
var r = await c.Hop.GetAsync(new RequestOptions { Raw = raw });
var body = System.Text.Encoding.UTF8.GetString(raw.Body);
Note($"{raw.Status} {raw.Url} {body} {raw.Headers["content-type"]} {ReferenceEquals(r.Response, raw)} {r.Data?.Ok}");
var gone = new RawResponse();
var e = await c.Echo.GetAsync(new RequestOptions { Raw = gone });
var lost = System.Text.Encoding.UTF8.GetString(gone.Body);
Note($"{gone.Status} {gone.Url} {lost} {ReferenceEquals(e.Response, gone)} {e.Error?.GetType().Name} {e.Data is null}");`

/** RAW's replies: the 302, the answer it lands on, and the 404. */
const RAW_REPLIES: readonly Reply[] = [
	{ redirect: { origin: "primary", path: "/echo" }, status: 302 },
	OK,
	{ json: { message: "gone" }, status: 404 },
]

describe.skipIf(!DOTNET)("RawResponse: the answer's status, headers, body and the URL it came from", SLOW, () => {
	/* ported from python/overrides.test.ts:194 */
	it("is the last hop's after a redirect, the same box the SdkResult holds; an error status fills it too", async () => {
		const { hops, run, url } = await served(RAW_REPLIES, async (server) => {
			const ran = await consume("http-safe", "raw", { base: server.url, body: RAW })
			return { hops: server.hops.map((h) => `${h.origin} ${h.method} ${h.url}`), run: ran, url: server.url }
		})
		expect({ ...seen(run, "raw"), hops }, run.stderr).toEqual({
			hops: ["primary GET /hop", "primary GET /echo", "primary GET /echo"],
			out: [
				`200 ${url}/echo {"ok":true} application/json True True`,
				`404 ${url}/echo {"message":"gone"} True NotFoundException True`,
			],
			ran: true,
		})
	})
})
