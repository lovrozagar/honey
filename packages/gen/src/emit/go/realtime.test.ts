import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import { compiledSdk, type DrivenSdk, type Script } from "./__fixtures__/compiled.ts"
import { consume, type Run } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { type RecordedHop, type Reply, served } from "./__fixtures__/recording-server.ts"
import { generateGoSdk } from "./sdk.ts"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()
const goDescribe = describe.skipIf(!GO)

type Json = Record<string, unknown>

const STRING = { type: "string" }
const param = (where: string, name: string, required = false) => ({ in: where, name, required, schema: STRING })
const realtime = (operationId: string, parameters: Json[], schema: Json) => {
	const responses = { 200: { content: { "text/event-stream": { schema } }, description: "ok" } }
	return { get: { operationId, parameters, responses, "x-realtime": true, "x-websocket": true } }
}

const PAYLOAD = { properties: { n: { type: "integer" }, reconnect_token: STRING }, type: "object" }
const RESUME = ["reconnect_token", "last_event_id", "protocols"].map((name) => param("query", name))
/**
 * Two realtime operations: feed.live with a required query and a header param, and feed.resume
 * declaring every resume channel the runtime sends itself plus a `protocols` query that collides
 * with the synthetic Opts field.
 */
const RT: Json = {
	components: { schemas: { Payload: PAYLOAD } },
	info: { title: "Realtime", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/feed": realtime("feed.live", [param("query", "channel", true), param("header", "x-tenant")], {
			$ref: "#/components/schemas/Payload",
		}),
		"/resume": realtime("feed.resume", [...RESUME, param("header", "Last-Event-ID")], STRING),
	},
}
const MODULE = "example.com/realtime"

let driven: DrivenSdk | undefined
/** RT's SDK compiled with the driver, once; it must build and vet clean. */
function rtSdk(): DrivenSdk {
	driven ??= compiledSdk(RT, { modulePath: MODULE })
	expect({ built: driven.built, vet: driven.vet }, driven.stderr).toEqual({ built: true, vet: [] })
	return driven
}

/** `calls` run by `sdk` under `script` against a server answering `replies`: the run and the hops. */
function drive(sdk: DrivenSdk, replies: readonly Reply[], calls: readonly Call[], script: Script) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: {} }, server, script)
		return { hops: [...server.hops], run }
	})
}

const FEED = { operation: "feed.live", route: { method: "GET", path: "/feed" }, search: { channel: "c" } }
const live = (extra: Partial<Call> = {}): Call => ({ ...FEED, ...extra })
/** a short first backoff, so a reconnect lands within milliseconds (5–10 ms with jitter) */
const QUICK: Script = { calls: [{ realtime: { reconnectDelayMs: 10 } }] }
const refused: Reply = { json: { message: "no" }, status: 404 }
type Step = string | { waitMs: number }
const sse = (steps: readonly Step[], end: "drop" | "hold"): Reply => ({ sse: { end, steps }, status: 200 })
/** event n of a resumable stream: SSE id n, payload n with reconnect token rt-n */
const ev = (n: number) => `id: ${n}\ndata: {"n":${n},"reconnect_token":"rt-${n}"}\n\n`
const frame = (n: number) => ({ n, reconnect_token: `rt-${n}` })
const polled = (n: number, id: string): Reply => ({ json: { id, n, reconnect_token: `rt-${id}` }, status: 200 })
/** a poll answered only after the test is over: the stage's stop ends the wait */
const pending: Reply = { delayMs: 5000, json: {}, status: 200 }
/** refused upgrade, refused event stream, then long-poll: two polls answered, a third left pending */
const POLLED: readonly Reply[] = [refused, { status: 503, text: "" }, polled(1, "7"), polled(2, "8"), pending]
/** a hop's resume wire: its URL and its Last-Event-ID header */
const wire = (hop: RecordedHop | undefined) => [hop?.url, hop?.headers["last-event-id"]]
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * In-process transports for consumer programs. `fake`'s i-th Connect opens `conns[i]` (a nil entry,
 * or one past the end, refuses) and records the cursor it was handed as `lastEventID/reconnectToken`;
 * a `conn` delivers its values, then fails with `fail` or blocks until its ctx ends. `chatty` always
 * has a value ready. `take` reads n values off Events() within 5 s, as JSON.
 */
const DECLS = `
type conn struct {
	kind   sdk.TransportKind
	mu     sync.Mutex
	values []any
	fail   error
}

func (c *conn) Kind() sdk.TransportKind         { return c.kind }
func (c *conn) Send(context.Context, any) error { return nil }
func (c *conn) Close() error                    { return nil }
func (c *conn) Recv(ctx context.Context) (any, error) {
	c.mu.Lock()
	if len(c.values) > 0 {
		v := c.values[0]
		c.values = c.values[1:]
		c.mu.Unlock()
		return v, nil
	}
	c.mu.Unlock()
	if c.fail != nil {
		return nil, c.fail
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

type fake struct {
	kind  sdk.TransportKind
	conns []*conn
	mu    sync.Mutex
	got   []string
}

func (f *fake) Name() string            { return "fake" }
func (f *fake) Kind() sdk.TransportKind { return f.kind }
func (f *fake) Connect(_ context.Context, _ string, o *sdk.TransportOpts) (sdk.TransportConn, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	i := len(f.got)
	f.got = append(f.got, o.LastEventID+"/"+o.ReconnectToken)
	if i >= len(f.conns) || f.conns[i] == nil {
		return nil, errors.New("refused")
	}
	return f.conns[i], nil
}

func (f *fake) connects() string { f.mu.Lock(); defer f.mu.Unlock(); return js(f.got) }

type chatty struct{}

func (chatty) Name() string                          { return "chatty" }
func (chatty) Kind() sdk.TransportKind               { return sdk.TransportWs }
func (chatty) Send(context.Context, any) error       { return nil }
func (chatty) Close() error                          { return nil }
func (chatty) Recv(ctx context.Context) (any, error) { return 1, ctx.Err() }
func (chatty) Connect(context.Context, string, *sdk.TransportOpts) (sdk.TransportConn, error) { return chatty{}, nil }

func take(rc *sdk.ResumableConnection, n int) string {
	values := []any{}
	deadline := time.After(5 * time.Second)
	for len(values) < n {
		select {
		case v, ok := <-rc.Events():
			if !ok {
				return "closed after " + js(values)
			}
			values = append(values, v)
		case <-deadline:
			return "timed out after " + js(values)
		}
	}
	return js(values)
}

func js(v any) string { b, _ := json.Marshal(v); return string(b) }

func cursor(rc *sdk.ResumableConnection) string { id, token := rc.Cursor(); return id + "/" + token }

func proven(rc *sdk.ResumableConnection) string { kind, ok := rc.ProvenTransport(); return fmt.Sprint(kind, " ", ok) }`

/** RT's SDK with the consumer `body` and DECLS (plus `decls`) beside it, run with `base` on stdin. */
function program(body: string, p: { base?: string; decls?: string; imports?: string[]; race?: true } = {}) {
	const { files } = generateGoSdk(RT, { modulePath: MODULE })
	const imports = ["errors", "sync", "time", ...(p.imports ?? [])]
	return consume(files, MODULE, { ...p, body, decls: DECLS + (p.decls ?? ""), imports })
}

/** What a consumer leg asserts: it builds, vets clean, and its notes by section. */
const ran = (run: Run) => ({ built: run.built, out: run.out, vet: run.vet })

goDescribe("a realtime method returns its connection open, its ctx bounding the open (Fd1)", () => {
	it("falls back from a refused upgrade and a refused event stream to long-poll, polling with the advanced cursor", async () => {
		const { hops, run } = await drive(rtSdk(), POLLED, [live({ take: 2 })], QUICK)
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [{ frames: [polled(1, "7").json, polled(2, "8").json], kind: "frames" }],
			stream: {
				realtime: { cursor: { lastEventId: "8", reconnectToken: "rt-8" }, errors: [], proven: "longpoll" },
				yields: 2,
			},
		})
		/* a third poll may be in flight when the driver closes: assert the prefix */
		expect(hops.slice(0, 4)).toMatchObject([
			{ headers: { upgrade: "websocket" }, url: "/feed?channel=c" },
			{ headers: { accept: "text/event-stream" }, url: "/feed?channel=c" },
			{ url: "/feed?channel=c" },
			{ url: "/feed?channel=c&last_event_id=7&reconnect_token=rt-7" },
		])
	}, 600_000)

	it("honors its ctx: canceled before the call nothing is dialed, and a deadline during the dial ends the open as a timeout", async () => {
		/* V0BUG: v0's method was `_ = ctx` and returned an unconnected connection. Long-poll connects
		 * lazily, so an open that only falls through the chain would return a live long-poll connection
		 * on a done ctx: the ctx must stop the chain itself. */
		const sdk = rtSdk()
		const canceled = await drive(sdk, [], [live({ take: 1 })], { calls: [{ cancel: "before" }] })
		const late = await drive(sdk, [{ ...refused, delayMs: 2000 }], [live({ take: 1 })], {
			calls: [{ ctxTimeoutMs: 150 }],
		})
		const seen = [canceled, late].map(({ hops, run }) => {
			const c = run.trace?.calls[0]
			const ms = c && c.elapsedMs < 1000
			return [run.observed, c?.error?.canceled, c?.error?.deadline, c?.error?.via, c?.stream, hops.length, ms]
		})
		expect(seen, canceled.run.stderr + late.run.stderr).toEqual([
			[[null], true, false, "return", undefined, 0, true],
			[[{ kind: "timeout" }], false, true, "return", undefined, 1, true],
		])
		expect(late.hops[0]?.headers.upgrade).toBe("websocket")
	}, 600_000)
})

goDescribe("the resume cursor advances past each delivered event, and a reconnect resumes from it (G12)", () => {
	// v0: f7a81e9c5c
	it("reconnects through the chain after a mid-stream drop, the next transport handed the advanced cursor", async () => {
		/* V0BUG: v0 froze the cursor at construction (realtime.go:87,93,183) and its stable adapter
		 * ignored opts, so the reconnect's stale ("0", "rt-0") passed; v1 pins ("2", "rt-2") */
		const run =
			await program(`	flaky := &fake{kind: sdk.TransportWs, conns: []*conn{{kind: sdk.TransportWs, fail: errors.New("dropped"), values: []any{
		map[string]any{"id": "1", "reconnect_token": "rt-1"}, map[string]any{"id": "2", "reconnect_token": "rt-2"}}}}}
	stable := &fake{kind: sdk.TransportSse, conns: []*conn{{kind: sdk.TransportSse, values: []any{map[string]any{"id": "3", "reconnect_token": "rt-3"}}}}}
	opts := &sdk.TransportOpts{LastEventID: "0", ReconnectToken: "rt-0", ReconnectDelayMs: 10}
	rc := sdk.NewResumableConnection("http://rt.test/feed", []sdk.Transport{flaky, stable}, opts)
	note(rc.Connect(ctx))
	note(take(rc, 3))
	note(flaky.connects(), stable.connects(), proven(rc))
	note(rc.Close(), cursor(rc), rc.State())`)
		expect(ran(run), run.stderr).toEqual({
			built: true,
			out: {
				main: [
					"<nil>",
					'[{"id":"1","reconnect_token":"rt-1"},{"id":"2","reconnect_token":"rt-2"},{"id":"3","reconnect_token":"rt-3"}]',
					'["0/rt-0","2/rt-2"] ["2/rt-2"] sse true',
					"<nil> 3/rt-3 disconnected",
				],
			},
			vet: [],
		})
	}, 600_000)

	// v0: f7a81e9c5c
	it("resumes on the wire: the reconnect's upgrade and event stream carry the last delivered id and token", async () => {
		const replies = [refused, sse([ev(1), ev(2)], "drop"), refused, sse([ev(3)], "hold")]
		const { hops, run } = await drive(rtSdk(), replies, [live({ take: 3 })], QUICK)
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [{ frames: [frame(1), frame(2), frame(3)], kind: "frames" }],
			stream: {
				realtime: { cursor: { lastEventId: "3", reconnectToken: "rt-3" }, errors: [], proven: "sse" },
				yields: 3,
			},
		})
		expect(hops.map(wire)).toEqual([
			["/feed?channel=c", undefined],
			["/feed?channel=c", undefined],
			["/feed?channel=c&last_event_id=2&reconnect_token=rt-2", undefined],
			["/feed?channel=c&reconnect_token=rt-2", "2"],
		])
		const cursor = live({ lastEventId: "0", reconnectToken: "rt-0", take: 1 })
		const resumed = await drive(rtSdk(), [refused, sse([ev(1)], "hold")], [cursor], QUICK)
		expect([resumed.run.observed, resumed.hops.map(wire)], resumed.run.stderr).toEqual([
			[{ frames: [frame(1)], kind: "frames" }],
			[
				["/feed?channel=c&last_event_id=0&reconnect_token=rt-0", undefined],
				["/feed?channel=c&reconnect_token=rt-0", "0"],
			],
		])
	}, 600_000)
})

goDescribe("every realtime dial carries the call's declared params and its own request id", () => {
	// v0: 924873c344
	it("sends channel and x-tenant on every dial over WS, SSE and long-poll, each with a fresh UUIDv4 X-Request-Id unless the caller set one", async () => {
		/* V0BUG: v0's realtime method built its URL with a nil query and dropped the declared params.
		 * Fd2: an id names one request; a caller's id is kept on every dial. */
		const reconnecting = [refused, sse([ev(1)], "drop"), refused, sse([ev(2)], "hold")]
		const runs = []
		const stderr: string[] = []
		for (const replies of [reconnecting, POLLED])
			for (const id of [undefined, "fixed"]) {
				const headers = { "x-tenant": "acme", ...(id && { "X-Request-Id": id }) }
				const { hops, run } = await drive(rtSdk(), replies, [live({ headers, take: 2 })], QUICK)
				const dials = hops.slice(0, 4)
				const ids = dials.map((hop) => hop.headers["x-request-id"])
				stderr.push(run.stderr)
				runs.push({
					distinct: new Set(ids).size,
					frames: (run.observed?.[0] as { frames?: unknown[] } | null)?.frames?.length,
					ids,
					tenants: dials.map((hop) => [hop.url.startsWith("/feed?channel=c"), hop.headers["x-tenant"]]),
				})
			}
		const fresh = { distinct: 4, frames: 2, ids: Array(4).fill(expect.stringMatching(UUID4)) }
		const kept = { distinct: 1, frames: 2, ids: Array(4).fill("fixed") }
		const tenants = Array.from({ length: 4 }, () => [true, "acme"])
		expect(runs, stderr.join("\n")).toEqual([fresh, kept, fresh, kept].map((want) => ({ ...want, tenants })))
	}, 600_000)
})

goDescribe("one resume pair on the wire: the synthetic Opts fields carry a declared resume param (Fd3)", () => {
	it("folds a declared reconnect_token, last_event_id and Last-Event-ID into the stream fields, a colliding protocols becoming Protocols2", async () => {
		/* V0BUG: v0 emitted ReconnectToken2 beside ReconnectToken and sent both pairs */
		const run = await program(
			`	for _, v := range []any{sdk.FeedLiveOpts{}, sdk.FeedResumeOpts{}} {
		t := reflect.TypeOf(v)
		names := []string{t.Name()}
		for i := range t.NumField() {
			names = append(names, t.Field(i).Name)
		}
		note(strings.Join(names, " "))
	}
	note(fmt.Sprintf("%T", client("http://rt.test").Feed.Live))`,
			{ imports: ["reflect"] },
		)
		expect(ran(run), run.stderr).toEqual({
			built: true,
			out: {
				main: [
					"FeedLiveOpts Channel XTenant LastEventID ReconnectToken Protocols MaxReconnectAttempts ReconnectDelayMs",
					"FeedResumeOpts Protocols2 LastEventID ReconnectToken Protocols MaxReconnectAttempts ReconnectDelayMs",
					"func(context.Context, *sdk.FeedLiveOpts, ...sdk.RequestOption) (*sdk.ResumableConnection, error)",
				],
			},
			vet: [],
		})
		const resume = { operation: "feed.resume", route: { method: "GET", path: "/resume" }, search: { protocols: "p" } }
		const call: Call = { ...resume, lastEventId: "5", reconnectToken: "rt", take: 1 }
		const accepted: Reply = { status: 101, ws: { steps: [{ json: { n: 1 } }] } }
		const { hops, run: dialed } = await drive(rtSdk(), [accepted], [call], {})
		expect([dialed.observed, hops.map(wire)], dialed.stderr).toEqual([
			[{ frames: [{ n: 1 }], kind: "frames" }],
			[["/resume?protocols=p&last_event_id=5&reconnect_token=rt", undefined]],
		])
	}, 600_000)
})

goDescribe("ResumableConnection over caller transports", () => {
	// v0: 708684fb00
	it("falls through a refusing transport to the next, both handed the caller's cursor, and closes both channels", async () => {
		/* v0 compared a state list the program printed itself; v1 observes each state */
		const run = await program(`	failing := &fake{kind: sdk.TransportWs}
	good := &fake{kind: sdk.TransportSse, conns: []*conn{{kind: sdk.TransportSse, values: []any{
		map[string]any{"seq": 1, "data": "hello"}, map[string]any{"seq": 2, "data": "world"}}}}}
	opts := &sdk.TransportOpts{ReconnectToken: "rt-1", LastEventID: "42"}
	rc := sdk.NewResumableConnection("http://rt.test/feed", []sdk.Transport{failing, good}, opts)
	note(rc.State())
	note(rc.Connect(ctx), rc.State(), proven(rc))
	note(take(rc, 2))
	note(failing.connects(), good.connects())
	note(rc.Close(), rc.State())
	_, events := <-rc.Events()
	_, errs := <-rc.Errors()
	note(events, errs, errors.Is(rc.Connect(ctx), sdk.ErrConnectionClosed), cursor(rc))`)
		expect(ran(run), run.stderr).toEqual({
			built: true,
			out: {
				main: [
					"disconnected",
					"<nil> connected sse true",
					'[{"data":"hello","seq":1},{"data":"world","seq":2}]',
					'["42/rt-1"] ["42/rt-1"]',
					"<nil> disconnected",
					"false false true 42/rt-1",
				],
			},
			vet: [],
		})
	}, 600_000)

	// v0: 773ef1c1f7
	it("dials only the caller's transport: the server behind the URL sees no request", async () => {
		const [run, hops] = await served([], async (server) => {
			const body = `	custom := &fake{kind: sdk.TransportWs, conns: []*conn{{kind: sdk.TransportWs, values: []any{
		map[string]any{"kind": "custom", "seq": 1}, map[string]any{"kind": "custom", "seq": 2}}}}}
	rc := sdk.NewResumableConnection(input.Base+"/feed", []sdk.Transport{custom}, nil)
	note(rc.Connect(ctx), rc.State(), proven(rc))
	note(take(rc, 2), custom.connects())
	note(rc.Close(), rc.State())`
			return [await program(body, { base: server.url }), server.hops.length] as const
		})
		expect({ ...ran(run), hops }, run.stderr).toEqual({
			built: true,
			hops: 0,
			out: {
				main: [
					"<nil> connected ws true",
					'[{"kind":"custom","seq":1},{"kind":"custom","seq":2}] ["/"]',
					"<nil> disconnected",
				],
			},
			vet: [],
		})
	}, 600_000)
})

goDescribe("the default transport adapters", () => {
	// v0: 2e7d01ed2c
	it("ships the three default adapters as Transports, and with zero TransportOpts they send no cursor", async () => {
		/* v0 built zero TransportOpts and never connected with them; v1 dials with them */
		const replies = [sse(['data: {"n":1}\n\n'], "hold"), { json: { n: 2 }, status: 200 }]
		const [run, hops] = await served(replies, async (server) => {
			const body = `	sse, lp := &sdk.SseTransport{}, &sdk.LongpollTransport{}
	for _, t := range []sdk.Transport{&sdk.WsTransport{}, sse, lp} {
		note(t.Name(), t.Kind())
	}
	note(sdk.TransportWs, sdk.TransportSse, sdk.TransportLongpoll)
	stream, err := sse.Connect(ctx, input.Base+"/feed", &sdk.TransportOpts{})
	if note(err); stream != nil {
		note(js(must(stream.Recv(ctx))), stream.Close())
	}
	poll := must(lp.Connect(ctx, input.Base+"/feed", &sdk.TransportOpts{}))
	note(js(must(poll.Recv(ctx))), poll.Close())`
			const decls =
				"\nvar _, _, _ sdk.Transport = (*sdk.WsTransport)(nil), (*sdk.SseTransport)(nil), (*sdk.LongpollTransport)(nil)"
			return [await program(body, { base: server.url, decls }), [...server.hops]] as const
		})
		expect(ran(run), run.stderr).toEqual({
			built: true,
			out: {
				main: ["ws ws", "sse sse", "longpoll longpoll", "ws sse longpoll", "<nil>", '{"n":1} <nil>', '{"n":2} <nil>'],
			},
			vet: [],
		})
		expect(hops.map((hop) => [hop.url, hop.headers.accept, hop.headers["last-event-id"]])).toEqual([
			["/feed", "text/event-stream", undefined],
			["/feed", undefined, undefined],
		])
	}, 600_000)
})

goDescribe("ResumableConnection under the race detector", () => {
	// v0: 0c1872f081
	it("gives up after MaxReconnectAttempts, keeps an SSE stream past its Connect ctx, and survives Close racing a busy read loop", async () => {
		const replies = [sse([{ waitMs: 100 }, 'data: {"n":1}\n\n'], "hold")]
		const [run, hops] = await served(replies, async (server) => {
			const body = `	section("gives up")
	failing := &fake{kind: sdk.TransportWs, conns: []*conn{{kind: sdk.TransportWs, fail: errors.New("dropped")}}}
	opts := &sdk.TransportOpts{MaxReconnectAttempts: 3, ReconnectDelayMs: 1}
	rc := sdk.NewResumableConnection("http://rt.test/feed", []sdk.Transport{failing}, opts)
	note(rc.Connect(ctx))
	select {
	case err := <-rc.Errors():
		note(err, failing.connects())
	case <-time.After(5 * time.Second):
		note("no terminal error within 5s")
	}
	note(rc.Close(), rc.State(), errors.Is(rc.Connect(ctx), sdk.ErrConnectionClosed), rc.Close())
	section("sse outlives its connect ctx")
	open, cancel := context.WithCancel(ctx)
	stream := must((&sdk.SseTransport{}).Connect(open, input.Base+"/feed", &sdk.TransportOpts{}))
	cancel()
	if stream != nil {
		note(js(must(stream.Recv(ctx))), stream.Close())
	}
	section("close race")
	closed := 0
	for range 50 {
		rc := sdk.NewResumableConnection("http://rt.test/feed", []sdk.Transport{chatty{}}, nil)
		if rc.Connect(ctx) != nil {
			continue
		}
		go func() {
			for range rc.Events() {
			}
		}()
		time.Sleep(time.Millisecond)
		if rc.Close() == nil {
			closed++
		}
	}
	note(closed)`
			return [await program(body, { base: server.url, race: true }), server.hops.length] as const
		})
		expect({ ...ran(run), hops }, run.stderr).toEqual({
			built: true,
			hops: 1,
			out: {
				"close race": ["50"],
				"gives up": ["<nil>", 'refused ["/","/","/","/"]', "<nil> disconnected true <nil>"],
				"sse outlives its connect ctx": ['{"n":1} <nil>'],
			},
			vet: [],
		})
		expect(run.stderr).not.toContain("DATA RACE")
	}, 600_000)
})
