import { describe, expect, it } from "vitest"
import type { Call, Observed, Setup } from "../../../tests/integration/conformance/matrix.ts"
import { compiledSdk, type DrivenSdk, inStyle } from "./__fixtures__/compiled.ts"
import type { GoError, HookTrace, Script } from "../shared/__fixtures__/protocol.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { gone } from "../shared/__fixtures__/gone.ts"
import { type Reply, served, REFUSED_URL } from "../shared/__fixtures__/recording-server.ts"
import { generateGoSdk } from "./sdk.ts"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()
const goDescribe = describe.skipIf(!GO)

type Json = Record<string, unknown>

const MODULE = "example.com/sse"
const STRING = { type: "string" }
const events = (schema: Json, extra: Json = {}) => ({
	200: { content: { "text/event-stream": { schema } }, description: "ok", ...extra },
})

/** A typed and a string SSE op, a POST stream with a JSON body, and one behind a path param, under bearer auth. */
const SSE: Json = {
	components: {
		schemas: { Tick: { properties: { n: { type: "integer" } }, required: ["n"], type: "object" } },
		securitySchemes: { bearer: { scheme: "bearer", type: "http" } },
	},
	info: { title: "SSE", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/chat": {
			post: {
				operationId: "chat.send",
				parameters: [{ in: "query", name: "model", schema: STRING }],
				requestBody: {
					content: {
						"application/json": { schema: { properties: { q: STRING }, required: ["q"], type: "object" } },
					},
					required: true,
				},
				responses: events(STRING),
			},
		},
		"/pending/{id}": {
			get: {
				operationId: "pending.stream",
				parameters: [{ in: "path", name: "id", required: true, schema: STRING }],
				responses: events(STRING),
			},
		},
		"/text": { get: { operationId: "text.stream", responses: events(STRING) } },
		"/ticks": {
			get: {
				operationId: "ticks.stream",
				parameters: [
					{ in: "header", name: "x-tenant", schema: STRING },
					{ in: "query", name: "since", schema: { type: "integer" } },
				],
				responses: events({ $ref: "#/components/schemas/Tick" }, { headers: { "X-Stream-Id": { schema: STRING } } }),
			},
		},
	},
	security: [{ bearer: [] }],
}

let compiled: DrivenSdk | undefined

/** The SSE SDK compiled with the driver once (it must build and vet clean), calling through `client.Safe()` when `safe`. */
function sseSdk(safe = false): DrivenSdk {
	const sdk = (compiled ??= compiledSdk(SSE, { modulePath: MODULE }))
	expect({ built: sdk.built, vet: sdk.vet }, sdk.stderr).toEqual({ built: true, vet: [] })
	return inStyle(sdk, safe)
}

const route = (method: string, path: string) => ({ method, path })
const ticks = (extra: Partial<Call> = {}): Call => ({
	operation: "ticks.stream",
	route: route("GET", "/ticks"),
	...extra,
})
const text = (extra: Partial<Call> = {}): Call => ({ operation: "text.stream", route: route("GET", "/text"), ...extra })
const CHAT: Call = {
	body: { kind: "json", value: { q: "hi" } },
	operation: "chat.send",
	route: route("POST", "/chat"),
	search: { model: "m1" },
}
const pending = (id: string): Call => ({
	operation: "pending.stream",
	params: { id },
	route: route("GET", "/pending/{id}"),
})

type Step = string | { waitMs: number }
const sse = (steps: readonly Step[], end: "close" | "drop" | "hold" = "close"): Reply => ({
	sse: { end, steps },
	status: 200,
})
const TICK = sse(['data: {"n":1}\n\n'])
/* a held typed stream: a consumer breaking out after the first event is what ends it */
const HELD = sse(['id: 7\ndata: {"n":1}\n\n', { waitMs: 50 }, 'data: {"n":2}\n\n'], "hold")
const TICKED: Observed = { events: [{ data: { n: 1 } }], kind: "events" }
const tick = (n: number) => `id: ${n}\nevent: tick\ndata: {"n":${n}}\n\n`

/** `calls` run by `sdk` against a server answering `replies`: the run, hops, streams and the server's origin. */
async function drive(sdk: DrivenSdk, replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: options.setup ?? {} }, server, options.script)
		return { hops: [...server.hops], run, streams: [...server.streams], url: server.url }
	})
}
type Options = { readonly script?: Script; readonly setup?: Setup }

/** The `*sdk.` entries of an error's chain: the only ones a test may pin. */
const sdkTypes = (error: GoError | undefined) => error?.chain.filter((type) => type.startsWith("*sdk."))

/**
 * A consumer that holds both stream methods and a safe twin in their declared types (compiling is the assertion),
 * then ranges a held typed stream with `LastEventID: ""` under a ctx nothing cancels, breaking out
 * after the first event, then opens the text stream: its answer waits until the first stream's client
 * left (gone.ts), so only the iterator, not the exit, can have closed the body.
 */
const CONSUMER = `	var typed iter.Seq2[sdk.SSEEvent[sdk.Tick], error] = client(input.Base).Ticks.Stream(ctx, nil)
	var plain iter.Seq2[sdk.SSEEvent[string], error] = client(input.Base).Text.Stream(ctx, nil)
	var safeTyped func(context.Context, *sdk.TicksStreamOpts, ...sdk.RequestOption) (sdk.Result[iter.Seq2[sdk.SSEEvent[sdk.Tick], error]], error) = client(input.Base).Safe().Ticks.Stream
	_, _, _ = typed, plain, safeTyped
	live := sdk.NewClient(sdk.Config{BaseURL: input.Base})
	for ev, err := range live.Ticks.Stream(ctx, &sdk.TicksStreamOpts{LastEventID: ""}) {
		note(ev.Data.N, ev.ID, err)
		break
	}
	for ev, err := range live.Text.Stream(ctx, nil) {
		note(ev.Data, err)
		break
	}`

goDescribe("an SSE method: iter.Seq2[SSEEvent[T], error], T from the declared event schema", () => {
	// v0: b857f94d20
	// v0: 31d78e3aa4
	it("compiles as iter.Seq2[SSEEvent[Tick]] and [string], a Result of each on Safe(); an empty LastEventID sends none; a break closes the body", async () => {
		const files = generateGoSdk(SSE, { modulePath: MODULE }).files
		const next = gone(sse(["data: z\n\n"]))
		const { hops, ran } = await served([HELD, next.reply], async (server) => {
			const running = consume(files, MODULE, { base: server.url, body: CONSUMER, imports: ["iter"] })
			return { ran: await running, hops: [...server.hops] }
		})
		expect({ built: ran.built, out: ran.out?.main, vet: ran.vet }, ran.stderr).toEqual({
			built: true,
			out: ["1 7 <nil>", "z <nil>"],
			vet: [],
		})
		expect({
			hops: hops.map((hop) => [hop.headers.accept, hop.headers["last-event-id"]]),
			released: next.released(),
		}).toEqual({
			hops: [
				["text/event-stream", undefined],
				["text/event-stream", undefined],
			],
			released: true,
		})
	}, 600_000)

	// v0: b857f94d20
	it("decodes each event's data into T with its event and id, and keeps a string stream's data as sent", async () => {
		const replies = [sse([tick(1), tick(2), tick(3)]), sse(['data: {"a":1}\n\n'])]
		const { run } = await drive(sseSdk(), replies, [ticks({ take: 3 }), text()])
		expect(run.observed, run.stderr).toEqual([
			{ events: [1, 2, 3].map((n) => ({ data: { n }, event: "tick", id: String(n) })), kind: "events" },
			{ events: [{ data: '{"a":1}' }], kind: "events" },
		] satisfies Observed[])
	}, 600_000)

	// v0: b857f94d20
	it("ends a typed stream on data that does not decode: the events before it, then a decode error, never a string", async () => {
		const reply = sse(['data: {"n":1}\n\n', "data: nope\n\n"])
		const { run } = await drive(sseSdk(), [reply], [ticks()], { script: {} })
		const call = run.trace?.calls[0]
		expect(
			{ error: call?.error && { sdk: sdkTypes(call.error), text: call.error.text, via: call.error.via } },
			run.stderr,
		).toEqual({ error: { sdk: [], text: expect.stringMatching(/^honey: decode sse event:/), via: "stream" } })
		expect({ observed: run.observed, stream: call?.stream }).toEqual({
			observed: [TICKED],
			stream: { retry: [0], yields: 2 },
		})
	}, 600_000)
})

goDescribe("an SSE request on the wire: accept and Last-Event-ID", () => {
	// v0: e7c7d4d6d6
	it("asks for text/event-stream, and a per-call accept header wins", async () => {
		const calls = [ticks(), ticks({ headers: { accept: "text/plain" } })]
		const { hops, run } = await drive(sseSdk(), [TICK, TICK], calls)
		expect({ accept: hops.map((hop) => hop.headers.accept), observed: run.observed }, run.stderr).toEqual({
			accept: ["text/event-stream", "text/plain"],
			observed: [TICKED, TICKED],
		})
	}, 600_000)

	// v0: 31d78e3aa4
	it("sends lastEventId as Last-Event-ID, and no such header without one", async () => {
		const { hops, run } = await drive(sseSdk(), [TICK, TICK], [ticks({ lastEventId: "evt-5" }), ticks()])
		expect({ ids: hops.map((hop) => hop.headers["last-event-id"]), observed: run.observed }, run.stderr).toEqual({
			ids: ["evt-5", undefined],
			observed: [TICKED, TICKED],
		})
	}, 600_000)
})

goDescribe("an SSE request on the wire: the operation's method, params, body and auth", () => {
	// v0: 28da0ea38b
	it("sends the declared query and header params", async () => {
		const call = ticks({ headers: { "x-tenant": "acme" }, search: { since: 5 } })
		const { hops, run } = await drive(sseSdk(), [TICK], [call])
		expect(run.observed, run.stderr).toEqual([TICKED])
		expect(hops.map(({ headers, method, url }) => ({ tenant: headers["x-tenant"], method, url }))).toEqual([
			{ method: "GET", tenant: "acme", url: "/ticks?since=5" },
		])
	}, 600_000)

	// v0: 28da0ea38b
	// v0: 1944c43665
	it("sends a POST stream's method, query, JSON body and bearer token", async () => {
		const setup: Setup = { auth: { kind: "bearer", token: "tok" } }
		const { hops, run } = await drive(sseSdk(), [sse(["data: one\n\n"])], [CHAT], { setup })
		expect(run.observed, run.stderr).toEqual([{ events: [{ data: "one" }], kind: "events" }])
		expect(
			hops.map(({ body, headers, method, url }) => ({
				authorization: headers.authorization,
				body: body.json,
				contentType: headers["content-type"],
				method,
				url,
			})),
		).toEqual([
			{
				authorization: "Bearer tok",
				body: { q: "hi" },
				contentType: "application/json",
				method: "POST",
				url: "/chat?model=m1",
			},
		])
	}, 600_000)
})

goDescribe("an SSE open that fails", () => {
	// v0: 0ccba24aa9
	it("yields one typed error and ends on an error status before any event; on Safe() the opening's Err", async () => {
		const replies = [
			{ json: { message: "nope" }, status: 404 },
			{ json: { message: "boom" }, status: 500 },
		]
		for (const safe of [false, true]) {
			const { hops, run } = await drive(sseSdk(safe), replies, [ticks(), ticks()], { script: {} })
			expect(run.observed, run.stderr).toEqual([
				{ body: { message: "nope" }, errorKey: null, kind: "error", status: 404 },
				{ body: { message: "boom" }, errorKey: null, kind: "error", status: 500 },
			] satisfies Observed[])
			const calls = run.trace?.calls.map(({ error, stream }) => ({ sdk: sdkTypes(error), stream, via: error?.via }))
			/* the normal stream yields it; the safe twin opened on the call and answers it as the Result's Err */
			const [stream, via] = safe ? [undefined, "result"] : [{ yields: 1 }, "stream"]
			expect({ calls, hops: hops.length }).toEqual({
				calls: [
					{ sdk: ["*sdk.NotFoundError", "*sdk.ClientError"], stream, via },
					{ sdk: ["*sdk.InternalServerError", "*sdk.ClientError"], stream, via },
				],
				hops: 2,
			})
		}
	}, 600_000)

	it("refreshes the token once on a 401 open and streams on the retry", async () => {
		const replies = [{ json: { message: "expired" }, status: 401 }, TICK]
		const { hops, run } = await drive(sseSdk(), replies, [ticks()], {
			script: { onAuthExpired: { tokens: ["new"] } },
			setup: { auth: { kind: "bearer", token: "old" } },
		})
		expect(
			{
				auth: hops.map((hop) => hop.headers.authorization),
				error: run.trace?.calls[0]?.error,
				expired: run.trace?.authExpired,
				observed: run.observed,
			},
			run.stderr,
		).toEqual({ auth: ["Bearer old", "Bearer new"], error: undefined, expired: 1, observed: [TICKED] })
	}, 600_000)
})

goDescribe("an SSE call that fails before it opens", () => {
	it("fails a bad path param before any request: no events, a PathParamError, no hop", async () => {
		const { hops, run } = await drive(sseSdk(), [], [pending("..")], { script: {} })
		const call = run.trace?.calls[0]
		expect(
			{
				error: call?.error && { pathParam: call.error.pathParam, sdk: sdkTypes(call.error), via: call.error.via },
				hops: hops.length,
				observed: run.observed,
				stream: call?.stream,
			},
			run.stderr,
		).toEqual({
			error: { pathParam: { missing: false, name: "id", value: ".." }, sdk: ["*sdk.PathParamError"], via: "stream" },
			hops: 0,
			observed: [{ events: [], kind: "events" }],
			stream: { yields: 1 },
		})
	}, 600_000)
})

goDescribe("how an SSE stream ends: timeouts, the caller's ctx, breaking out", () => {
	// v0: 0c1872f081
	it("is not cut by Config.Timeout or a per-call timeout: a gap past both still delivers the next event", async () => {
		const reply = sse(["data: 1\n\n", { waitMs: 500 }, "data: 2\n\n"])
		const { run } = await drive(sseSdk(), [reply], [text({ timeoutMs: 100 })], {
			script: {},
			setup: { timeoutMs: 200 },
		})
		const call = run.trace?.calls[0]
		expect({ error: call?.error, observed: run.observed }, run.stderr).toEqual({
			error: undefined,
			observed: [{ events: [{ data: "1" }, { data: "2" }], kind: "events" }],
		})
		/* the gap really outlasted both bounds: the server paused 500 ms between the events */
		expect(call?.elapsedMs).toBeGreaterThanOrEqual(450)
	}, 600_000)

	it("ends quietly when the caller's ctx is canceled or its deadline passes mid-stream: the events so far, no error", async () => {
		const held = sse(["data: 1\n\n"], "hold")
		const script: Script = { calls: [{ cancel: { afterMs: 1000 } }, { ctxTimeoutMs: 1000 }] }
		const { run } = await drive(sseSdk(), [held, held], [text(), text()], { script })
		const calls = run.trace?.calls ?? []
		expect({ errors: calls.map((call) => call.error), observed: run.observed }, run.stderr).toEqual({
			errors: [undefined, undefined],
			observed: [
				{ events: [{ data: "1" }], kind: "events" },
				{ events: [{ data: "1" }], kind: "events" },
			],
		})
		for (const { elapsedMs } of calls) expect(elapsedMs).toBeGreaterThanOrEqual(950)
		for (const { elapsedMs } of calls) expect(elapsedMs).toBeLessThan(5_000)
	}, 600_000)

	it("closes the body when the caller breaks out of the loop, before the run goes on", async () => {
		const spaced = sse(["data: 1\n\n", { waitMs: 50 }, "data: 2\n\n", { waitMs: 50 }, "data: 3\n\n"], "hold")
		/* the second call's answer waits until the first stream's client left (gone.ts): the driver still runs */
		const next = gone(sse(["data: z\n\n"]))
		const { run } = await drive(sseSdk(), [spaced, next.reply], [text({ take: 1 }), text()], { script: {} })
		expect({ observed: run.observed, released: next.released() }, run.stderr).toEqual({
			observed: [
				{ events: [{ data: "1" }], kind: "events" },
				{ events: [{ data: "z" }], kind: "events" },
			],
			released: true,
		})
		expect(run.trace?.calls[0]?.elapsedMs).toBeLessThan(1_000)
	}, 600_000)
})

goDescribe("an SSE open's typed response headers and request hooks", () => {
	it("fills <Op>Headers at open, and runs the request hooks on the open", async () => {
		const reply: Reply = { ...TICK, headers: { "x-stream-id": "s-1" } }
		const script: Script = { hooks: { request: [{ setHeader: ["x-hook", "1"] }] } }
		const { hops, run, url } = await drive(sseSdk(), [reply], [ticks()], { script })
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [TICKED],
			stream: { headers: { "x-stream-id": "s-1" }, retry: [0], yields: 1 },
		})
		expect({
			hook: hops.map((hop) => hop.headers["x-hook"]),
			ran: run.trace?.hooks.filter((hook) => hook.phase === "request"),
		}).toEqual({
			hook: ["1"],
			ran: [
				{
					call: 0,
					index: 0,
					invalidatedBy: [],
					isRetry: false,
					isStale: false,
					method: "GET",
					path: "/ticks",
					phase: "request",
					selector: "",
					url: `${url}/ticks`,
				},
			],
		})
	}, 600_000)
})

/** The hook runs as `<call> <phase> <index>`, a retry flag and status when they have them (as http.hooks.test.ts), joined by `|`. */
const steps = (hooks: readonly HookTrace[] | undefined) =>
	hooks
		?.map((h) => [h.call, h.phase, h.index, h.isRetry ? "retry" : "", h.status ?? ""].filter((p) => p !== "").join(" "))
		.join(" | ")

/** An OnLog entry as the trace records it, in a plain call's shape (http.hooks.test.ts). */
const logged = (operation: string, event: string, level: string, extra: Json = {}) => ({
	event,
	level,
	operation,
	...extra,
})
const TICKS = "GET /ticks"
const PENDING = "GET /pending/{id}"

goDescribe("an SSE open through a plain call's pipeline: the OnResponse hooks", () => {
	it("runs them in order on the open: an error status's last body set decodes, a failing hook ends the stream unread", async () => {
		/* a 2xx stream's Body is nil: its events come from the stream, whatever a hook set */
		const hooks: Script["hooks"] = { response: [{}, { body: '{"message":"hooked"}' }] }
		const replies = [TICK, { json: { message: "nope" }, status: 404 }]
		const { run } = await drive(sseSdk(), replies, [ticks(), ticks()], { script: { hooks } })
		expect({ observed: run.observed, order: steps(run.trace?.hooks) }, run.stderr).toEqual({
			observed: [TICKED, { body: { message: "hooked" }, errorKey: null, kind: "error", status: 404 }],
			order: "0 request 0 | 0 response 0 200 | 0 response 1 200 | 1 request 0 | 1 response 0 404 | 1 response 1 404",
		})
		/* a second call's answer waits until the first stream's client left (gone.ts): the driver still runs */
		const next = gone(TICK)
		const failing = await drive(sseSdk(), [HELD, next.reply], [ticks(), ticks()], {
			script: { hooks: { response: [{ fail: "bad" }, {}] } },
		})
		const errors = failing.run.trace?.calls.map(({ error }) => [error?.via, error?.text])
		const unread = { events: [], kind: "events" }
		expect({ errors, observed: failing.run.observed, released: next.released() }, failing.run.stderr).toEqual({
			errors: [
				["stream", "honey: OnResponse hook: bad"],
				["stream", "honey: OnResponse hook: bad"],
			],
			observed: [unread, unread],
			released: true,
		})
		expect(steps(failing.run.trace?.hooks)).toBe("0 request 0 | 0 response 0 200 | 1 request 0 | 1 response 0 200")
	}, 600_000)

	it("runs them again with isRetry on an auth retry, and OnLog sees one exchange", async () => {
		const script: Script = { hooks: { response: [{}] }, log: true, onAuthExpired: { tokens: ["new"] } }
		const replies = [{ json: { message: "expired" }, status: 401 }, TICK]
		const setup: Setup = { auth: { kind: "bearer", token: "old" } }
		const { run } = await drive(sseSdk(), replies, [ticks()], { script, setup })
		expect({ log: run.trace?.log, observed: run.observed, order: steps(run.trace?.hooks) }, run.stderr).toEqual({
			log: [logged(TICKS, "request_start", "debug"), logged(TICKS, "response_received", "info", { status: 200 })],
			observed: [TICKED],
			order: "0 request 0 | 0 response 0 401 | 0 request 0 retry | 0 response 0 retry 200",
		})
	}, 600_000)
})

goDescribe("an SSE open through a plain call's pipeline: OnLog", () => {
	it("logs request_start, then response_received, the error entry on an error status or no response, naming only the template", async () => {
		const calls = [
			ticks({ headers: { "x-tenant": "t-secret" }, search: { since: 987654321 } }),
			ticks(),
			pending("p-secret"),
		]
		const replies = [TICK, { json: { message: "nope" }, status: 404 }, sse(["data: x\n\n"])]
		const { run } = await drive(sseSdk(), replies, calls, { script: { log: true } })
		const closed = REFUSED_URL
		const refused = await sseSdk().runCalls({ calls: [pending("p-secret")] }, { url: closed }, { log: true })
		expect([run.trace?.log, refused.trace?.log], run.stderr + refused.stderr).toEqual([
			[
				logged(TICKS, "request_start", "debug"),
				logged(TICKS, "response_received", "info", { status: 200 }),
				logged(TICKS, "request_start", "debug"),
				logged(TICKS, "response_received", "warn", { status: 404 }),
				logged(TICKS, "error", "error", { error: "HTTP 404: nope", status: 404 }),
				logged(PENDING, "request_start", "debug"),
				logged(PENDING, "response_received", "info", { status: 200 }),
			],
			[
				logged(PENDING, "request_start", "debug"),
				logged(PENDING, "error", "error", { error: expect.stringContaining("connection refused") }),
			],
		])
		/* the query value is longer than any port: the refused entry's error names the closed server's port */
		const logs = JSON.stringify([run.trace?.log, refused.trace?.log])
		expect(["t-secret", "since", "987654321", "p-secret"].filter((value) => logs.includes(value))).toEqual([])
	}, 600_000)
})
