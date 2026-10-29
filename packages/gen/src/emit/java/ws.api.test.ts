/**
 * A WebSocket operation through the Java SDK's public API (bit 16 phase d2a, K1, K6, K9; C#'s `ws.test.ts` consumer
 * legs): javac holds the method's and the socket's types; try-with-resources closes 1000; a WsClose prints its status
 * and reason; the server's subprotocol choice, null when none; a send on an ended socket names no payload; a server
 * close echoed at once with its code and reason; the client's own close cut at 123 bytes on a code point, a throwing
 * handler ignored; an open socket idles past the timeout; a socket dialed on one thread, read on another and closed
 * from the main thread. The emitted text: a socket method in safe mode is throw mode's. Driven legs: `ws.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { generateJavaSdk } from "./sdk.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK first. */
const SLOW = { timeout: 600_000 }

const ws = (steps: NonNullable<Reply["ws"]>["steps"], protocol?: string): Reply => ({
	status: 101,
	ws: protocol === undefined ? { steps } : { protocol, steps },
})
/** The client's close frame as the server records it. */
const closed = (code: number, reason = "") => ({ code, kind: "close", reason })

/** The `ws` SDK, which must build. */
function driven(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("ws")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** A consumer program on the `ws` client at `url` running `body`, each `note(…)` one line of its output. */
const consumer = (url: string, body: string) => `package probe;

import ai.anyrow.*;
import java.util.List;
import java.util.concurrent.*;

public class Probe {
  static final String BASE = "${url}";

  static void note(Object value) {
    System.out.println(value);
  }

  public static void main(String[] args) throws Exception {
    AnyrowClient c = AnyrowClient.builder().baseUrl(BASE).build();
${body
	.split("\n")
	.map((line) => `    ${line}`)
	.join("\n")}
    System.exit(0);
  }
}
`

/** `body` run as a consumer program against a server answering `replies`: its output lines, its run and the streams. */
async function consume(replies: readonly Reply[], body: string) {
	const sdk = driven()
	return served(replies, async (server) => {
		const ran = await sdk.exec("probe.Probe", consumer(server.url, body))
		return { out: ran.stdout.split("\n").filter((line) => line !== ""), ran, streams: [...server.streams] }
	})
}

const ROOMS = 'RoomsSocketParams.builder().room("r")'

describe.skipIf(!JAVA)("a WebSocket method: its types, through javac", SLOW, () => {
	/* new: C# ws.test.ts:127 (a socket has no event id; the fold claims no reconnectToken2) */
	it("types the method, the reads, the handlers, closedBy and subprotocol; has no lastEventId and no reconnectToken2", () => {
		const lines = [
			`TypedWebSocket w = c.rooms().socket(${ROOMS}.build());`,
			`TypedWebSocket s = c.rooms().socket(${ROOMS}.since(3L).protocols(List.of("v2")).reconnectToken("t").build());`,
			'TypedWebSocket p = c.plain().socket(PlainSocketParams.builder().protocols(List.of("v1")).reconnectToken("t").build());',
			"AutoCloseable d = w;",
			"WsMessage m = w.receive();",
			"WsMessage.Type kind = m.type();",
			"byte[] data = m.data();",
			"String text = m.text();",
			"WsClose by = w.closedBy();",
			"int status = by.status();",
			"String chosen = w.subprotocol();",
			"w.onMessage(message -> note(message.text()));",
			"w.onClosed(close -> note(close.reason()));",
			"w.onError(error -> note(error.getMessage()));",
			'w.send("t");',
			"w.send(new byte[] {1});",
			"w.sendJson(List.of(1));",
			'w.close(4401, "x");',
			"w.close();",
			`c.rooms().socket(${ROOMS}.lastEventId("x").build());`,
			`c.rooms().socket(${ROOMS}.reconnectToken2("x").build());`,
		]
		const run = driven().run("probe.Probe", consumer("http://127.0.0.1:1", lines.join("\n")))
		const missing = [...run.diagnostics.join("\n").matchAll(/symbol: +method (\w+)\(String\)/g)].map((m) => m[1])
		expect(missing).toEqual(["lastEventId", "reconnectToken2"])
		expect(
			run.diagnostics.filter((line) => / error: /.test(line)).map((line) => line.replace(/^.*error: /, "")),
		).toEqual(["cannot find symbol", "cannot find symbol"])
	})
})

describe.skipIf(!JAVA)("a TypedWebSocket through the public API", SLOW, () => {
	/* new: C# ws.test.ts:137 */
	it("is an AutoCloseable whose try-with-resources closes 1000", async () => {
		const body = `try (TypedWebSocket w = c.rooms().socket(${ROOMS}.build())) {
  note(w.getClass().getSimpleName());
}`
		const { out, ran, streams } = await consume([ws([])], body)
		expect({ out, status: ran.status }, ran.stderr).toEqual({ out: ["TypedWebSocket"], status: 0 })
		expect(streams[0]?.received).toEqual([closed(1000)])
	})

	/* new: C# ws.test.ts:168 */
	it("prints a WsClose's status and reason", async () => {
		const { out, ran } = await consume([], 'note(new WsClose(1000, "done"));')
		expect({ out, status: ran.status }, ran.stderr).toEqual({ out: ["WsClose[status=1000, reason=done]"], status: 0 })
	})

	/* new: C# ws.test.ts:255 */
	it("exposes the server's choice as subprotocol(), null when it picked none", async () => {
		const body = `TypedWebSocket w = c.plain().socket(PlainSocketParams.builder().protocols(List.of("v2", "v1")).build());
note(w.subprotocol());
w.close();
TypedWebSocket bare = c.plain().socket(PlainSocketParams.builder().build());
note(bare.subprotocol());
bare.close();`
		const { out, ran } = await consume([ws([], "v1"), ws([])], body)
		expect({ out, status: ran.status }, ran.stderr).toEqual({ out: ["v1", "null"], status: 0 })
	})

	/* new: C# ws.test.ts:295 */
	it("throws a send on an ended socket without the payload in its message or toString()", async () => {
		const body = `TypedWebSocket w = c.rooms().socket(${ROOMS}.build());
note(w.receive());
String secret = "SECRET-" + "x".repeat(64);
try {
  w.send(secret);
  note("sent");
} catch (RuntimeException e) {
  note(e.getClass().getSimpleName() + ": " + e.getMessage());
  note(e.getMessage().contains(secret) + " " + e.toString().contains(secret));
}
w.close();`
		const { out, ran } = await consume([ws([{ close: { code: 1000, reason: "done" } }])], body)
		expect({ out, status: ran.status }, ran.stderr).toEqual({
			out: ["null", "ApiConnectionException: the WebSocket is closed", "false false"],
			status: 0,
		})
	})
})

describe.skipIf(!JAVA)("a TypedWebSocket's closes, through the public API (K6, W9)", SLOW, () => {
	/* new: C# ws.test.ts:333 (W10: the JDK's own echo drops the reason; the SDK echoes it) */
	it("echoes the server's close at once with its code and reason, the client never closing", async () => {
		const body = `TypedWebSocket w = c.plain().socket(PlainSocketParams.builder().build());
note(w.receive());
Thread.sleep(500);`
		const { out, ran, streams } = await consume([ws([{ close: { code: 1001, reason: "bye" } }])], body)
		expect(streams[0]?.received).toEqual([closed(1001, "bye")])
		expect({ out, status: ran.status }, ran.stderr).toEqual({ out: ["null"], status: 0 })
	})

	/* new: C# ws.test.ts:344 (W9 ruling: the cut never splits a code point; "é" would end at byte 124) */
	it("fires Closed with the client's own code and reason, cut at 123 bytes on a code point, a throwing handler ignored", async () => {
		const body = `TypedWebSocket w = c.plain().socket(PlainSocketParams.builder().build());
w.onClosed(by -> {
  throw new IllegalStateException("boom");
});
w.onClosed(by -> note("[" + by.status() + ",\\"" + by.reason() + "\\"]"));
w.close(1001, "a".repeat(122) + "\\u00e9");
w.close();
note(w.receive());`
		const { out, ran, streams } = await consume([ws([])], body)
		expect(streams[0]?.received).toEqual([closed(1001, "a".repeat(122))])
		expect({ out, status: ran.status }, ran.stderr).toEqual({ out: [`[1001,"${"a".repeat(122)}"]`, "null"], status: 0 })
	})

	/* new: C# ws.test.ts:388 (W6: the timeout bounds the handshake alone; the keepalive's 20 s is far past the idle) */
	it("lets an open socket idle past the timeout: no read bound once it opened", async () => {
		const body = `AnyrowClient timed = AnyrowClient.builder().baseUrl(BASE).timeout(java.time.Duration.ofMillis(300)).build();
TypedWebSocket warm = timed.rooms().socket(${ROOMS}.build(), RequestOptions.builder().timeout(java.time.Duration.ZERO).build());
warm.close();
TypedWebSocket w = timed.rooms().socket(${ROOMS}.build());
note(w.receive().text());
w.close();`
		const { out, ran } = await consume([ws([]), ws([{ waitMs: 1000 }, { json: { late: true } }])], body)
		expect({ out, status: ran.status }, ran.stderr).toEqual({ out: ['{"late":true}'], status: 0 })
	})

	/* new: C# ws.test.ts:458 */
	it("closes from the main thread a socket dialed on one thread and read on another", async () => {
		const body = `ExecutorService pool = Executors.newFixedThreadPool(2);
TypedWebSocket w = pool.submit(() -> c.rooms().socket(${ROOMS}.build())).get();
WsMessage m = pool.submit(w::receive).get();
note(m.text());
try {
  w.close();
  note("close ok");
} catch (RuntimeException e) {
  note(e.getClass().getSimpleName());
}
pool.shutdown();`
		const { out, ran, streams } = await consume([ws([{ json: { ok: 1 } }])], body)
		expect({ out, status: ran.status }, ran.stderr).toEqual({ out: ['{"ok":1}', "close ok"], status: 0 })
		expect(streams[0]?.received).toEqual([closed(1000)])
	})
})

/** The `ws` SDK's socket methods in `files`, in order: each from its signature to its closing brace. */
const socketMethods = (...files: readonly string[]) =>
	files.flatMap((file) =>
		[
			...(generateJavaSdk(FIXTURES.ws.document()).files[`src/main/java/ai/anyrow/${file}.java`] ?? "").matchAll(
				/^ {2}public TypedWebSocket[\s\S]*?^ {2}\}$/gm,
			),
		].map((match) => match[0]),
	)

/** A method's signature line. */
const head = (method: string) => method.split("\n")[0]

describe("generateJavaSdk: a socket method's safe twin", () => {
	/* bit 21 i6 (C#'s, Go's, Python's and Rust's): a socket's twin on client.safe() is the very method, no Result */
	it("emits each socket method's twin as the very method: its signature, and the normal method's call", () => {
		const normal = socketMethods("PlainResource", "RoomsResource")
		const twins = socketMethods("SafePlainResource", "SafeRoomsResource")
		expect({ bodies: twins.map((twin) => twin.split("\n").at(-2)), heads: twins.map(head) }).toEqual({
			bodies: [
				"    return _n.socket(params);",
				"    return _n.socket(params, options);",
				"    return _n.socket(params);",
				"    return _n.socket(params, options);",
			],
			heads: normal.map(head),
		})
		expect(normal.length).toBe(4)
	})
})
