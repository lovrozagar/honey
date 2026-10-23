/**
 * A realtime operation through the Java SDK's public API (bit 16 phase d2b, R1, R3, R7, R8; C#'s `realtime.test.ts`
 * consumer legs): the connection CONNECTED and typed, javac's view of the types and the folded params; the states and
 * a budget of 0; an interrupt mid-reconnect leaving it reconnecting; a caller's adapter under the same loop; a message
 * that does not decode, the connection kept; a claimed `…2` param sent by its wire name; and the emitted surface. The
 * driven legs: `realtime.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { AT_1, bad, consumed, consumer, drivenRealtime, ev, FEED_URL, refused, sse } from "./__fixtures__/realtime.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { generateJavaSdk, javaCallPlans } from "./sdk.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK first. */
const SLOW = { timeout: 600_000 }

const CLASH_URL = "/realtime-clash/feed?channel=c&max_reconnect_attempts=3&reconnect_delay=4"
const READ_1 = '{"n":1,"reconnect_token":"rt-1"}'
const LIVE = 'c.feed().live(FeedLiveParams.builder().channel("c")'
/** What javac holds of the realtime methods: each typed by its event schema, the folded resume params gone. */
const WRONG = `ResumableConnection<JsonNode> wrong = ${LIVE}.build());`
const CLAIMED = 'c.feed().resume(FeedResumeParams.builder().reconnectToken2("x").build());'
const TYPES = [
	"AnyrowClient c = client();",
	`ResumableConnection<Payload> x = ${LIVE}.build());`,
	'ResumableConnection<JsonNode> r = c.feed().resume(FeedResumeParams.builder().protocols2("p").lastEventId("5").reconnectToken("rt").build());',
	WRONG,
	CLAIMED,
	`${LIVE}.maxReconnectAttempts(3).reconnectDelay(Duration.ofSeconds(2)).protocols(List.of("v1")).build());`,
	"TransportOptions o = x.options();",
	"ConnectionState s = x.state();",
	"TransportKind k = x.provenTransport();",
	"for (Payload p : x) { Long n = p.n(); }",
]

describe.skipIf(!JAVA)("a realtime method: it returns ResumableConnection<T> connected (Fd6, R1, R8)", SLOW, () => {
	/* new: C# realtime.test.ts:136 (javac's view: an untyped receiver is incompatible, reconnectToken2 unknown) */
	it("returns the connection CONNECTED, typed by the event schema, DISCONNECTED after close(); the folded params gone", async () => {
		const body = `ResumableConnection<Payload> rc = client().feed().live(FeedLiveParams.builder().channel("c").build());
note(rc.state());
rc.close();
note(rc.state());`
		const { hops, out, stderr } = await consumed([refused, sse([ev(1)], "hold")], body)
		expect({ hops: hops.length, out: out?.main }, stderr).toEqual({ hops: 2, out: ["CONNECTED", "DISCONNECTED"] })
		const run = drivenRealtime().run("ai.anyrow.Probe", consumer("http://127.0.0.1:1", TYPES.join("\n")))
		const errors = run.diagnostics.filter((line) => / error: /.test(line)).map((line) => line.replace(/^.*error: /, ""))
		expect(errors).toEqual([
			expect.stringMatching(
				/^incompatible types: ResumableConnection<Payload> cannot be converted to ResumableConnection<JsonNode>$/,
			),
			"cannot find symbol",
		])
	})
})

/**
 * A caller's adapter (Fd6): each connect takes the plan's next item, one message per connection; a null fails with
 * ApiConnectionException("down"). `Slow` holds its connect 10 s, its interrupt honored.
 */
const ADAPTERS = `
final class Conn implements TransportConnection {
  private Integer item;
  boolean closed;

  Conn(int item) {
    this.item = item;
  }

  @Override
  public TransportMessage receive() {
    TransportMessage message = item == null ? null : new TransportMessage(String.valueOf(item), null, null);
    item = null;
    return message;
  }

  @Override
  public void send(String text) {}

  @Override
  public void close() {
    closed = true;
  }
}

class Fake implements TransportAdapter {
  final java.util.Deque<Integer> plan;
  final java.util.List<Conn> conns = new java.util.ArrayList<>();

  Fake(Integer... plan) {
    this.plan = new java.util.ArrayDeque<>();
    for (Integer step : plan) {
      this.plan.add(step == null ? -1 : step);
    }
  }

  @Override
  public String name() {
    return "fake";
  }

  @Override
  public TransportKind kind() {
    return TransportKind.SSE;
  }

  @Override
  public TransportConnection connect(String url, TransportOptions options) {
    Integer step = plan.poll();
    if (step == null || step < 0) {
      throw new ApiConnectionException("down", null);
    }
    conns.add(new Conn(step));
    return conns.get(conns.size() - 1);
  }
}

final class Slow extends Fake {
  @Override
  public TransportConnection connect(String url, TransportOptions options) {
    try {
      Thread.sleep(10_000);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new java.util.concurrent.CancellationException("slow");
    }
    throw new ApiConnectionException("slow", null);
  }
}
`

/** The states leg's program: a budget of 0 raising once, then a connection interrupted mid-reconnect and closed. */
const STATES = `section("no-reconnect");
ResumableConnection<Payload> rc = client().feed().live(FeedLiveParams.builder().channel("c").maxReconnectAttempts(0).reconnectDelay(Duration.ofMillis(1)).build());
note(rc.state());
note(read(rc));
note(rc.state() + " " + read(rc) + " " + read(rc));
section("reconnecting");
ResumableConnection<Payload> again = client().feed().live(FeedLiveParams.builder().channel("c").reconnectDelay(Duration.ofMillis(1)).build());
note(again.state() + " " + read(again));
Thread reader = Thread.currentThread();
CompletableFuture.delayedExecutor(1000, TimeUnit.MILLISECONDS).execute(reader::interrupt);
try {
  note(read(again));
} catch (CancellationException e) {
  Thread.interrupted();
  note("canceled " + again.state());
}
again.close();
note(again.state() + " " + read(again));`

describe.skipIf(!JAVA)("a connection's states; a caller's adapter under the same loop (Fd3, Fd6)", SLOW, () => {
	/* new: C# realtime.test.ts:293 (red under an interrupted read that ends the connection, Fd3) */
	it("is CONNECTED, RECONNECTING or DISCONNECTED; a budget of 0 never reconnects and raises once", async () => {
		/* a long-poll connect does not dial, so the 400 is the first read's. An interrupt at 1,000 ms mid-reconnect
		 * leaves the connection reconnecting: the upgrade is held 2,000 ms past it */
		const body = STATES
		const replies = [refused, refused, bad, refused, sse([ev(1)], "drop"), { ...refused, delayMs: 3000 }]
		const { hops, out, stderr } = await consumed(replies, body)
		expect({ hops, out }, stderr).toEqual({
			hops: [...Array.from({ length: 5 }, () => FEED_URL), AT_1],
			out: {
				"no-reconnect": ["CONNECTED", "err BadRequestException: HTTP 400: bad", "DISCONNECTED none none"],
				reconnecting: [`CONNECTED ok ${READ_1}`, "canceled RECONNECTING", "DISCONNECTED none"],
			},
		})
	})

	/* new: C# realtime.test.ts:315 (the cancel is the connecting thread's interrupt at 300 ms) */
	it("over a caller's adapter: clean ends reconnect, the attempts reset, dead connections close, an interrupt propagates", async () => {
		/* without the reset, the third connection's end exhausts the budget before the failing connects run:
		 * "the connection ended" in place of the adapter's own error */
		const body = `section("give-up");
Fake a = new Fake(1, 2, 3, null, null);
TransportOptions options = TransportOptions.builder().maxReconnectAttempts(2).reconnectDelay(Duration.ofMillis(1)).build();
ResumableConnection<JsonNode> rc = new ResumableConnection<>("http://t/rt", List.of(a), new tools.jackson.core.type.TypeReference<JsonNode>() {}, options);
rc.connect();
for (int i = 0; i < 5; i++) {
  note(read(rc));
}
note(rc.state() + " " + a.conns.size() + " " + a.conns.stream().allMatch(conn -> conn.closed) + " " + a.plan.size());
section("cancel");
Fake fallback = new Fake(1);
ResumableConnection<JsonNode> slow = new ResumableConnection<>("http://t/rt", List.of(new Slow(), fallback), new tools.jackson.core.type.TypeReference<JsonNode>() {});
Thread opener = Thread.currentThread();
CompletableFuture.delayedExecutor(300, TimeUnit.MILLISECONDS).execute(opener::interrupt);
try {
  slow.connect();
  note("connected");
} catch (CancellationException e) {
  note("canceled " + Thread.interrupted() + " " + (slow.state() != ConnectionState.CONNECTED) + " " + fallback.conns.size());
}`
		const { hops, out, stderr } = await consumed([], body, ADAPTERS)
		expect({ hops, out }, stderr).toEqual({
			hops: [],
			out: {
				cancel: ["canceled true true 0"],
				"give-up": ["ok 1", "ok 2", "ok 3", "err ApiConnectionException: down", "none", "DISCONNECTED 3 true 0"],
			},
		})
	})
})

describe.skipIf(!JAVA)("a message that does not decode keeps the connection; a claimed …2 is sent", SLOW, () => {
	/* new: C# realtime.test.ts:420 (Jackson refuses another JSON kind itself: `5` into Payload) */
	it("throws DecodeException for a message that does not decode, the cursor advanced and the connection kept", async () => {
		const body = `ResumableConnection<Payload> rc = client().feed().live(FeedLiveParams.builder().channel("c").reconnectDelay(Duration.ofMillis(1)).build());
note(read(rc));
note(rc.options().lastEventId());
note(read(rc));
note(rc.state());
note(rc.options().lastEventId());
rc.close();`
		const { hops, out, stderr } = await consumed([refused, sse(["id: 1\ndata: 5\n\n", ev(2)], "hold")], body)
		const decode = expect.stringMatching(/^err DecodeException: a message does not decode: /)
		/* the cursor is past the message that did not decode before the next read: advanced before the decode */
		const want = [2, [decode, "1", 'ok {"n":2,"reconnect_token":"rt-2"}', "CONNECTED", "2"]]
		expect([hops.length, out?.main], stderr).toEqual(want)
	})

	/* new: C# realtime.test.ts:454 (Java's clash.feed in the realtime fixture) */
	it("sends a claimed …2 param by its wire name beside a budget of 0", async () => {
		const body = `ResumableConnection<Payload> rc = client().clash().feed(ClashFeedParams.builder().channel("c").maxReconnectAttempts2(3L).reconnectDelay2(4L).maxReconnectAttempts(0).build());
note(read(rc));
note(read(rc));`
		const { hops, out, stderr } = await consumed([refused, refused, bad], body)
		const want = [
			[CLASH_URL, CLASH_URL, CLASH_URL],
			["err BadRequestException: HTTP 400: bad", "none"],
		]
		expect([hops, out?.main], stderr).toEqual(want)
	})
})

/** The realtime javadoc's last sentence (contract 50 §2), read across GJF's wrap: one per realtime method overload. */
const DOC = "It reconnects after a drop and resumes after the last message it delivered; close() ends it."
/** The methods' signatures and the clash fold, by the same rules (its clashing queries claimed `…2`). */
const EMITTED = {
	"ClashResource.java": [
		"  public ResumableConnection<Payload> feed(ClashFeedParams params, RequestOptions options) {",
		'            Call.Arg.of("max_reconnect_attempts", params.maxReconnectAttempts2()),',
		'            Call.Arg.of("reconnect_delay", params.reconnectDelay2()));',
	],
	"FeedResource.java": [
		"  public ResumableConnection<Payload> live(FeedLiveParams params) {",
		"  public ResumableConnection<JsonNode> resume(FeedResumeParams params, RequestOptions options) {",
		'    List<Call.Arg> query = List.of(Call.Arg.of("protocols", params.protocols2()));',
		"        TransportOptions.of(",
		"    return Realtime.open(",
	],
}
const CLAIMS = {
	channel: "channel",
	max_reconnect_attempts: "maxReconnectAttempts2",
	reconnect_delay: "reconnectDelay2",
}

describe("the emitted realtime surface: the stream fields reserved, a clashing declared param claimed …2", () => {
	/* new: C# realtime.test.ts:493 */
	it("emits the methods and fields, the javadoc on each overload, and claims max_reconnect_attempts and reconnect_delay as …2", () => {
		const files = generateJavaSdk(FIXTURES.realtime.document()).files
		const lines = (name: string) => (files[`src/main/java/ai/anyrow/${name}`] ?? "").split("\n")
		const missing = Object.entries(EMITTED).flatMap(([name, want]) => want.filter((l) => !lines(name).includes(l)))
		const prose = (name: string) =>
			lines(name)
				.map((l) => l.replace(/^\s*\* ?/, ""))
				.join(" ")
		const docs = ["ClashResource.java", "FeedResource.java"].map((name) => prose(name).split(DOC).length - 1)
		const plan = javaCallPlans(FIXTURES.realtime.document())["clash.feed"]
		const fields = { ...plan, accessors: undefined }
		expect({ docs, missing, query: plan?.query }).toEqual({ docs: [2, 4], missing: [], query: CLAIMS })
		expect(fields).toEqual(
			expect.objectContaining({
				idempotencyKey: null,
				lastEventId: "lastEventId",
				maxReconnectAttempts: "maxReconnectAttempts",
				protocols: "protocols",
				reconnectDelay: "reconnectDelay",
				reconnectToken: "reconnectToken",
				stream: "realtime",
			}),
		)
	})
})
