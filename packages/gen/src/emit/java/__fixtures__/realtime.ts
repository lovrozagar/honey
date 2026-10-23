/**
 * The realtime legs' shared harness (bit 16 phase d2b): the `realtime` SDK with the driver aimed at it, the replies a
 * realtime chain answers (a refused upgrade, an unavailable event stream, an SSE stream of resumable events), and the
 * consumer program, in the SDK's package so its mapper prints a value: `note` adds a line to the current `section`
 * ("main" first), and `read(rc)` is one receive as "none", "ok <json>" or "err <Type>: <message>" (an interrupt's
 * CancellationException is the caller's to see).
 */
import { expect } from "vitest"
import { type Reply, served } from "../../shared/__fixtures__/recording-server.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./driven.ts"

/** The `realtime` SDK with the driver aimed at it, which must build. */
export function drivenRealtime(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("realtime")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

export const refused: Reply = { json: { message: "no" }, status: 404 }
export const unavailable: Reply = { status: 503, text: "" }
export const bad: Reply = { json: { message: "bad" }, status: 400 }
type Step = string | { waitMs: number }
export const sse = (steps: readonly Step[], end: "close" | "drop" | "hold"): Reply => ({
	sse: { end, steps },
	status: 200,
})
/** event n of a resumable stream: SSE id n, payload n with reconnect token rt-n */
export const ev = (n: number) => `id: ${n}\ndata: {"n":${n},"reconnect_token":"rt-${n}"}\n\n`
export const frame = (n: number) => ({ n, reconnect_token: `rt-${n}` })
export const FEED_URL = "/feed?channel=c"
export const AT_1 = "/feed?channel=c&last_event_id=1&reconnect_token=rt-1"

export const consumer = (url: string, body: string, types = "") => `package ai.anyrow;

import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import tools.jackson.databind.JsonNode;

public class Probe {
  static final String BASE = "${url}";
  static final Map<String, List<String>> OUT = new LinkedHashMap<>();
  static String at = "main";

  static void section(String name) {
    at = name;
  }

  static void note(Object value) {
    OUT.computeIfAbsent(at, k -> new ArrayList<>()).add(String.valueOf(value));
  }

  static AnyrowClient client() {
    return AnyrowClient.builder().baseUrl(BASE).build();
  }

  static String read(ResumableConnection<?> rc) {
    try {
      Object value = rc.receive();
      return value == null ? "none" : "ok " + Json.MAPPER.writeValueAsString(value);
    } catch (CancellationException e) {
      throw e;
    } catch (RuntimeException e) {
      return "err " + e.getClass().getSimpleName() + ": " + e.getMessage();
    }
  }

  public static void main(String[] args) throws Exception {
${body
	.split("\n")
	.map((line) => `    ${line}`)
	.join("\n")}
    System.out.println(Json.MAPPER.writeValueAsString(OUT));
    System.exit(0);
  }
}
${types}`

/** `body` run as a consumer against a server answering `replies`: its sections, the hop URLs and stderr. */
export async function consumed(replies: readonly Reply[], body: string, types = "") {
	const sdk = drivenRealtime()
	return served(replies, async (server) => {
		const ran = await sdk.exec("ai.anyrow.Probe", consumer(server.url, body, types))
		const out = ran.status === 0 ? (JSON.parse(ran.stdout) as Record<string, string[]>) : undefined
		return { hops: server.hops.map((hop) => hop.url), out, stderr: `${ran.diagnostics.join("\n")}${ran.stderr}` }
	})
}
