import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import { compiledSdk, type DrivenSdk } from "./__fixtures__/compiled.ts"
import type { GoError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { type Reply, served, type Json as WireJson } from "../shared/__fixtures__/recording-server.ts"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()
const goDescribe = describe.skipIf(!GO)

type Json = Record<string, unknown>

const STRING = { type: "string" }
const NUMBER = { type: "number" }
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })
const ok = (type: string, schema: Json) => ({ 200: { content: { [type]: { schema } }, description: "ok" } })

/** One variant of SHAPE: its `kind` constant beside a number field. */
const variant = (kind: string, field: string): Json => ({
	properties: { kind: { const: kind, type: "string" }, [field]: NUMBER },
	required: ["kind", field],
	type: "object",
})

/** A JSON item under a path param, a map beside a field, a discriminated union, a text answer and a slow one. */
const RESP: Json = {
	components: {
		schemas: {
			Circle: variant("circle", "radius"),
			Item: { properties: { id: STRING, name: STRING }, required: ["id", "name"], type: "object" },
			Labels: { additionalProperties: STRING, properties: { name: STRING }, type: "object" },
			Shape: {
				discriminator: {
					mapping: { circle: "#/components/schemas/Circle", square: "#/components/schemas/Square" },
					propertyName: "kind",
				},
				oneOf: [ref("Circle"), ref("Square")],
			},
			Square: variant("square", "side"),
		},
	},
	info: { title: "Responses", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/items/{id}": {
			get: {
				operationId: "items.get",
				parameters: [{ in: "path", name: "id", required: true, schema: STRING }],
				responses: ok("application/json", ref("Item")),
			},
		},
		"/labels": { get: { operationId: "labels.get", responses: ok("application/json", ref("Labels")) } },
		"/shape": { get: { operationId: "shapes.get", responses: ok("application/json", ref("Shape")) } },
		"/slow": {
			get: {
				operationId: "slow.get",
				responses: ok("application/json", { properties: { ok: { type: "boolean" } }, type: "object" }),
			},
		},
		"/text": { get: { operationId: "text.get", responses: ok("text/plain", STRING) } },
	},
}

/** The call for `operation` at `path` with GET and `params`. */
const get = (operation: string, path: string, params?: Record<string, string>): Call => ({
	operation,
	params,
	route: { method: "GET", path },
})

const ITEM = get("items.get", "/items/{id}", { id: "i1" })
const LABELS = get("labels.get", "/labels")
const SHAPE = get("shapes.get", "/shape")
const SLOW = get("slow.get", "/slow")
const TEXT = get("text.get", "/text")

/** A 200 JSON reply of `json`, and the data the driver observes for it. */
const found = (json: WireJson): Reply => ({ json, status: 200 })
const data = (json: unknown) => ({ data: json, kind: "data", status: 200 })

/** The SDK for RESP compiled with the driver (safe mode for `throwOnError: false`), which must build and vet clean. */
function respSdk(throwOnError?: boolean): DrivenSdk {
	const sdk = compiledSdk(RESP, { modulePath: "example.com/responses", throwOnError })
	expect({ built: sdk.built, vet: sdk.vet }, sdk.stderr).toEqual({ built: true, vet: [] })
	return sdk
}

/** `calls` run by `sdk` against a server answering `replies`, under `script` when given: the run and the hops. */
async function drive(sdk: DrivenSdk, replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: options.setup ?? {} }, server, options.script)
		return { hops: [...server.hops], run }
	})
}
type Options = { readonly script?: Script; readonly setup?: Setup }
type Driven = Awaited<ReturnType<typeof drive>>

/** The `*sdk.` entries of an error's chain: the only ones a test may pin. */
const sdkTypes = (error: GoError | undefined) => error?.chain.filter((type) => type.startsWith("*sdk."))

/** A traced call as these tests pin it: its error's flags, `*sdk.` types, text and origin, and its SDKResult. */
const traced = ({ error, result }: Trace["calls"][number]) => ({
	error: error && {
		canceled: error.canceled,
		deadline: error.deadline,
		sdk: sdkTypes(error),
		text: error.text,
		via: error.via,
	},
	result,
})

/** A decoding run as 41d76e99ed pins it: each call traced, the urls hit, what was observed, the exit status. */
const decoding = ({ hops, run }: Driven) => ({
	calls: run.trace?.calls.map(traced),
	hops: hops.map((h) => h.url),
	observed: run.observed,
	status: run.status,
})

/** A text run as 53cfea9cfa pins it: the accept each hop sent, what was observed, the exit status and why it failed. */
const answered = ({ hops, run }: Driven) => ({
	accept: hops.map((h) => h.headers.accept),
	observed: run.observed,
	status: run.status,
	stderr: run.stderr.trim(),
})

goDescribe("a JSON answer decodes into the operation's type; an undecodable one is the method's error", () => {
	// v0: 41d76e99ed
	it("returns the decoded item, and a truncated JSON body as a decode error in both modes, never as SDKResult.Err", async () => {
		const truncated: Reply = { headers: { "content-type": "application/json" }, status: 200, text: '{"id":' }
		const replies = [found({ id: "i1", name: "one" }), truncated]
		const driven = (sdk: DrivenSdk) => drive(sdk, replies, [ITEM, ITEM], { script: {} })
		const [thrown, safe] = await Promise.all([driven(respSdk()), driven(respSdk(false))])
		/* F5: v0 put an undecodable 2xx into result.Err as a 2xx StatusError; v1 returns it as the error value */
		const undecoded = {
			error: {
				canceled: false,
				deadline: false,
				sdk: [],
				text: expect.stringMatching(/^honey: decode response: /),
				via: "return",
			},
			result: undefined,
		}
		const expected = (first: Trace["calls"][number]["result"]) => ({
			calls: [{ error: undefined, result: first }, undecoded],
			hops: ["/items/i1", "/items/i1"],
			observed: [data({ id: "i1", name: "one" }), null],
			status: 0,
		})
		expect({ safe: decoding(safe), thrown: decoding(thrown) }).toEqual({
			safe: expected({ data: true, ok: true, response: true, status: 200 }),
			thrown: expected(undefined),
		})
	}, 600_000)
})

goDescribe("a decoded answer keeps every member the wire sent", () => {
	// v0: 678ce73756
	it("keeps the additional properties beside a declared field", async () => {
		const labels = { color: "red", name: "x" }
		const { hops, run } = await drive(respSdk(), [found(labels)], [LABELS])
		expect({ hops: hops.map((h) => h.url), observed: run.observed, status: run.status }, run.stderr).toEqual({
			hops: ["/labels"],
			observed: [data(labels)],
			status: 0,
		})
	}, 600_000)

	// v0: c90c86ca85
	it("keeps the variant's own fields under the discriminator, for each variant", async () => {
		const circle = { kind: "circle", radius: 2.5 }
		const square = { kind: "square", side: 3 }
		const { hops, run } = await drive(respSdk(), [found(circle), found(square)], [SHAPE, SHAPE])
		expect({ hops: hops.map((h) => h.url), observed: run.observed, status: run.status }, run.stderr).toEqual({
			hops: ["/shape", "/shape"],
			observed: [data(circle), data(square)],
			status: 0,
		})
	}, 600_000)
})

goDescribe("a text answer is the body as a string, asked for by its media type", () => {
	// v0: 53cfea9cfa
	it("returns a text/plain body verbatim, never JSON-decoded, and sends accept: text/plain, in both modes", async () => {
		const reply: Reply = { headers: { "content-type": "text/plain" }, status: 200, text: '{"a":1}' }
		const driven = (sdk: DrivenSdk) => drive(sdk, [reply], [TEXT])
		const [thrown, safe] = await Promise.all([driven(respSdk()), driven(respSdk(false))])
		/* F1: the method returns (string, error), v0's (*string, error) modernized; safe mode SDKResult[string] */
		const expected = { accept: ["text/plain"], observed: [data('{"a":1}')], status: 0, stderr: "" }
		expect({ safe: answered(safe), thrown: answered(thrown) }).toEqual({ safe: expected, thrown: expected })
	}, 600_000)
})

goDescribe("a call ends when its time is up or its ctx is canceled", () => {
	// v0: d745d904f7
	it("bounds a call by the client timeout: a timeout observed, a deadline error well before the reply", async () => {
		const sdk = respSdk()
		const late: Reply = { delayMs: 2000, json: { ok: true }, status: 200 }
		const setup: Setup = { timeoutMs: 300 }
		const [plain, scripted] = await Promise.all([
			drive(sdk, [late], [SLOW], { setup }),
			drive(sdk, [late], [SLOW], { script: {}, setup }),
		])
		const call = scripted.run.trace?.calls[0]
		expect({
			bounded: (call?.elapsedMs ?? 0) >= 250 && (call?.elapsedMs ?? 1500) < 1500,
			error: call && traced(call).error,
			hops: [plain.hops.length, scripted.hops.length],
			observed: [plain.run.observed, scripted.run.observed],
			status: [plain.run.status, scripted.run.status],
		}).toEqual({
			bounded: true,
			error: { canceled: false, deadline: true, sdk: [], text: expect.any(String), via: "return" },
			hops: [1, 1],
			observed: [[{ kind: "timeout" }], [{ kind: "timeout" }]],
			status: [0, 0],
		})
	}, 600_000)

	// v0: 9a8782c1a9
	it("ends a call whose ctx is canceled in flight with context.Canceled, not a deadline and no honey type", async () => {
		const late: Reply = { delayMs: 2000, json: { ok: true }, status: 200 }
		const script: Script = { calls: [{ cancel: { afterMs: 100 } }] }
		const { hops, run } = await drive(respSdk(), [late], [SLOW], { script })
		const call = run.trace?.calls[0]
		expect({
			error: call && traced(call).error,
			hops: hops.map((h) => h.url),
			observed: run.observed,
			quick: (call?.elapsedMs ?? 1500) < 1500,
			status: run.status,
		}).toEqual({
			error: { canceled: true, deadline: false, sdk: [], text: expect.any(String), via: "return" },
			hops: ["/slow"],
			observed: [null],
			quick: true,
			status: 0,
		})
	}, 600_000)
})
