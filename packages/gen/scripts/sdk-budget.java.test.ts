/**
 * The Java SDK's budgets (bit 16): the vendored runtime's bytes on disk (the G14 analog), measured, every file named,
 * split from `sdk-budget.test.ts` at its 500-line cap; and the per-operation token ceiling (the G13 analog, phase f).
 */
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { generateJavaSdk, javaCallPlans, runtimeFiles } from "../src/emit/java/sdk.ts"
import { ceilingOf, countTokens } from "./capture-token-budget.ts"
import { runtimeBytes, v1JavaSdkSurfaces } from "./sdk-budget.ts"

/*
 * G14 analog (bit 16), locked at phase f at the exact measured bytes (zero headroom, as C#'s 129,851), over every
 * runtime file:
 * - phase a, 450 B: Transport.java 450, the one HttpClient, built once on followRedirects(NEVER), and its base URL;
 * - phase b, +3,816 B to 4,266 B: Opt.java 3,106, the three-state optional (absent, null, value) with its reader and
 *   writer, equals/hashCode/toString for the records that hold one; Json.java 710, the one mapper, unknown properties
 *   ignored and the Opt module registered. Nothing dead to cut: each member is reached by a model or a record.
 * - phase c1, +47,695 B to 51,961 B, after a 1,345 B cut (one percent-encoder, one hook loop, one parse of an error
 *   body, the duplicated helpers and the docs that restated their records):
 *   - the request, 10,199 B: Operation 395 and Call 589, an operation's description and one call's values; Body
 *     3,832, BinaryBody 943 and FilePart 214, the JSON, form, text, binary and multipart bodies; UrlPath 1,550 and
 *     UrlQuery 2,676, the path segments and the query, percent-encoded through one encoder;
 *   - the exchange, 16,756 B: Exchange 920, a client's one HTTP client and credential; Flight 8,510, one call's hops,
 *     its auth retry and its one deadline; ClientConfig 5,206 and RequestOptions 2,120, the client's config and one
 *     call's overrides;
 *   - the answer, 3,429 B: Answer 1,604, read as the call's type or as a Result; RawResponse 1,176, the raw box;
 *     Result 649, safe mode's Ok and Err;
 *   - the errors, 9,435 B: HoneyException 391, the base; ApiException 3,634, the status error with its key, detail,
 *     envelope and decodeBody; Envelope 4,691, the envelope's reader and the detail's sanitizer (R3); ErrorEnvelope
 *     719, its members;
 *   - auth, 1,442 B: Credential, the token and its single-flight refresh;
 *   - hooks and the log, 6,434 B: Hooks 1,338, RequestContext 1,506, ResponseContext 1,191, RequestHook 314 and
 *     ResponseHook 338, the hooks and what they may change; CallLog 1,382 and LogEntry 365, the log lines.
 * - phase c2, +28,805 B to 80,766 B measured, the ceiling 80,800 B; nothing dead to cut (every member is reached by
 *   the exchange or an emitted call, the five-argument Operation constructor keeps every c1 operation's bytes):
 *   - stale tracking, 13,365 B, a baseline exchange feature at sibling parity (shipped with every operation SDK):
 *     StaleTracker 8,782, the bounded, lapsing marks and their O(1) lookup; InvalidationConfig 2,175, its config;
 *     StaleMeta 505; the selector, isStale and invalidatedBy on RequestContext 562 and ResponseContext 562; the
 *     invalidates targets on Operation 266; the tracker on Exchange 142 and its config on ClientConfig 371;
 *   - redirects, 4,918 B: Redirects 4,237, the follow policy, the 303 rewrite, the body resend and the cross-origin
 *     strip; RedirectPolicy 402; its config on ClientConfig 279;
 *   - the bounded decode, 4,850 B: Decode 4,358, gzip and deflate counted against maxResponseBytes in 64 KiB reads
 *     before the one exact array, under the deadline; its config and 100 MiB default on ClientConfig 492;
 *   - the hops, +3,448 B net: Hops 4,325, the request built and checked per hop (a JDK header refusal is the SDK's
 *     ConfigException) and sent under the one deadline, split from Flight (-877 B) so Flight runs the follow loop;
 *   - the deadline, 1,052 B: Deadline, the call's one bound, checked before each hop and in the decode, expiring as
 *     ApiTimeoutException;
 *   - typed response headers, 1,164 B: Answer's header reader and its strict boolean parse;
 *   - UrlQuery +8 B: google-java-format's re-wrap of one doc comment.
 * - phase d1, +18,815 B to 99,581 B measured, the ceiling 99,600 B, after a 392 B cut (the open's answer finished
 *   as a call's: one received log, raw fill, status error and stale settle): SSE, core (shipped with every operation
 *   SDK, C#'s CORE set; its SSE core is 13,275 B), nothing dead to cut (every member is reached by an emitted stream
 *   method):
 *   - the stream and its parser, 8,976 B: Sse 5,017, the WHATWG parser over bounded 64 KiB reads with its 1 MiB line
 *     and 8 MiB event caps; EventStream 3,632, read once, its cursor the last delivered id, released by its end, an
 *     error, close or an interrupt; SseEvent 327;
 *   - the body's pump, 4,287 B: Pump, the publisher read through a queue any interrupt ends (JDK 17's own body stream
 *     ignores one), its demand one buffer list at a time, a cancel held until the subscription arrives;
 *   - the open, 3,851 B: Flight +2,877, the exchange's stream mode (the 2xx body left live, a refused open's body read at
 *     most 64 KiB under the deadline, the hooks, raw, headersInto and the stale settle at the open); Hops +338, the open
 *     whose deadline bounds the headers alone; Exchange +432, its entry; Call +204, the cursor sent only when set;
 *   - decoding as it flows, 1,701 B: Decode's stream decoder, gzip or deflate started on the first read.
 * - phase d2a, +21,598 B to 121,179 B measured, the ceiling 121,200 B, after a 175 B cut (the end's second once-flag,
 *   the keepalive's own stop flag folded into the socket's end, the facade's text helper): WebSocket, shipped only with
 *   an SDK that has a WebSocket operation (C#'s WS set, 16,564 B; Java's 5,042 B more is what the JDK leaves to its
 *   caller: the keepalive, the send gate and the client's legal close codes), nothing dead to cut (every member is
 *   reached by an emitted socket method):
 *   - the socket, 9,393 B: Socket, the JDK listener assembling each message up to 16 MiB (refused within one partial,
 *     closed 1008), its demand pulled by receive alone, the one send gate every frame and ping takes, a remote end
 *     queued behind the messages before it, the server's close echoed, close()'s echo awaited, one end event;
 *   - the dial, 6,018 B net: WsDial 6,026, the call's headers layered with no hook and no log, a restricted name refused,
 *     the subprotocols offered, the call's timeout bounding the handshake alone, a refused handshake as its status
 *     exception (its body read at most 64 KiB) or a named 101 failure; Hops -8, its header check shared;
 *   - the surface, 4,547 B: TypedWebSocket 2,760, the public socket (receive, the sends, the closes, closedBy,
 *     subprotocol, the handlers); WsClose 1,348, the close and the codes a client may send (1000, 1001, 1008, 1011 and
 *     3000-4999), its reason cut to 123 bytes on a code point; WsMessage 439;
 *   - the keepalive, 1,640 B: Keepalive, a ping each 20 s through the gate, its pong clock started when it is sent, an
 *     unanswered one ending the socket (C#'s KeepAliveInterval and KeepAliveTimeout, ClientWebSocket's own).
 * - phase d2b, +28,836 B to 150,015 B measured, the ceiling 150,100 B, after a 235 B cut (the entry's interrupt check,
 *   which the WebSocket dial makes first; the backoff's own 30 s cap, now the open bound as C#'s; the open's two end
 *   paths folded into one): realtime, shipped only
 *   with an SDK that has a realtime operation, beside the WebSocket files its WebSocket adapter dials through (C#'s
 *   REALTIME set, 24,912 B; Java's 3,924 B more is the open bound's timer, C#'s CancelAfter, the options' builder, C#'s
 *   init properties, the for-each's iterator, C#'s compiler-built async one, a close that cancels a pending open, C#'s
 *   linked token, and a file per public type), nothing dead
 *   to cut (every member is reached by an emitted realtime method or a caller's chain):
 *   - the loop, 8,542 B: RealtimeLoop, the chain tried in order, the reconnect from the cursor with its jittered backoff
 *     capped at the open bound, the give-up thrown once, the read an interrupt leaves reconnecting, close() from any
 *     thread, and the open's end by its bound or by a close (close cancels a pending open, +531 B), each interrupting
 *     only an open still running, the opener clearing only what they set (R4);
 *   - the connection, 5,227 B: ResumableConnection, the public surface, the for-each over receive, the message parsed
 *     as JSON or kept as a JSON string, the cursor advanced before it decodes;
 *   - the dial, 5,223 B: Realtime, the call's entry and its dials: the upgrade through WsDial, the event stream and the
 *     poll through the exchange with the cursor on each, a send POSTed, the call's raw holding the last open;
 *   - the options and the contract, 5,857 B: TransportOptions 4,157, the cursor, its advance past a message and the
 *     reconnect policy with its builder; TransportAdapter 444, TransportConnection 415, TransportMessage 271,
 *     TransportKind 251 and ConnectionState 319;
 *   - the adapters, 3,987 B: WsAdapter 1,093, SseAdapter 1,315 and LongPollAdapter 1,579, a 204 polling again.
 * - phase f, the lock: −34 B, the keepalive's ping marking its interval before the send rather than in the send's
 *   completion, which erased a pong that came in first (the f battery's red); its other fixes are the emitter's (derived
 *   operation ids, the answer statement's wrap, the publication), so the ceiling is the measured 149,981 B, provisional
 *   150,100 → locked 149,981.
 * - bit 19 d1, +219 B to 150,200 B: one ping waits at a time, a deferred one included (a tick racing a send's release
 *   deferred a second ping behind the first one's, sent while it still waited; found red in d1's gates): Socket.java +84
 *   (ping() returns while one waits), Keepalive.java +135 (waiting()).
 * - bit 19 e, +2,951 B to 153,151 B: a realtime refusal is terminal only when every transport refused, a lazy
 *   long-poll's first read included (+528), the most specific refusal its error (+531: rank()), a 401's one refresh per
 *   open restarting the chain (+1,405: Dialed, Realtime's refresh() and used token, Flight's refreshes flag), +487 of
 *   comments (RealtimeLoop.java +2,141, Realtime.java +290, Exchange.java +176, Flight.java +98, each adapter +82).
 * A change raises it only by the bytes of a named feature, dead code cut first.
 * Bit 19 k1, +313 B of doc only, to 153,464 B: TypedWebSocket.java +125 (the dial runs no onRequest or onResponse
 * hook and no onAuthExpired refresh), RequestOptions.java +188 (the JDK's restricted headers throw ConfigException).
 */
const JAVA_RUNTIME_BYTES = 153464

describe("the Java runtime within its byte budget (bit 16, the G14 analog)", () => {
	it(`ships every runtime file it holds, all of them within ${JAVA_RUNTIME_BYTES} bytes, nothing else beside them`, () => {
		const { bytes, names, others } = runtimeBytes(resolve(import.meta.dirname, "../src/runtime/java"), ".java")
		expect({ names, others, over: Math.max(0, bytes - JAVA_RUNTIME_BYTES) }).toEqual({
			names: Object.keys(runtimeFiles("x"))
				.map((name) => `${name}.java`)
				.sort(),
			others: [],
			over: 0,
		})
	})
})

const REPO = resolve(import.meta.dirname, "../../..")
const APPS = ["compose", "defaults", "gateway", "kitchen", "surface"]
/** An e2e app's emitted OpenAPI document. */
const appSpec = (app: string) =>
	JSON.parse(
		readFileSync(join(REPO, `packages/core/tests/e2e/apps/${app}/src/_gen/openapi.gen.json`), "utf8"),
	) as Record<string, unknown>

/*
 * G13 (bit 16, phase f): Java's own per-operation ceiling, as C#'s bit 15 set its 68. Measured over the five e2e apps'
 * 72 operations in both throwOnError modes (144 surfaces, `v1JavaSdkSurfaces` over the emitted files; the ids the
 * IR derives, item 0): max 60 (surface, putInAllByResourceId, safe mode: C#'s max too), median 30, min 21. A Java
 * surface is the widest overload's signature and its <Op>Params record's header, both joined from google-java-format's
 * wrap, since Java's arguments live in that record. 60 + 20% headroom = 72. An operation over it is fixed in the
 * schema, never by raising the ceiling.
 */
const JAVA_SDK_CEILING = ceilingOf([60], 0.2)

/** One operation's emitted files: a resource whose signature GJF wrapped, and its Params record. */
const WRAPPED = {
	"src/main/java/a/ItemsResource.java": `public final class ItemsResource {
  public Map<String, JsonNode> getVeryLongName(
      ItemsGetVeryLongNameParams params, RequestOptions options) {
    return null;
  }

  public Map<String, JsonNode> getVeryLongName(ItemsGetVeryLongNameParams params) {
    return null;
  }
}
`,
	"src/main/java/a/ItemsGetVeryLongNameParams.java": `public record ItemsGetVeryLongNameParams(
    @JsonProperty("id") String id, @JsonInclude(JsonInclude.Include.NON_NULL) Long limit) {
}
`,
}
const PLAN = { "items.getVeryLongName": { method: "getVeryLongName", params: "ItemsGetVeryLongNameParams" } }

describe("the v1 Java SDK within the budget (bit 16, G13)", () => {
	/* new: phase f item 1 */
	it("reads an operation's widest overload joined from GJF's wrap, and its Params header without annotations", () => {
		expect(Object.fromEntries(v1JavaSdkSurfaces(WRAPPED, PLAN))).toEqual({
			"items.getVeryLongName":
				"public Map<String, JsonNode> getVeryLongName(ItemsGetVeryLongNameParams params, RequestOptions options) { public record ItemsGetVeryLongNameParams(String id, Long limit) {",
		})
	})

	/* new: phase f item 1 (C#'s completeness: a surface the reader misses can never pass by going unmeasured) */
	it("refuses an operation whose Params record it cannot find", () => {
		const missing = { "src/main/java/a/ItemsResource.java": WRAPPED["src/main/java/a/ItemsResource.java"] }
		expect(() => v1JavaSdkSurfaces(missing, PLAN)).toThrow(
			"items.getVeryLongName: no getVeryLongName or ItemsGetVeryLongNameParams to measure",
		)
	})

	/* new: phase f item 1 */
	it(`keeps every e2e app's Java operations within ${JAVA_SDK_CEILING} tokens, in both throwOnError modes`, () => {
		const over: string[] = []
		for (const app of APPS) {
			const spec = appSpec(app)
			for (const throwOnError of [true, false]) {
				const plans = javaCallPlans(spec, { throwOnError })
				const surfaces = v1JavaSdkSurfaces(generateJavaSdk(spec, { throwOnError }).files, plans)
				if (surfaces.size !== Object.keys(plans).length)
					over.push(`${app}: ${surfaces.size} of ${Object.keys(plans).length} measured`)
				for (const [key, text] of surfaces) {
					const tokens = countTokens(text)
					if (tokens > JAVA_SDK_CEILING) over.push(`${app}/${key}${throwOnError ? "" : " (safe)"}: ${tokens}`)
				}
			}
		}
		expect(over).toEqual([])
	})
})
