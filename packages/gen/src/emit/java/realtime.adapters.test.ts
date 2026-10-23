/**
 * A realtime connection over a caller's in-process adapters (bit 16 phase d2b, R1, R3, R5; C#'s
 * `realtime.transports.test.ts` in-process sections, Fd3, Fd6): a refusing adapter skipped, one adapter alone, resume
 * with the advanced cursor while RECONNECTING, clean ends and the give-up, an interrupted connect, a session, a
 * cancel-safe read, a close race. One program runs every section against a server it never dials.
 */
import { describe, expect, it } from "vitest"
import { withJava } from "./__fixtures__/java-env.ts"
import { notesOf, runner } from "./__fixtures__/realtime-program.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK first. */
const SLOW = { timeout: 600_000 }
/** This file's programs, each run once and shared by its legs. */
const servedRun = runner()

/** A connection over the in-process adapters `adapters` at an address nothing serves, with `options`. */
const rc = (adapters: string, options = "") =>
	`ResumableConnection<JsonNode> rc = new ResumableConnection<>("http://rt.test/feed", List.of(${adapters}), Rt.ELEMENT${options === "" ? "" : `, ${options}`});`
const delay = (ms: number, more = "") =>
	`TransportOptions.builder()${more}.reconnectDelay(Duration.ofMillis(${ms})).build()`
/** Interrupts this thread after `ms`, the caller's cancel (R3). */
const interruptAfter = (ms: number) =>
	`Thread self = Thread.currentThread();\nCompletableFuture.delayedExecutor(${ms}, TimeUnit.MILLISECONDS).execute(self::interrupt);`

/** The in-process sections: none of them sends a request. */
const IN_PROCESS: Readonly<Record<string, string>> = {
	states: `note(Rt.json(ConnectionState.values()));
Fake bad = new Fake(TransportKind.WS, (Conn) null);
Fake good = new Fake(TransportKind.SSE, new Conn(List.of("{\\"seq\\":1}", "{\\"seq\\":2}")));
${rc("bad, good")}
String before = rc.state().toString();
rc.connect();
note(Rt.j(before, rc.state().toString(), rc.provenTransport().toString(), bad.got.size(), good.got.size()));
note(Rt.json(Rt.take(rc, 2)));
rc.close();
note(Rt.j(rc.state().toString(), Rt.take(rc, 1).get(0)));`,
	custom: `Fake one = new Fake(TransportKind.WS, new Conn(List.of("{\\"kind\\":\\"custom\\",\\"seq\\":1}", "{\\"kind\\":\\"custom\\",\\"seq\\":2}")));
ResumableConnection<JsonNode> rc = new ResumableConnection<>(BASE + "/feed", List.of(one), Rt.ELEMENT);
rc.connect();
note(Rt.json(Rt.take(rc, 2)));
note(Rt.j(one.got, rc.provenTransport().toString(), rc.state().toString()));
rc.close();
note(Rt.j(rc.state().toString()));`,
	resume: `Fake flaky = new Fake(TransportKind.WS, new Conn(List.of("{\\"id\\":\\"1\\",\\"reconnect_token\\":\\"rt-1\\"}", "{\\"id\\":\\"2\\",\\"reconnect_token\\":\\"rt-2\\"}"), "fail"), null);
Fake stable = new Fake(TransportKind.SSE, new Conn(List.of("{\\"id\\":\\"3\\",\\"reconnect_token\\":\\"rt-3\\"}")));
${rc("flaky, stable", delay(10, '.lastEventId("0").reconnectToken("rt-0")'))}
flaky.rc = rc;
stable.rc = rc;
rc.connect();
note(Rt.json(Rt.take(rc, 3)));
note(Rt.j(flaky.got, stable.got, Rt.cursor(rc)));
note(Rt.j(flaky.states.subList(1, flaky.states.size()), stable.states));
rc.close();`,
	plan: `Conn[] conns = {new Conn(List.of("1"), "end"), new Conn(List.of("2"), "end"), new Conn(List.of("3"), "end")};
Fake plan = new Fake(TransportKind.WS, conns[0], conns[1], conns[2], null, null);
${rc("plan", delay(1, ".maxReconnectAttempts(2)"))}
rc.connect();
note(Rt.json(Rt.take(rc, 5)));
note(Rt.j(plan.got.size(), Arrays.stream(conns).map(conn -> conn.closed).toList(), rc.state().toString()));
ResumableConnection<JsonNode> late = new ResumableConnection<>("http://rt.test/feed", List.of(new Fake(TransportKind.WS, new Conn(List.of(), "hold", 10_000))), Rt.ELEMENT);
${interruptAfter(300)}
try {
  late.connect();
  note(Rt.j("opened"));
} catch (CancellationException e) {
  note(Rt.j("canceled", late.state() != ConnectionState.CONNECTED));
}`,
	session: `Conn conn = new Conn(List.of("{\\"n\\":1}"));
${rc("new Fake(TransportKind.WS, conn)")}
rc.connect();
note(Rt.j(rc.state().toString(), rc.provenTransport().toString()));
rc.sendJson(Json.MAPPER.readTree("{\\"hi\\":1,\\"é\\":\\"ü\\"}"));
rc.send("as is");
note(Rt.json(conn.sent));
note(Rt.json(Rt.take(rc, 1)));
rc.close();
note(Rt.j(rc.state().toString(), Rt.take(rc, 1).get(0), conn.closed));
note(Rt.send(rc, 2));`,
	"give-up": `Fake failing = new Fake(TransportKind.WS, new Conn(List.of(), "fail"));
${rc("failing", delay(1, ".maxReconnectAttempts(3)"))}
rc.connect();
note(Rt.json(Rt.take(rc, 3)));
note(Rt.j(failing.got, rc.state().toString(), rc.provenTransport() == null));
note(Rt.send(rc, 1));`,
	"cancel-safe": `Fake dying = new Fake(TransportKind.WS, new Conn(List.of(), "fail"), new Conn(List.of("{\\"ok\\":true}"), "hold", 10_000), new Conn(List.of("{\\"ok\\":true}")));
${rc("dying", delay(10))}
rc.connect();
CompletableFuture<String> reading = new CompletableFuture<>();
Thread reader = new Thread(() -> {
  try {
    reading.complete(rc.receive() == null ? "ended" : "delivered");
  } catch (CancellationException e) {
    reading.complete("canceled " + rc.state());
  }
});
reader.start();
dying.redialed.await(5, TimeUnit.SECONDS);
reader.interrupt();
note(Rt.j(reading.get(5, TimeUnit.SECONDS)));
note(Rt.json(Rt.take(rc, 1)));
note(Rt.j(rc.state().toString(), dying.got.size()));
rc.close();`,
	"close-race": `Conn held = new Conn(List.of());
Fake fake = new Fake(TransportKind.WS, held);
${rc("fake")}
rc.connect();
CompletableFuture<JsonNode> next = CompletableFuture.supplyAsync(rc::receive);
held.waiting.await(5, TimeUnit.SECONDS);
rc.close();
note(Rt.j(next.get(2, TimeUnit.SECONDS) != null, rc.state().toString(), fake.got.size()));`,
}

/** The in-process run, every in-process section in one program against a server it never dials. */
const transports = () => servedRun("realtime-transports", IN_PROCESS, [])

/** In-process section `name` as `expect`'s two arguments: whether it ran with its notes, and its stderr. */
async function inProcess(name: string): Promise<readonly [unknown, string]> {
	const { run } = await transports()
	return [notesOf(run, name), run.stderr]
}

/** What a section must have answered: it ran to its end with `notes`. */
const ran = (notes: readonly unknown[]) => ({ notes, ran: true })

const CLOSED = ["ApiConnectionException: the connection is not open", "DISCONNECTED"]

describe.skipIf(!JAVA)("ResumableConnection over in-process adapters: the open and the resume (R5)", SLOW, () => {
	/* new: C# realtime.transports.test.ts:440 */
	it("skips a refusing adapter: DISCONNECTED, then CONNECTED over the next one, proven SSE, two messages, then DISCONNECTED", async () => {
		const states = ["CONNECTED", "RECONNECTING", "DISCONNECTED"]
		const opened = ["DISCONNECTED", "CONNECTED", "SSE", 1, 1]
		const taken = [{ seq: 1 }, { seq: 2 }]
		expect(...(await inProcess("states"))).toEqual(ran([states, opened, taken, ["DISCONNECTED", null]]))
	})

	/* new: C# realtime.transports.test.ts:448 */
	it("dials only the caller's one adapter: one connect, proven WebSocket, and the server behind the URL sees no request", async () => {
		const custom = [1, 2].map((seq) => ({ kind: "custom", seq }))
		expect(...(await inProcess("custom"))).toEqual(ran([custom, [["/"], "WS", "CONNECTED"], ["DISCONNECTED"]]))
		expect((await transports()).hops).toEqual([])
	})

	/* new: C# realtime.transports.test.ts:456. Each connect records the cursor it was handed before the delivery that
	 * advances it, so a delivery without the advance hands the reconnect "0/rt-0" again */
	it("reconnects after a mid-stream drop through the next adapter while RECONNECTING, each dial handed the advanced cursor", async () => {
		const ids = [1, 2, 3].map((id) => ({ id: `${id}`, reconnect_token: `rt-${id}` }))
		const handed = [["0/rt-0", "2/rt-2"], ["2/rt-2"], "3/rt-3 SSE CONNECTED"]
		expect(...(await inProcess("resume"))).toEqual(ran([ids, handed, [["RECONNECTING"], ["RECONNECTING"]]]))
	})

	/* new: C# realtime.transports.test.ts:464 (each clean end reconnects and a delivery resets the attempts; the give-up
	 * raises the last failure once, then the reads end; a connect interrupted by its caller throws) */
	it("reconnects after each clean end, then gives up with the real failure once, closing every dead conn; an interrupted connect throws", async () => {
		const taken = [1, 2, 3, "ApiConnectionException: refused", null]
		const after = [5, [true, true, true], "DISCONNECTED"]
		expect(...(await inProcess("plan"))).toEqual(ran([taken, after, ["canceled", true]]))
	})
})

describe.skipIf(!JAVA)("ResumableConnection over in-process adapters: a session and its end (R1, R3)", SLOW, () => {
	/* new: C# realtime.transports.test.ts:474 (Jackson writes non-ASCII as UTF-8, as Python does; C#'s STJ escapes it) */
	it("drives one session: a send as compact JSON or text as is, a read, a close to DISCONNECTED, then its end and a refused send", async () => {
		const sent = ['{"hi":1,"é":"ü"}', "as is"]
		const notes = [["CONNECTED", "WS"], sent, [{ n: 1 }], ["DISCONNECTED", null, true], CLOSED]
		expect(...(await inProcess("session"))).toEqual(ran(notes))
	})

	/* new: C# realtime.transports.test.ts:481 */
	it("gives up after maxReconnectAttempts: the last failure once, then its end, DISCONNECTED with no proven transport", async () => {
		const taken = ["ApiConnectionException: refused", null, null]
		const after = [["/", "/", "/", "/"], "DISCONNECTED", true]
		expect(...(await inProcess("give-up"))).toEqual(ran([taken, after, CLOSED]))
	})

	/* new: C# realtime.transports.test.ts:490. The reader is interrupted once the reconnect's second connect starts (a 10 s
	 * dial); an interrupt that ended the connection would read DISCONNECTED, then the connection's end */
	it("keeps a read cancel-safe: one interrupted mid-reconnect leaves it RECONNECTING, and the next delivers", async () => {
		const notes = [["canceled RECONNECTING"], [{ ok: true }], ["CONNECTED", 3]]
		expect(...(await inProcess("cancel-safe"))).toEqual(ran(notes))
	})

	/* new: C# realtime.transports.test.ts:496 (the close comes once the read waits in the conn) */
	it("ends a receive pending on another thread with null when close() runs: DISCONNECTED, and no reconnect", async () => {
		expect(...(await inProcess("close-race"))).toEqual(ran([[false, "DISCONNECTED", 1]]))
	})
})
