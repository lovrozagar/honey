import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import { compiledSdk, type DrivenSdk } from "./__fixtures__/compiled.ts"
import type { GoError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { check, once, type Run, seen } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { REFUSED_URL, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { generateGoSdk } from "./sdk.ts"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()
const goDescribe = describe.skipIf(!GO)

type Json = Record<string, unknown>

const STRING = { type: "string" }
const object = (properties: Json, required: string[] = []) => ({ properties, required, type: "object" })

/**
 * One operation declaring error keys: a key per status, an inline non-envelope schema, a key whose
 * exported name collides with another's, and one whose name a runtime sentinel already holds.
 */
const ERR: Json = {
	components: { schemas: { Item: object({ id: STRING, name: STRING }, ["id", "name"]) } },
	info: { title: "Errors", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/items/{id}": {
			get: {
				operationId: "items.get",
				parameters: [{ in: "path", name: "id", required: true, schema: STRING }],
				responses: {
					200: {
						content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } },
						description: "ok",
					},
					404: { description: "not found" },
				},
				"x-honey-errors": {
					"item.locked": { schema: object({ until: STRING }), status: 423 },
					item_locked: { status: 423 },
					item_not_found: { status: 404 },
					"response.too_large": { status: null },
				},
			},
		},
	},
}
const MODULE = "example.com/errs"

const GET: Call = { operation: "items.get", params: { id: "i1" }, route: { method: "GET", path: "/items/{id}" } }

/** The SDK for ERR compiled with the driver, which must build and vet clean. */
function errSdk(): DrivenSdk {
	const sdk = compiledSdk(ERR, { modulePath: MODULE })
	expect({ built: sdk.built, vet: sdk.vet }, sdk.stderr).toEqual({ built: true, vet: [] })
	return sdk
}

/**
 * `calls` run by `sdk` (under `script`, when given; through `client.Safe()` when it says `safe`) against a server
 * answering `replies`: the run and the hops.
 */
function drive(sdk: DrivenSdk, replies: readonly Reply[], calls: readonly Call[], script?: Script & { safe?: true }) {
	const { safe, ...rest } = script ?? {}
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: {} }, server, script && rest, safe)
		return { hops: [...server.hops], run }
	})
}

/** The `*sdk.` entries of an error's chain: the only ones a test may pin. */
const sdkTypes = (error: GoError | undefined) => error?.chain.filter((type) => type.startsWith("*sdk."))

/** Where a safe call's failure landed: its error's route, status, cancellation and `*sdk.` types, and its Result. */
const landed = (call: Trace["calls"][number] | undefined) => {
	const error = call?.error
	return [error?.via, error?.status, error?.canceled, sdkTypes(error), call?.result]
}

/** An error status as the driver observes it, for a `{"message":"m"}` body. */
const failed = (status: number) => ({ body: { message: "m" }, errorKey: null, kind: "error", status })
const answer = (status: number): Reply => ({ json: { message: "m" }, status })

/** ERR's SDK built and vetted with the consumer `body` (importing `imports` too) beside it, run when it builds. */
function consumer(body: string, imports: readonly string[]): Run {
	const { files } = generateGoSdk(ERR, { modulePath: MODULE })
	return check(files, MODULE, body, imports)
}

/** The runtime's error surface: per-status types, the APIError seam, ClientError's members. */
const surface = once(() =>
	consumer(
		`	api := client("http://api.test")
	section("status")
	replies["GET /items/i1"] = reply{status: 404, body: \`{"message":"no such item"}\`}
	_, err := api.Items.Get(ctx, "i1", nil)
	var nf *sdk.NotFoundError
	note(errors.As(err, &nf), nf.Status(), nf.Error())
	var ce *sdk.ClientError
	var st interface{ Status() int }
	note(errors.As(err, &ce), ce.StatusCode, errors.As(err, &st), st.Status())
	raised := sdk.HoneyRaiseForStatus(&http.Response{StatusCode: 404, Header: http.Header{}, Body: http.NoBody}, []byte(\`{"message":"no such item"}\`))
	note(fmt.Sprintf("%T", raised), raised.Error())
	section("envelope")
	raw := \`{"status":422,"error_key":"item.invalid","status_key":"unprocessable_entity","message":"bad","fields":{"name":[{"error_key":"required","message":"is required","path":"name"}]},"success":false,"trace":"t1"}\`
	replies["GET /items/i2"] = reply{status: 422, body: raw}
	_, err = api.Items.Get(ctx, "i2", nil)
	ce = nil
	errors.As(err, &ce)
	reread, _ := io.ReadAll(ce.Response.Body)
	note(ce.StatusCode, ce.Status(), ce.Key, ce.Message, string(ce.Body) == raw, ce.Response.StatusCode, string(reread) == raw)
	env := ce.Envelope
	note(env.Status, env.ErrorKey, env.StatusKey, env.Message, env.Fields["name"][0].Path)
	note(len(env.Extra), string(env.Extra["success"]), string(env.Extra["trace"]))
	replies["GET /items/i3"] = reply{status: 422, body: "oops"}
	_, err = api.Items.Get(ctx, "i3", nil)
	ce = nil
	errors.As(err, &ce)
	note(ce.Message, reflect.ValueOf(ce.Envelope).IsZero(), ce.Key == "", string(ce.Body))`,
		["errors", "reflect"],
	),
)

goDescribe("an error status as a Go error, through the driver", () => {
	// v0: ee1a2245dc
	it("raises the per-status type for each named status, unwrapping to *ClientError, its Status() the code", async () => {
		/* runtime/ts/error.ts:60-70 names these; 429 is RateLimitError, not a STATUS_KEYS spelling */
		const named: [number, string][] = [
			[400, "BadRequest"],
			[401, "Unauthorized"],
			[403, "Forbidden"],
			[404, "NotFound"],
			[409, "Conflict"],
			[422, "UnprocessableEntity"],
			[429, "RateLimit"],
			[500, "InternalServer"],
			[502, "BadGateway"],
			[503, "ServiceUnavailable"],
			[504, "GatewayTimeout"],
		]
		const replies = named.map(([status]) => answer(status))
		const { hops, run } = await drive(
			errSdk(),
			replies,
			named.map(() => GET),
			{},
		)
		const calls = run.trace?.calls ?? []
		expect({
			errors: calls.map((c) => [c.error?.status, c.error?.type, sdkTypes(c.error), c.error?.via]),
			hops: hops.length,
			observed: run.observed,
		}).toEqual({
			errors: named.map(([status, name]) => [
				status,
				`*sdk.${name}Error`,
				[`*sdk.${name}Error`, "*sdk.ClientError"],
				"return",
			]),
			hops: named.length,
			observed: named.map(([status]) => failed(status)),
		})
	}, 600_000)

	// v0: d325c5e9df
	it("raises *ClientError alone for a status no type names: 418 and 410", async () => {
		const { run } = await drive(errSdk(), [answer(418), answer(410)], [GET, GET], {})
		const calls = run.trace?.calls ?? []
		expect({
			errors: calls.map((c) => [c.error?.status, c.error?.type, sdkTypes(c.error), c.error?.text]),
			observed: run.observed,
		}).toEqual({
			errors: [
				[418, "*sdk.ClientError", ["*sdk.ClientError"], "HTTP 418: m"],
				[410, "*sdk.ClientError", ["*sdk.ClientError"], "HTTP 410: m"],
			],
			observed: [failed(418), failed(410)],
		})
	}, 600_000)
})

goDescribe("a hostile error body in the error's message", () => {
	// v0: 0c1872f081
	it("drops control characters and caps the message at 512 runes, the raw body kept", async () => {
		const hostile = `\x1b]0;pwned\x07${"x".repeat(2000)}`
		const { run } = await drive(errSdk(), [{ status: 500, text: hostile }], [GET], {})
		const error = run.trace?.calls[0]?.error
		expect({ observed: run.observed, status: error?.status, types: sdkTypes(error) }, run.stderr).toEqual({
			observed: [{ body: hostile, errorKey: null, kind: "error", status: 500 }],
			status: 500,
			types: ["*sdk.InternalServerError", "*sdk.ClientError"],
		})
		/* v0: no ESC and at most 700 bytes; the exact text pins both and the cut */
		expect(error?.text).toBe(`HTTP 500: ]0;pwned${"x".repeat(504)}…`)
	}, 600_000)
})

goDescribe("a context that ends the call: plain context errors, never a ClientError", () => {
	// v0: 793253e0ae
	it("returns context.Canceled for a ctx canceled before the call, nothing sent", async () => {
		/* v0's test named a sentinel ErrContextCanceled that v0 never had; v1 adds none */
		const { hops, run } = await drive(errSdk(), [], [GET], { calls: [{ cancel: "before" }] })
		const error = run.trace?.calls[0]?.error
		expect({
			flags: [error?.canceled, error?.deadline, sdkTypes(error), error?.status],
			hops: hops.length,
			observed: run.observed,
		}).toEqual({ flags: [true, false, [], undefined], hops: 0, observed: [null] })
	}, 600_000)

	// v0: ef9aca90d0
	it("returns context.DeadlineExceeded past a per-call timeout or a caller deadline, observed as a timeout", async () => {
		const sdk = errSdk()
		const late: Reply = { delayMs: 1000, json: { id: "i1", name: "one" }, status: 200 }
		const bounded: Call = { ...GET, timeoutMs: 50 }
		const plain = await drive(sdk, [late], [bounded])
		const scripted = await drive(sdk, [late, late], [bounded, GET], { calls: [null, { ctxTimeoutMs: 50 }] })
		const calls = scripted.run.trace?.calls ?? []
		expect({
			flags: calls.map((c) => [c.error?.deadline, c.error?.canceled, sdkTypes(c.error), c.error?.status]),
			observed: [plain.run.observed, scripted.run.observed],
		}).toEqual({
			flags: [
				[true, false, [], undefined],
				[true, false, [], undefined],
			],
			observed: [[{ kind: "timeout" }], [{ kind: "timeout" }, { kind: "timeout" }]],
		})
	}, 600_000)
})

goDescribe("the safe mirror: an answer in Result.Err, every other failure the error return (bit 21 i3)", () => {
	// v0: 390361417e
	it("puts a 404 in the Result beside its response, and a refused connection in the error return", async () => {
		/* v0's name ("never returns non-nil error") was false in v0 too: a failure with no response is the error return */
		const sdk = errSdk()
		const notFound = await drive(sdk, [answer(404)], [GET], { safe: true })
		const refused = await sdk.runCalls({ calls: [GET], setup: {} }, { url: REFUSED_URL }, {}, true)
		const [found] = notFound.run.trace?.calls ?? []
		const [lost] = refused.trace?.calls ?? []
		expect({
			found: landed(found),
			lost: landed(lost),
			observed: [notFound.run.observed, refused.observed],
		}).toEqual({
			found: [
				"result",
				404,
				false,
				["*sdk.NotFoundError", "*sdk.ClientError"],
				{ data: false, ok: false, response: true, status: 404 },
			],
			lost: ["return", undefined, false, [], undefined],
			/* bit 21 i0: the refused connection's error return is the grid's transport */
			observed: [[failed(404)], [{ kind: "transport" }]],
		})
	}, 600_000)

	it("puts a status with no per-status type (418) in the Result as the base *ClientError, its response beside it", async () => {
		const { run } = await drive(errSdk(), [answer(418)], [GET], { safe: true })
		const [teapot] = run.trace?.calls ?? []
		expect({ landed: landed(teapot), observed: run.observed }).toEqual({
			landed: ["result", 418, false, ["*sdk.ClientError"], { data: false, ok: false, response: true, status: 418 }],
			observed: [failed(418)],
		})
	}, 600_000)
})

goDescribe("the safe mirror's Result, from a consumer program (bit 21 i3)", () => {
	// v0: 8fbcc82ca1
	it("returns Result[*T]: Ok, Data, Err and Response for a 200, a 404 and an undecodable 200, Data nil on an Err", () => {
		const run = consumer(
			`	api := client("http://api.test")
	replies["GET /items/i1"] = reply{status: 200, body: \`{"id":"i1","name":"one"}\`}
	res, err := api.Safe().Items.Get(ctx, "i1", nil)
	var _ sdk.Result[*sdk.Item] = res
	var _ *error = &res.Err
	note(res.Ok(), res.Data.Id, res.Err == nil, res.Response.StatusCode, err == nil)
	replies["GET /items/i2"] = reply{status: 404, body: \`{"message":"no"}\`}
	res, err = api.Safe().Items.Get(ctx, "i2", nil)
	var nf *sdk.NotFoundError
	note(res.Ok(), res.Data == nil, res.Response.StatusCode, errors.As(res.Err, &nf), nf.Message, nf.Response == res.Response, err == nil)
	replies["GET /items/i3"] = reply{status: 200, body: \`{"id":\`}
	res, err = api.Safe().Items.Get(ctx, "i3", nil)
	var de *sdk.DecodeError
	var syntax *json.SyntaxError
	body, _ := io.ReadAll(res.Response.Body)
	note(res.Ok(), res.Data == nil, errors.As(res.Err, &de), de.Response == res.Response, errors.As(res.Err, &syntax), string(body), err == nil)
	_, err = api.Items.Get(ctx, "i3", nil)
	note(errors.As(err, &de), err.Error())`,
			["errors"],
		)
		expect(seen(run), run.stderr).toEqual({
			built: true,
			out: [
				"GET http://api.test/items/i1",
				"true i1 true 200 true",
				"GET http://api.test/items/i2",
				"false true 404 true no true true",
				"GET http://api.test/items/i3",
				'false true true true true {"id": true',
				"GET http://api.test/items/i3",
				"true honey: decode response: unexpected end of JSON input",
			],
			vet: [],
		})
	}, 600_000)
})

goDescribe("the safe mirror: a failure with no answer is the error return, never a Result (bit 21 i3)", () => {
	/* ported from csharp/errors.safe.test.ts:78; an undecodable 2xx is an answer since bit 21 i3 (R-i1), its Err */
	it("puts an undecodable 2xx in the Result, and a timeout, a cancel and a hook throw in the error return", async () => {
		const sdk = errSdk()
		const torn: Reply = { headers: { "content-type": "application/json" }, status: 200, text: '{"id":' }
		const late: Reply = { delayMs: 2000, json: { id: "i1", name: "one" }, status: 200 }
		const calls = [GET, { ...GET, timeoutMs: 300 }, GET]
		const { hops, run } = await drive(sdk, [torn, late], calls, {
			calls: [null, null, { cancel: "before" }],
			safe: true,
		})
		const hooked = await drive(sdk, [], [GET], { hooks: { request: [{ fail: "boom" }] }, safe: true })
		const traces = [run, hooked.run].flatMap((r) => r.trace?.calls ?? [])
		const deadline = run.trace?.calls[1]?.error?.deadline
		expect({
			deadline,
			hops: [hops.length, hooked.hops.length],
			landed: traces.map(landed),
			observed: [run.observed, hooked.run.observed],
		}).toEqual({
			deadline: true,
			hops: [2, 0],
			landed: [
				["result", undefined, false, ["*sdk.DecodeError"], { data: false, ok: false, response: true, status: 200 }],
				["return", undefined, false, [], undefined],
				["return", undefined, true, [], undefined],
				["return", undefined, false, [], undefined],
			],
			/* the undecodable 2xx's Err is the grid's decode; the cancel and the hook throw none */
			observed: [[{ kind: "decode", status: 200 }, { kind: "timeout" }, null], [null]],
		})
	}, 600_000)
})

goDescribe("the runtime's error types, from a consumer program", () => {
	// v0: 473e487f9f
	it("reaches a 404 as *NotFoundError, *ClientError and any Status() int, as HoneyRaiseForStatus raises it", () => {
		const run = surface()
		expect(seen(run, "status"), run.stderr).toEqual({
			built: true,
			out: [
				"GET http://api.test/items/i1",
				"true 404 HTTP 404: no such item",
				"true 404 true 404",
				"*sdk.NotFoundError HTTP 404: no such item",
			],
			vet: [],
		})
	}, 600_000)

	// v0: 6bdeecd5e4
	it("carries the status, key, message, raw body, re-readable response and parsed envelope; a non-JSON body is the message", () => {
		/* G6: v0 passed on the dead StatusErrorMeta's `Status int`; v1 pins StatusCode and Status(), and a typed Envelope where v0 had Data any */
		const run = surface()
		expect(seen(run, "envelope"), run.stderr).toEqual({
			built: true,
			out: [
				"GET http://api.test/items/i2",
				"422 422 item.invalid bad true 422 true",
				"422 item.invalid unprocessable_entity bad name",
				'2 false "t1"',
				"GET http://api.test/items/i3",
				"oops true true oops",
			],
			vet: [],
		})
	}, 600_000)
})

goDescribe("declared error keys: Err<Key> sentinels and <Key>Data bodies", () => {
	it("matches a ClientError by its key with errors.Is, names colliding keys apart, and decodes an inline key schema", () => {
		const run = consumer(
			`	api := client("http://api.test")
	var _ sdk.ErrorKey = sdk.ErrItemNotFound
	var _ error = sdk.ErrItemLocked
	note(string(sdk.ErrItemLocked), string(sdk.ErrItemLocked2), string(sdk.ErrItemNotFound), string(sdk.ErrResponseTooLarge2))
	note(sdk.ErrResponseTooLarge.Error())
	replies["GET /items/i1"] = reply{status: 404, body: \`{"error_key":"item_not_found","message":"gone"}\`}
	_, err := api.Items.Get(ctx, "i1", nil)
	note(errors.Is(err, sdk.ErrItemNotFound), errors.Is(err, sdk.ErrItemLocked), errors.Is(err, sdk.ErrorKey("item_not_found")))
	replies["GET /items/i2"] = reply{status: 404, body: \`{"error_key":"x.y"}\`}
	_, err = api.Items.Get(ctx, "i2", nil)
	note(errors.Is(err, sdk.ErrItemNotFound), errors.Is(err, sdk.ErrorKey("x.y")))
	replies["GET /items/i3"] = reply{status: 423, body: \`{"error_key":"item.locked","until":"2026-10-17"}\`}
	_, err = api.Items.Get(ctx, "i3", nil)
	var ce *sdk.ClientError
	var d sdk.ItemLockedData
	note(errors.As(err, &ce), ce.DecodeBody(&d), *d.Until, errors.Is(err, sdk.ErrItemLocked), errors.Is(err, sdk.ErrItemLocked2))`,
			["errors"],
		)
		expect(seen(run), run.stderr).toEqual({
			built: true,
			out: [
				"item.locked item_locked item_not_found response.too_large",
				"honey: response body exceeds MaxResponseBytes",
				"GET http://api.test/items/i1",
				"true false true",
				"GET http://api.test/items/i2",
				"false true",
				"GET http://api.test/items/i3",
				"true <nil> 2026-10-17 true false",
			],
			vet: [],
		})
	}, 600_000)
})

/** honey's error envelope for one key: a body with this shape is the runtime's ErrorEnvelope, no type of its own. */
const ENVELOPE = {
	properties: {
		error_key: { enum: ["order.closed"], type: "string" },
		fields: {
			additionalProperties: { items: object({ error_key: STRING, message: STRING, path: STRING }), type: "array" },
			type: "object",
		},
		message: STRING,
		status: { enum: [409], type: "integer" },
		status_key: STRING,
		success: { const: false },
	},
	type: "object",
}
const LOCK = { $ref: "#/components/schemas/Lock" }

/** Keys whose schema is the envelope or a component; the second operation re-declares one with an inline schema. */
const KEYED: Json = {
	components: { schemas: { Lock: object({ until: STRING }, ["until"]) } },
	info: { title: "Keyed", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/a": {
			post: {
				operationId: "orders.close",
				responses: { 204: { description: "closed" } },
				"x-honey-errors": {
					"order.closed": { schema: ENVELOPE, status: 409 },
					"order.locked": { schema: LOCK, status: 423 },
				},
			},
		},
		"/b": {
			post: {
				operationId: "orders.reopen",
				responses: { 204: { description: "reopened" } },
				"x-honey-errors": { "order.locked": { schema: object({ other: STRING }), status: 423 } },
			},
		},
	},
}

describe("declared error keys whose body is the envelope or a component", () => {
	it("names the component a key decodes into, declares no type for the envelope, and keeps a key's first schema", () => {
		const types = generateGoSdk(KEYED, { modulePath: "example.com/keyed" }).files["types.go"] ?? ""
		expect(types).not.toMatch(/OrderClosedData|OrderLockedData/)
		expect(
			types.endsWith(`
// The error keys the API declares: errors.Is(err, key) matches a *ClientError carrying key.
const (
	ErrOrderClosed ErrorKey = "order.closed"
	// ErrOrderLocked's body decodes into Lock (ClientError.DecodeBody).
	ErrOrderLocked ErrorKey = "order.locked"
)
`),
		).toBe(true)
	})

	it.skipIf(!GO)(
		"decodes a key's body into the component its godoc names",
		() => {
			const files = generateGoSdk(KEYED, { modulePath: "example.com/keyed" }).files
			const run = check(
				files,
				"example.com/keyed",
				`	replies["POST /a"] = reply{status: 423, body: \`{"error_key":"order.locked","until":"noon"}\`}
	err := client("http://api.test").Orders.Close(ctx, nil)
	var ce *sdk.ClientError
	var lock sdk.Lock
	note(errors.As(err, &ce), ce.DecodeBody(&lock), lock.Until, errors.Is(err, sdk.ErrOrderLocked))`,
				["errors"],
			)
			expect(seen(run), run.stderr).toEqual({
				built: true,
				out: ["POST http://api.test/a", "true <nil> noon true"],
				vet: [],
			})
		},
		600_000,
	)
})
