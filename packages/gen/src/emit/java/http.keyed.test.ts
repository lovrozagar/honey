/**
 * The Java SDK's header rules (bit 19 d1, sweep item 11), pinned as Python's and C#'s are (contract 29 §1): a declared
 * `Idempotency-Key` parameter's value is the one sent, over the generated key (an unset one sends a fresh UUIDv4), and
 * an empty map as a header parameter's value sends no header (a non-empty one its JSON text). Through a consumer
 * program run while the recording server answers, since a driven call's headers are strings.
 */
import { describe, expect, it } from "vitest"
import { served } from "../shared/__fixtures__/recording-server.ts"
import { drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

const JAVA = withJava()
const SLOW = { timeout: 600_000 }
const OK = { json: { ok: true }, status: 200 }
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Three sends: an empty map and no key, a non-empty map and a declared key, nothing set. */
const program = (base: string) => `package ai.anyrow;

import java.util.Map;

public class Keyed {
  public static void main(String[] args) {
    AnyrowClient client = AnyrowClient.builder().baseUrl("${base}").build();
    client.keyed().send(KeyedSendParams.builder().xMeta(Map.of()).build());
    client.keyed().send(KeyedSendParams.builder().xMeta(Map.of("a", "1")).idempotencyKey("declared-k").build());
    client.keyed().send(KeyedSendParams.builder().build());
    System.out.println("sent");
  }
}
`

describe.skipIf(!JAVA)(
	"the Java SDK's header rules: an empty map sends nothing, a declared key wins (bit 19 d1)",
	SLOW,
	() => {
		it("sends no x-meta for {}, a non-empty map's JSON text, the declared key over a fresh UUIDv4", async () => {
			const sdk = drivenJavaSdk("http")
			expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
			const { hops, ran } = await served([OK, OK, OK], async (server) => {
				const out = await sdk.exec("ai.anyrow.Keyed", program(server.url))
				return { hops: [...server.hops], ran: out }
			})
			expect(
				{
					keys: hops.map((h) => h.headers["idempotency-key"]),
					meta: hops.map((h) => h.headers["x-meta"]),
					stdout: ran.stdout.trim(),
				},
				`${ran.diagnostics.join("\n")}${ran.stderr}`,
			).toEqual({
				keys: [expect.stringMatching(V4), "declared-k", expect.stringMatching(V4)],
				meta: [undefined, '{"a":"1"}', undefined],
				stdout: "sent",
			})
		})
	},
)
