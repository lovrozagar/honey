/**
 * Realtime transports (bit 16 phase d2b, R2, R6; C#'s `realtime.transports.test.ts`, contract 50 §5.7): `TransportOptions`,
 * `TransportKind` and a realtime call's default adapters (ws, sse, longpoll) in their chain, a custom order of them, and
 * `RequestOptions.raw` per transport; the SSE and long-poll adapters alone through the call's exchange (the hooks, the
 * advancing cursor, one message per answer, a 204 polling again, a poll bounded at 60 s whatever the client's timeout, a
 * POSTed send and its 405). One consumer program per section, each on its own server. A caller's in-process adapters:
 * `realtime.adapters.test.ts`.
 */
import { describe, expect, it } from "vitest"
import type { RecordedHop, Reply } from "../shared/__fixtures__/recording-server.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { notesOf, runner } from "./__fixtures__/realtime-program.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK first. */
const SLOW = { timeout: 600_000 }
/** This file's programs, each run once and shared by its legs. */
const servedRun = runner()

const refused: Reply = { json: { message: "no" }, status: 404 }
const held = (steps: readonly string[]): Reply => ({ sse: { end: "hold", steps }, status: 200 })
const upgraded: Reply = { status: 101, ws: { steps: [] } }
const posted: Reply = { json: {}, status: 200 }
const unposted: Reply = { json: { message: "no" }, status: 405 }
const unavailable: Reply = { status: 503, text: "" }
const bad: Reply = { json: { message: "no" }, status: 400 }
/** A call refused over WebSocket and SSE opens over long-poll, which dials nothing: its URL and adapters, two hops in. */
const SETUP = `String url;
List<TransportAdapter> adapters;
try (ResumableConnection<Payload> setup = c.feed().live(feed())) {
  url = setup.url();
  adapters = setup.adapters();
}`
/** A client with `config` and a request hook recording each dial as `[URL sent, its path]` into `hooked`. */
const hooked = (config = "") => `List<String[]> hooked = Collections.synchronizedList(new ArrayList<>());
AnyrowClient c = AnyrowClient.builder().baseUrl(BASE).bearerToken("tok")${config}.onRequest(Rt.hook(hooked)).build();`
/** A connection over the setup's adapter `i` with `options`, connected, then `text` on it. */
const alone = (i: number, options: string, text: string) =>
	`try (ResumableConnection<JsonNode> rc = new ResumableConnection<>(url, List.of(adapters.get(${i})), Rt.ELEMENT${options})) {
  rc.connect();
${text}
}`
/** Take `n`, then send `{"hi":1}` and `{"hi":2}`, each noted. */
const readSend = (n: number) => `  note(Rt.json(Rt.take(rc, ${n})));
  note(Rt.send(rc, 1));
  note(Rt.send(rc, 2));`
/** The long-poll answers: a message with a cursor, an array as one message, and one held past the client's timeout. */
const [POLLED, PAIR, LATE]: readonly Reply[] = [
	{ json: { id: "7", n: 2, reconnect_token: "rt-7" }, status: 200 },
	{ json: [{ n: 3 }, { n: 4 }], status: 200 },
	{ delayMs: 2500, json: { n: 5 }, status: 200 },
]
const NO_RETRY = ", TransportOptions.builder().maxReconnectAttempts(0).build()"

/** The server-backed sections: each one's replies, and its body, run against its own server. */
const ADAPTERS: Readonly<Record<string, { readonly body: string; readonly replies: readonly Reply[] }>> = {
	names: {
		body: `TransportOptions o = TransportOptions.builder().build();
note(Rt.j(o.lastEventId(), o.reconnectToken(), o.protocols(), o.maxReconnectAttempts(), o.reconnectDelay().toString()));
TransportOptions t = TransportOptions.builder().lastEventId("42").reconnectToken("tok").protocols(List.of("v1")).maxReconnectAttempts(3).reconnectDelay(Duration.ofMillis(500)).build();
note(Rt.j(t.lastEventId(), t.reconnectToken(), t.protocols(), t.maxReconnectAttempts(), t.reconnectDelay().toString()));
note(Rt.json(TransportKind.values()));
AnyrowClient c = AnyrowClient.builder().baseUrl(BASE).bearerToken("tok").build();
try (ResumableConnection<Payload> conn = c.feed().live(feed())) {
  List<Object[]> named = new ArrayList<>();
  for (TransportAdapter a : conn.adapters()) {
    named.add(Rt.named(a));
  }
  note(Rt.json(named));
}`,
		replies: [upgraded],
	},
	defaults: {
		body: `AnyrowClient c = AnyrowClient.builder().baseUrl(BASE).bearerToken("tok").build();
try (ResumableConnection<Payload> first = c.feed().live(feed())) {
  note(Rt.proven(first));
  List<TransportAdapter> a = first.adapters();
  try (ResumableConnection<JsonNode> custom = new ResumableConnection<>(first.url(), List.of(a.get(1), a.get(0), a.get(2)), Rt.ELEMENT)) {
    custom.connect();
    note(Rt.proven(custom));
  }
}
for (int i = 0; i < 2; i++) {
  try (ResumableConnection<Payload> conn = c.feed().live(feed())) {
    note(Rt.proven(conn));
  }
}`,
		replies: [upgraded, held([]), refused, held([]), refused, unavailable],
	},
	raw: {
		body: `${hooked()}
String host = URI.create(BASE).getAuthority();
for (int i = 0; i < 3; i++) {
  RawResponse raw = new RawResponse();
  try (ResumableConnection<Payload> conn = c.feed().live(feed(), RequestOptions.builder().raw(raw).build())) {
    note(Rt.j(raw.status(), raw.url().toString().replace(host, "H")));
    note(Rt.proven(conn));
  }
}
note(Rt.json(hooked));`,
		replies: [upgraded, refused, held([]), refused, unavailable],
	},
	sse: {
		body: `${hooked()}\n${SETUP}\n${alone(1, "", readSend(1))}\nnote(Rt.json(hooked));`,
		replies: [refused, refused, held(['data: {"n":1}\n\n']), posted, unposted],
	},
	/* the warm call first: unbounded (per-call timeout 0), so no bounded dial or send is the client's first request */
	longpoll: {
		body: `${hooked(".timeout(Duration.ofMillis(300))")}
c.feed().live(feed(), RequestOptions.builder().timeout(Duration.ZERO).build()).close();
${SETUP}
${alone(2, NO_RETRY, `${readSend(2)}\n  note(Rt.json(Rt.take(rc, 1)));`)}
note(Rt.json(hooked));`,
		replies: [refused, refused, refused, refused, POLLED, { status: 204 }, PAIR, posted, unposted, LATE],
	},
	refused: {
		body: `AnyrowClient c = AnyrowClient.builder().baseUrl(BASE).bearerToken("tok").build();
${SETUP}
${alone(2, NO_RETRY, "  note(Rt.json(Rt.take(rc, 2)));")}
try {
  new ResumableConnection<>(url, List.of(adapters.get(1)), Rt.ELEMENT).connect();
  note(Rt.j("opened"));
} catch (RuntimeException e) {
  note(Rt.j(Rt.failed(e)));
}`,
		replies: [refused, refused, bad, bad],
	},
}

/** Section `name` of ADAPTERS in its own program. */
function adapterRun(name: string) {
	const section = ADAPTERS[name]
	if (section === undefined) throw new Error(`ADAPTERS has no section ${name}`)
	return servedRun(`realtime-adapters-${name}`, { [name]: section.body }, section.replies)
}

/** A hop as `METHOD url kind`: an upgrade, an event-stream open, a poll, or a POST's content type and JSON body. */
function dial(hop: RecordedHop): string {
	if (hop.method === "POST") return `POST ${hop.url} ${hop.body.contentType} ${JSON.stringify(hop.body.json)}`
	const kind =
		hop.headers.upgrade === "websocket" ? "upgrade" : hop.headers.accept === "text/event-stream" ? "sse" : "poll"
	return `${hop.method} ${hop.url} ${kind}`
}

/** Section `name` of ADAPTERS as `expect`'s two arguments: whether it ran, its notes and its hops, and its stderr. */
async function adapted(name: string): Promise<readonly [unknown, string]> {
	const { hops, run } = await adapterRun(name)
	return [{ ...notesOf(run, name), hops: hops.map(dial) }, run.stderr]
}

/** What a server-backed section must have answered: it ran to its end with `notes`, dialing `hops`. */
const dialed = (hops: readonly string[], notes: readonly unknown[]) => ({ hops, notes, ran: true })

/** What the request hook saw for `hops`: each dial but the upgrades (no hook on a WS dial), its URL and its path. */
const hookedOf = (hops: readonly string[]) =>
	hops.filter((hop) => !hop.endsWith(" upgrade")).map((hop) => [hop.split(" ")[1], "/feed"])

const BARE = "/feed?channel=c"
const CURSOR = `${BARE}&last_event_id=7&reconnect_token=rt-7`
const [UPGRADE, SSE, POLL] = [`GET ${BARE} upgrade`, `GET ${BARE} sse`, `GET ${BARE} poll`]
const POSTS = [1, 2].map((n) => `POST ${BARE} application/json {"hi":${n}}`)
const SENDS = [["sent"], ["UnexpectedStatusException: HTTP 405: no", "CONNECTED"]]

describe.skipIf(!JAVA)("the TransportAdapter interface and a realtime call's default chain (R2, R6)", SLOW, () => {
	/* new: C# realtime.transports.test.ts:384 */
	it("ships TransportOptions with its defaults, TransportKind's three kinds, and a call's ws, sse and longpoll adapters of their own classes", async () => {
		const opts = [
			[null, null, [], 5, "PT1S"],
			["42", "tok", ["v1"], 3, "PT0.5S"],
		]
		const kinds = ["WS", "SSE", "LONG_POLL"]
		const adapters = [
			["ws", "WS", true],
			["sse", "SSE", true],
			["longpoll", "LONG_POLL", true],
		]
		expect(...(await adapted("names"))).toEqual(dialed([UPGRADE], [...opts, kinds, adapters]))
	})

	/* new: C# realtime.transports.test.ts:395 (the long-poll open sends nothing: its first poll waits for the first read) */
	it("opens a call over WebSocket, else SSE, else long-poll, and a custom chain of its adapters in the caller's order", async () => {
		const hops = [UPGRADE, SSE, UPGRADE, SSE, UPGRADE, SSE]
		expect(...(await adapted("defaults"))).toEqual(dialed(hops, ["ws", "sse", "sse", "longpoll"]))
	})

	/* new: C# realtime.transports.test.ts:402 (raw holds the answer the connection last opened with; the request hooks
	 * run on the SSE dials only) */
	it("fills RequestOptions.raw with the real dialed answer: 101 and ws:// for WebSocket, 200 and http:// for SSE and long-poll", async () => {
		const hops = [UPGRADE, UPGRADE, SSE, UPGRADE, SSE]
		const opened = [[101, `ws://H${BARE}`], "ws", [200, `http://H${BARE}`], "sse", [200, `http://H${BARE}`], "longpoll"]
		expect(...(await adapted("raw"))).toEqual(dialed(hops, [...opened, hookedOf(hops)]))
	})
})

describe.skipIf(!JAVA)("a call's SSE and long-poll adapters on their own, sending by POSTing the JSON", SLOW, () => {
	/* new: C# realtime.transports.test.ts:411 */
	it("receives over the SSE adapter through the call's exchange, a send POSTed with the client's auth and a 405 its error", async () => {
		const hops = [UPGRADE, SSE, SSE, ...POSTS]
		expect(...(await adapted("sse"))).toEqual(dialed(hops, [[{ n: 1 }], ...SENDS, hookedOf(hops)]))
		const auth = (await adapterRun("sse")).hops.map((hop) => [hop.headers.authorization, hop.headers["last-event-id"]])
		expect(auth).toEqual(hops.map(() => ["Bearer tok", undefined]))
	})

	/* new: C# realtime.transports.test.ts:422. Each poll uses the connection's own advancing cursor, never a copy taken at
	 * connect, and is bounded at 60 s, so a 300 ms client timeout does not fail a poll answered at 2,500 ms. One poll per
	 * message (a 204 polls again), none ahead of the reader. The first two hops are the warm call's */
	it("polls over the long-poll adapter with its advancing cursor, one message per answer, a 204 polling again, a poll bounded by 60 s", async () => {
		const polled = `GET ${CURSOR} poll`
		const hops = [UPGRADE, SSE, UPGRADE, SSE, POLL, polled, polled, ...POSTS, polled]
		const messages = [{ id: "7", n: 2, reconnect_token: "rt-7" }, [{ n: 3 }, { n: 4 }]]
		expect(...(await adapted("longpoll"))).toEqual(dialed(hops, [messages, ...SENDS, [{ n: 5 }], hookedOf(hops)]))
		const auth = (await adapterRun("longpoll")).hops.map((hop) => hop.headers.authorization)
		expect(auth).toEqual(hops.map(() => "Bearer tok"))
	})

	/* new: C# realtime.transports.test.ts:432 */
	it("surfaces a long-poll 400 from the read once, then its end, and an SSE 400 from connect()", async () => {
		const refusal = "BadRequestException: HTTP 400: no"
		expect(...(await adapted("refused"))).toEqual(dialed([UPGRADE, SSE, POLL, SSE], [[refusal, null], [refusal]]))
	})
})
