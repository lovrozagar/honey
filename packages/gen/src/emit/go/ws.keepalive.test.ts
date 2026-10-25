/**
 * The Go SDK's WebSocket keepalive (bit 19 d1, sweep item 26): an open socket pings every `Config.WSKeepalive` (20 s
 * by default, C#'s and Java's interval) and ends itself when a ping goes unanswered for as long, so a Read on a peer
 * that went dead behind a live connection fails within about twice the interval instead of waiting for TCP. A test
 * sets 200 ms; the server reads every ping and answers none. Its 1009 on an over-cap message is coder/websocket's
 * (ws.go's SetReadLimit), pinned by ws.test.ts.
 */
import { describe, expect, it } from "vitest"
import { served } from "../shared/__fixtures__/recording-server.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { generateGoSdk } from "./sdk.ts"

const GO = withGo()
const MODULE = "example.com/keepalive"

/** One WebSocket operation. */
const DOCUMENT = {
	info: { title: "Keepalive", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/feed": {
			get: {
				operationId: "feed.live",
				responses: {
					200: {
						content: { "text/event-stream": { schema: { properties: { n: { type: "integer" } }, type: "object" } } },
						description: "ok",
					},
				},
				"x-realtime": true,
				"x-websocket": true,
			},
		},
		"/rooms/{room}": {
			get: {
				operationId: "rooms.socket",
				parameters: [{ in: "path", name: "room", required: true, schema: { type: "string" } }],
				responses: { 101: { description: "upgraded" } },
				"x-websocket": true,
			},
		},
	},
}

/** Open the socket under a 200 ms keepalive and Read with a 5 s bound: how the read ended, and whether in time. */
const BODY = `	c := sdk.NewClient(sdk.Config{BaseURL: input.Base, WSKeepalive: 200 * time.Millisecond})
	w, err := c.Rooms.Socket(ctx, "r", nil)
	if err != nil {
		panic(err)
	}
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	started := time.Now()
	_, err = w.Read(bounded)
	elapsed := time.Since(started)
	note(fmt.Sprint("ended ", err != nil, " deadline ", errors.Is(err, context.DeadlineExceeded), " within 2x ", elapsed < 600*time.Millisecond))`

describe.skipIf(!GO)("the Go SDK's WebSocket keepalive (bit 19 d1)", () => {
	it("ends a socket whose peer never answers a ping within about twice the interval, having pinged", async () => {
		const { files } = generateGoSdk(DOCUMENT, { modulePath: MODULE })
		const { run, streams } = await served([{ status: 101, ws: { pong: false, steps: [] } }], async (server) => ({
			run: await consume(files, MODULE, { base: server.url, body: BODY, imports: ["errors", "time"] }),
			streams: [...server.streams],
		}))
		expect({ built: run.built, out: run.out, pinged: (streams[0]?.pings ?? 0) > 0 }, run.stderr).toEqual({
			built: true,
			out: { main: ["ended true deadline false within 2x true"] },
			pinged: true,
		})
	}, 600_000)
})

/** A realtime feed under a 200 ms keepalive: its first two frames, read within 5 s, or how the read ended. */
const REALTIME = `	c := sdk.NewClient(sdk.Config{BaseURL: input.Base, WSKeepalive: 200 * time.Millisecond})
	rc, err := c.Feed.Live(ctx, &sdk.FeedLiveOpts{ReconnectDelayMs: 10})
	if err != nil {
		panic(err)
	}
	values, ended := []any{}, ""
	deadline := time.After(5 * time.Second)
	for ended == "" && len(values) < 2 {
		select {
		case v, ok := <-rc.Events():
			if !ok {
				ended = "closed"
			}
			values = append(values, v)
		case <-deadline:
			ended = "timed out"
		}
	}
	if ended == "" {
		b, _ := json.Marshal(values)
		ended = string(b)
	}
	note(ended)`

describe.skipIf(!GO)("the Go realtime connection's WebSocket keepalive (bit 19 d1)", () => {
	it("drops a socket whose peer never answers a ping and reconnects, its frames read on", async () => {
		const { files } = generateGoSdk(DOCUMENT, { modulePath: MODULE })
		const replies = [
			{ status: 101, ws: { pong: false, steps: [{ json: { n: 1 } }] } },
			{ status: 101, ws: { steps: [{ json: { n: 2 } }] } },
		] as const
		const { run, streams } = await served(replies, async (server) => ({
			run: await consume(files, MODULE, { base: server.url, body: REALTIME, imports: ["encoding/json", "time"] }),
			streams: [...server.streams],
		}))
		expect({ built: run.built, out: run.out, pinged: (streams[0]?.pings ?? 0) > 0 }, run.stderr).toEqual({
			built: true,
			out: { main: ['[{"n":1},{"n":2}]'] },
			pinged: true,
		})
	}, 600_000)
})
