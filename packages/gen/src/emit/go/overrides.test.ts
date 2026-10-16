import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import { compiledSdk, type DrivenSdk } from "./__fixtures__/compiled.ts"
import { check, once, seen } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { generateGoSdk } from "./sdk.ts"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()
const goDescribe = describe.skipIf(!GO)

type Json = Record<string, unknown>

const STRING = { type: "string" }
const json = (schema: Json) => ({ content: { "application/json": { schema } } })
const ITEM = { properties: { id: STRING }, required: ["id"], type: "object" }

/** Doc OVR: an echo, and an item read that can miss; what the per-call overrides act on. */
const OVR: Json = {
	info: { title: "Overrides", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/echo": {
			get: { operationId: "echo.get", responses: { 200: { ...json({ type: "object" }), description: "ok" } } },
		},
		"/items/{id}": {
			get: {
				operationId: "items.get",
				parameters: [{ in: "path", name: "id", required: true, schema: STRING }],
				responses: { 200: { ...json(ITEM), description: "ok" }, 404: { description: "missing" } },
			},
		},
	},
}
const MODULE = "example.com/overrides"

const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const ITEM_GET: Call = { operation: "items.get", params: { id: "i1" }, route: { method: "GET", path: "/items/{id}" } }
const ECHOED = { data: {}, kind: "data", status: 200 }

/* both error modes: a per-call option applies whatever the method returns */
const MODES = [
	["throw", true],
	["safe", false],
] as const

const sdks = new Map<boolean, DrivenSdk>()

/** The SDK for OVR in the given error mode, compiled with the driver once; it must build and vet clean. */
function ovrSdk(throwOnError: boolean): DrivenSdk {
	const sdk = sdks.get(throwOnError) ?? compiledSdk(OVR, { modulePath: MODULE, throwOnError })
	sdks.set(throwOnError, sdk)
	expect({ built: sdk.built, vet: sdk.vet }, sdk.stderr).toEqual({ built: true, vet: [] })
	return sdk
}

/** `calls` run by `sdk` on one client under `setup` against a server answering `replies`. */
async function drive(sdk: DrivenSdk, replies: readonly Reply[], calls: readonly Call[], setup: Setup = {}) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup }, server)
		return { hops: [...server.hops], run }
	})
}

goDescribe("per-call headers (WithHeader) over Config.Headers", () => {
	// v0: d745229932
	it.each(MODES)(
		"a per-call header wins over the config's same name for that call only, the rest inherited (%s)",
		async (_, mode) => {
			const setup: Setup = { headers: { "X-Keep": "k", "X-Trace": "d" } }
			const { hops, run } = await drive(ovrSdk(mode), [], [{ ...ECHO, headers: { "x-trace": "a" } }, ECHO], setup)
			expect(
				{ headers: hops.map((h) => [h.headers["x-trace"], h.headers["x-keep"]]), observed: run.observed },
				run.stderr,
			).toEqual({
				headers: [
					["a", "k"],
					["d", "k"],
				],
				observed: [ECHOED, ECHOED],
			})
		},
		600_000,
	)

	/** A consumer of OVR: WithHeader and WithBaseURL per call, and the Opts struct with no Headers field (F6). */
	const consumer = once(() =>
		check(
			generateGoSdk(OVR, { modulePath: MODULE }).files,
			MODULE,
			`	api := sdk.NewClient(sdk.Config{BaseURL: "http://api.test", HTTPClient: transport, Headers: map[string]string{"X-Trace": "d"}})
	must(api.Echo.Get(ctx, nil, sdk.WithHeader("x-trace", "a"), sdk.WithBaseURL("http://eu.test/v2")))
	must(api.Echo.Get(ctx, nil))
	note("opts.Headers:", strings.Contains(fmt.Sprintf("%#v", sdk.EchoGetOpts{}), "Headers"))`,
		),
	)

	it("WithHeader is the one per-call header path: <Op>Opts has no Headers field", () => {
		const run = consumer()
		expect(seen(run), run.stderr).toEqual({
			built: true,
			out: ["GET http://eu.test/v2/echo x-trace=a", "GET http://api.test/echo x-trace=d", "opts.Headers: false"],
			vet: [],
		})
	}, 600_000)
})

goDescribe("per-call base URL and timeout (WithBaseURL, WithTimeout)", () => {
	it.each(MODES)(
		"a per-call base URL sends that call to the other origin, the next to the config's (%s)",
		async (_, mode) => {
			const { hops, run } = await drive(ovrSdk(mode), [], [{ ...ECHO, origin: "alt" }, ECHO])
			expect({ hops: hops.map((h) => [h.origin, h.url]), observed: run.observed }, run.stderr).toEqual({
				hops: [
					["alt", "/echo"],
					["primary", "/echo"],
				],
				observed: [ECHOED, ECHOED],
			})
		},
		600_000,
	)

	it.each(MODES)(
		"a per-call timeout shorter than the config's ends the call as a timeout (%s)",
		async (_, mode) => {
			const slow: Reply = { delayMs: 1000, json: {}, status: 200 }
			const { hops, run } = await drive(ovrSdk(mode), [slow], [{ ...ECHO, timeoutMs: 50 }], { timeoutMs: 10_000 })
			expect({ hops: hops.length, observed: run.observed }, run.stderr).toEqual({
				hops: 1,
				observed: [{ kind: "timeout" }],
			})
		},
		600_000,
	)

	it.each(MODES)(
		"a per-call timeout <= 0 removes the config's bound for that call only (%s)",
		async (_, mode) => {
			const slow: Reply = { delayMs: 300, json: {}, status: 200 }
			const calls = [{ ...ECHO, timeoutMs: -1 }, ECHO]
			const { hops, run } = await drive(ovrSdk(mode), [slow, slow], calls, { timeoutMs: 100 })
			expect({ hops: hops.length, observed: run.observed }, run.stderr).toEqual({
				hops: 2,
				observed: [ECHOED, { kind: "timeout" }],
			})
		},
		600_000,
	)
})

goDescribe("the raw response (WithResponseInto)", () => {
	it.each(MODES)(
		"stores a 200's status, headers and readable body beside the decoded answer (%s)",
		async (_, mode) => {
			const reply: Reply = { headers: { "x-total": "3" }, json: { id: "i1" }, status: 200 }
			const { hops, run } = await drive(ovrSdk(mode), [reply], [{ ...ITEM_GET, raw: true }])
			expect({ hops: hops.map((h) => h.url), observed: run.observed }, run.stderr).toEqual({
				hops: ["/items/i1"],
				observed: [
					{
						body: '{"id":"i1"}',
						headers: expect.objectContaining({
							"content-length": "11",
							"content-type": "application/json",
							"x-total": "3",
						}),
						kind: "raw",
						status: 200,
					},
				],
			})
		},
		600_000,
	)

	it.each(MODES)(
		"stores an error status's response and its body too (%s)",
		async (_, mode) => {
			const reply: Reply = { headers: { "x-total": "0" }, json: { message: "gone" }, status: 404 }
			const { run } = await drive(ovrSdk(mode), [reply], [{ ...ITEM_GET, raw: true }])
			expect(run.observed, run.stderr).toEqual([
				{
					body: '{"message":"gone"}',
					headers: expect.objectContaining({ "content-type": "application/json", "x-total": "0" }),
					kind: "raw",
					status: 404,
				},
			])
		},
		600_000,
	)
})
