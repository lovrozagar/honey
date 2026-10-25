/**
 * The Go realtime connection dials with the client's current token (bit 19 b2, sweep item 2): a token refreshed by
 * OnAuthExpired after the connection opened is the one its reconnect carries, as Rust's, Python's, C#'s and Java's
 * dials read it. Ordered by the server, never by time: the first socket delivers a frame, waits for the client's
 * frame (sent only after the refresh), then drops; the reconnect is the fourth request.
 */
import { describe, expect, it } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import { compiledSdk } from "./__fixtures__/compiled.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { generateGoSdk } from "./sdk.ts"

const GO = withGo()
const MODULE = "example.com/rotation"

/** A realtime feed over WebSocket first, and one JSON GET to refresh the token through. */
const DOCUMENT = {
	components: { schemas: { Payload: { properties: { n: { type: "integer" } }, type: "object" } } },
	info: { title: "Rotation", version: "1" },
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
		"/ping": {
			get: {
				operationId: "ping.get",
				responses: { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } },
			},
		},
	},
	security: [{ bearer: [] }],
}

/** The program: open the feed, take a frame, refresh the token on a 401, send a frame, take the reconnect's frame. */
const BODY = `	refreshed := false
	c := sdk.NewClient(sdk.Config{
		BaseURL:     input.Base,
		BearerToken: "old",
		OnAuthExpired: func(context.Context) (string, error) {
			refreshed = true
			return "new", nil
		},
	})
	rc, err := c.Feed.Live(ctx, &sdk.FeedLiveOpts{ReconnectDelayMs: 10})
	if err != nil {
		note("open: " + err.Error())
		return
	}
	defer rc.Close()
	note(take(rc, 1))
	if _, err := c.Ping.Get(ctx, nil); err != nil {
		note("ping: " + err.Error())
	}
	note(fmt.Sprint("refreshed ", refreshed))
	if err := rc.Send(ctx, map[string]int{"after": 1}); err != nil {
		note("send: " + err.Error())
	}
	note(take(rc, 1))`

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
		case <-deadline:
			return "timed out"
		}
	}
	b, _ := json.Marshal(values)
	return string(b)
}`

const REPLIES: readonly Reply[] = [
	{ status: 101, ws: { steps: [{ json: { n: 1 } }, { receive: 1 }, { drop: true }] } },
	{ json: { message: "expired" }, status: 401 },
	{ json: {}, status: 200 },
	{ status: 101, ws: { steps: [{ json: { n: 2 } }] } },
]

describe.skipIf(!GO)("the Go realtime connection's reconnect carries the client's current token (bit 19 b2)", () => {
	it("dials its reconnect with the token OnAuthExpired refreshed after the open, never the construction token", async () => {
		const { files } = generateGoSdk(DOCUMENT, { modulePath: MODULE })
		const { hops, run } = await served(REPLIES, async (server) => {
			const out = await consume(files, MODULE, {
				base: server.url,
				body: BODY,
				decls: DECLS,
				imports: ["encoding/json", "time"],
			})
			return { hops: [...server.hops], run: out }
		})
		expect(
			{ auth: hops.map((hop) => `${hop.url} ${hop.headers.authorization}`), built: run.built, out: run.out },
			run.stderr,
		).toEqual({
			auth: ["/feed Bearer old", "/ping Bearer old", "/ping Bearer new", "/feed Bearer new"],
			built: true,
			out: { main: ['[{"n":1}]', "refreshed true", '[{"n":2}]'] },
		})
	}, 600_000)
})

describe.skipIf(!GO)("the Go realtime connection's long-poll dial carries the client's credential (bit 19 b2)", () => {
	it("falls through a refused upgrade and event stream to long-poll, its poll sending the bearer token", async () => {
		const sdk = compiledSdk(DOCUMENT, { modulePath: MODULE })
		expect({ built: sdk.built, vet: sdk.vet }, sdk.stderr).toEqual({ built: true, vet: [] })
		const live: Call = { operation: "feed.live", route: { method: "GET", path: "/feed" }, take: 1 }
		const replies: Reply[] = [
			{ json: { message: "no" }, status: 404 },
			{ status: 503, text: "" },
			{ json: { n: 1 }, status: 200 },
			{ delayMs: 5000, json: {}, status: 200 },
		]
		const { hops, run } = await served(replies, async (server) => {
			const ran = await sdk.runCalls({ calls: [live], setup: { auth: { kind: "bearer", token: "t" } } }, server, {})
			return { hops: [...server.hops], run: ran }
		})
		expect({ observed: run.observed, polled: hops[2]?.headers.authorization }, run.stderr).toEqual({
			observed: [{ frames: [{ n: 1 }], kind: "frames" }],
			polled: "Bearer t",
		})
	}, 600_000)
})
