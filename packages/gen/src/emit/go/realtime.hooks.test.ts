/**
 * The Go realtime connection's HTTP dials run the client's hooks (bit 19 e, carry-in #5), as Rust's, C#'s and Java's
 * do: OnRequest and OnResponse fire once per event-stream dial and reconnect, and once per long-poll poll; a hook's
 * URL and headers are the dial's. The WebSocket dial runs none, uniform across the SDKs (an upgrade is no answer).
 */
import { describe, expect, it } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { generateGoSdk } from "./sdk.ts"

const GO = withGo()
const MODULE = "example.com/hooks"

/** A realtime feed over WebSocket first, then SSE, then long-poll. */
const DOCUMENT = {
	components: { schemas: { Payload: { properties: { n: { type: "integer" } }, type: "object" } } },
	info: { title: "Hooks", version: "1" },
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
}

const DECLS = `
func take(rc *sdk.ResumableConnection, n int) string {
	values := []any{}
	deadline := time.After(5 * time.Second)
	for len(values) < n {
		select {
		case v := <-rc.Events():
			values = append(values, v)
		case <-deadline:
			return "timed out"
		}
	}
	b, _ := json.Marshal(values)
	return string(b)
}`

/** The program: a client whose hooks note each request's path and query and each response's status. */
const BODY = `	var mu sync.Mutex
	var seen []string
	saw := func(line string) { mu.Lock(); seen = append(seen, line); mu.Unlock() }
	c := sdk.NewClient(sdk.Config{
		BaseURL: input.Base,
		OnRequest: []func(*sdk.RequestContext) error{func(rc *sdk.RequestContext) error {
			u, _ := url.Parse(rc.URL)
			saw("request " + u.RequestURI())
			return nil
		}},
		OnResponse: []func(*sdk.ResponseContext) error{func(rc *sdk.ResponseContext) error {
			saw(fmt.Sprint("response ", rc.Status))
			return nil
		}},
	})
	if rc, err := c.Feed.Live(ctx, &sdk.FeedLiveOpts{ReconnectDelayMs: 10}); err != nil {
		note("open error " + err.Error())
	} else {
		note(take(rc, 2))
		rc.Close()
	}
	mu.Lock()
	for _, line := range seen {
		note(line)
	}
	mu.Unlock()`

async function run(replies: readonly Reply[]) {
	const { files } = generateGoSdk(DOCUMENT, { modulePath: MODULE })
	return served(replies, async (server) => {
		const ran = await consume(files, MODULE, {
			base: server.url,
			body: BODY,
			decls: DECLS,
			imports: ["encoding/json", "net/url", "sync", "time"],
		})
		expect(ran.built, ran.stderr).toBe(true)
		return ran.out?.main
	})
}

const unavailable: Reply = { status: 503, text: "" }
const stream = (n: number, end: "drop" | "hold"): Reply => ({
	sse: { end, steps: [`data: {"n":${n},"reconnect_token":"t${n}"}\n\n`] },
	status: 200,
})
const polled = (n: number): Reply => ({ json: { n }, status: 200 })

describe.skipIf(!GO)("a Go realtime connection's HTTP dials run the client's hooks (bit 19 e)", () => {
	it("runs OnRequest and OnResponse once per event-stream dial and reconnect, none for the WebSocket dials", async () => {
		expect(await run([unavailable, stream(1, "drop"), unavailable, stream(2, "hold")])).toEqual([
			'[{"n":1,"reconnect_token":"t1"},{"n":2,"reconnect_token":"t2"}]',
			"request /feed",
			"response 200",
			"request /feed?reconnect_token=t1",
			"response 200",
		])
	}, 600_000)

	it("runs them once per long-poll poll, the refused event stream's dial too", async () => {
		const pending: Reply = { delayMs: 5000, json: {}, status: 200 }
		const out = (await run([unavailable, unavailable, polled(1), polled(2), pending])) ?? []
		/* the next poll may already be out when the program stops: at most its request, never its answer */
		expect({ next: out.slice(7).filter((line) => line !== "request /feed").length, seen: out.slice(0, 7) }).toEqual({
			next: 0,
			seen: [
				'[{"n":1},{"n":2}]',
				"request /feed",
				"response 503",
				"request /feed",
				"response 200",
				"request /feed",
				"response 200",
			],
		})
		expect(out.length).toBeLessThanOrEqual(8)
	}, 600_000)
})
