/**
 * A Go realtime connection's deterministic refusal is terminal (bit 19 e, carry-in #6): when every transport refuses
 * with a 400, 401 (after the one OnAuthExpired refresh), 403, 404, 405, 410 or 422, the open, or the reconnect, ends
 * with the typed error. One refused transport still falls through (a 404 upgrade is a server without WebSocket), and
 * one transient failure (408, 429, 5xx, a transport error) among them makes the chain back off and retry. A drop by a
 * refusal (long-poll's first poll) ends the connection. The most specific refusal surfaces (401, 403, 422, 400, 410,
 * then 404 and 405, a tie the first transport's), and a 401 refreshes once per open, restarting the chain.
 */
import { describe, expect, it } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { generateGoSdk } from "./sdk.ts"

const GO = withGo()
const MODULE = "example.com/refusal"

/** A realtime feed over WebSocket first, then SSE, then long-poll. */
const DOCUMENT = {
	components: { schemas: { Payload: { properties: { n: { type: "integer" } }, type: "object" } } },
	info: { title: "Refusal", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/feed": {
			get: {
				operationId: "feed.live",
				responses: {
					200: {
						content: { "text/event-stream": { schema: { $ref: "#/components/schemas/Payload" } } },
						description: "ok",
					},
				},
				"x-realtime": true,
				"x-websocket": true,
			},
		},
	},
	security: [{ bearer: [] }],
}

/** take(rc, n): n values off Events within 5 s, as JSON; refusal(err): the typed status an error carries. */
const DECLS = `
func take(rc *sdk.ResumableConnection, n int) string {
	values := []any{}
	deadline := time.After(5 * time.Second)
	for len(values) < n {
		select {
		case v, ok := <-rc.Events():
			if !ok {
				return "closed"
			}
			values = append(values, v)
		case err := <-rc.Errors():
			return "error " + refusal(err)
		case <-deadline:
			return "timed out"
		}
	}
	b, _ := json.Marshal(values)
	return string(b)
}

func refusal(err error) string {
	var ce *sdk.ClientError
	if errors.As(err, &ce) {
		return fmt.Sprint("status ", ce.Status())
	}
	return "untyped " + err.Error()
}`

/** The program: open the feed with a quick backoff and the client's auth, then take `n` values. */
const body = (n: number) => `	refreshed := 0
	c := sdk.NewClient(sdk.Config{
		BaseURL:     input.Base,
		BearerToken: "old",
		OnAuthExpired: func(context.Context) (string, error) {
			refreshed++
			return "new", nil
		},
	})
	/* no early return: the consumer prints its notes at the end of main */
	if rc, err := c.Feed.Live(ctx, &sdk.FeedLiveOpts{ReconnectDelayMs: 10}); err != nil {
		note("open error " + refusal(err))
	} else {
		note(take(rc, ${n}))
		rc.Close()
	}
	note(fmt.Sprint("refreshed ", refreshed))`

/** A chain of WebSocket and SSE alone, built through NewResumableConnection, taking `n` values. */
const custom = (
	n: number,
) => `	c := sdk.NewResumableConnection(input.Base+"/feed", []sdk.Transport{&sdk.WsTransport{}, &sdk.SseTransport{}}, &sdk.TransportOpts{ReconnectDelayMs: 10})
	if err := c.Connect(ctx); err != nil {
		note("open error " + refusal(err))
	} else {
		note(take(c, ${n}))
		c.Close()
	}`

/** The program run against `replies`: its notes and each request's `<kind> <authorization>`. */
async function run(replies: readonly Reply[], n = 1, program = body(n)) {
	const { files } = generateGoSdk(DOCUMENT, { modulePath: MODULE })
	const { hops, out } = await served(replies, async (server) => {
		const ran = await consume(files, MODULE, {
			base: server.url,
			body: program,
			decls: DECLS,
			imports: ["encoding/json", "errors", "time"],
		})
		expect(ran.built, ran.stderr).toBe(true)
		return { hops: [...server.hops], out: ran.out?.main }
	})
	const kind = (h: (typeof hops)[number]) =>
		h.headers.upgrade ? "ws" : h.headers.accept === "text/event-stream" ? "sse" : "poll"
	return { dials: hops.map((h) => `${kind(h)} ${h.headers.authorization}`), out }
}

const refused = (status: number): Reply => ({ json: { message: "no" }, status })
const unavailable: Reply = { status: 503, text: "" }
const frame = (n: number): Reply => ({ status: 101, ws: { steps: [{ json: { n } }] } })
const events = (...ns: number[]): Reply => ({
	sse: { end: "drop", steps: ns.map((n) => `data: {"n":${n}}\n\n`) },
	status: 200,
})

/** A WebSocket-and-SSE chain refusing with `ws` and `sse`: its dials and how its open ended. */
const pair = (ws: Reply, sse: Reply) => run([ws, sse, events(1)], 1, custom(1))

describe.skipIf(!GO)("a Go realtime refusal is terminal, a transient failure is not (bit 19 e)", () => {
	it.each([400, 403, 404, 405, 410, 422])(
		"ends the connection when every transport refuses with a %i, its typed error, dialing nothing more",
		async (status) => {
			expect(await run([refused(status), refused(status), refused(status), frame(1)])).toEqual({
				dials: ["ws Bearer old", "sse Bearer old", "poll Bearer old"],
				out: [`error status ${status}`, "refreshed 0"],
			})
		},
		600_000,
	)

	it("falls through a refused upgrade to the next transport, and backs off through a 429 on a reconnect", async () => {
		expect(await run([refused(404), events(1), refused(429), events(2)], 2)).toEqual({
			dials: ["ws Bearer old", "sse Bearer old", "ws Bearer old", "sse Bearer old"],
			out: ['[{"n":1},{"n":2}]', "refreshed 0"],
		})
	}, 600_000)

	it("retries a custom chain's reconnect a 503 or a 429 failed among refusals; ends the one every transport refused", async () => {
		const retried = [unavailable, refused(404), refused(404), refused(429)]
		const replies = [unavailable, events(1), ...retried, refused(404), refused(403), events(2)]
		expect(await run(replies, 2, custom(2))).toEqual({
			dials: Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? "ws undefined" : "sse undefined")),
			out: ["error status 403"],
		})
	}, 600_000)
})

describe.skipIf(!GO)("a Go realtime open's one refresh and its most specific refusal (bit 19 e)", () => {
	it("refreshes once on a 401 and redials with the new token; a second 401 ends the open", async () => {
		const once = await run([refused(401), frame(1)])
		const twice = await run([refused(401), refused(401), refused(401), refused(401), frame(1)])
		expect({ once, twice }).toEqual({
			once: { dials: ["ws Bearer old", "ws Bearer new"], out: ['[{"n":1}]', "refreshed 1"] },
			twice: {
				dials: ["ws Bearer old", "ws Bearer new", "sse Bearer new", "poll Bearer new"],
				out: ["error status 401", "refreshed 1"],
			},
		})
	}, 600_000)

	it("surfaces the most specific refusal of an all-refused chain, a tie the first transport's", async () => {
		expect({
			auth: await pair(refused(404), refused(401)),
			missing: await pair(refused(404), refused(404)),
			tie: await pair(refused(404), refused(405)),
		}).toEqual({
			auth: { dials: ["ws undefined", "sse undefined"], out: ["open error status 401"] },
			missing: { dials: ["ws undefined", "sse undefined"], out: ["open error status 404"] },
			tie: { dials: ["ws undefined", "sse undefined"], out: ["open error status 404"] },
		})
	}, 600_000)

	it("refreshes once on an SSE 401 and restarts the chain from WebSocket with the new token", async () => {
		expect(await run([refused(404), refused(401), refused(404), events(1)])).toEqual({
			dials: ["ws Bearer old", "sse Bearer old", "ws Bearer new", "sse Bearer new"],
			out: ['[{"n":1}]', "refreshed 1"],
		})
	}, 600_000)

	it("ends the connection when long-poll's first poll is refused, a drop by refusal, dialing nothing more", async () => {
		expect(await run([unavailable, unavailable, refused(403), events(1)])).toEqual({
			dials: ["ws Bearer old", "sse Bearer old", "poll Bearer old"],
			out: ["error status 403", "refreshed 0"],
		})
	}, 600_000)
})
