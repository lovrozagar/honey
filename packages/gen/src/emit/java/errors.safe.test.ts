/**
 * The Java SDK's safe mirror (bit 16 C4; bit 21 i6): on `client.safe()` an answer is a `Result.Err` holding the
 * `SdkException` the normal call throws for it (an error status, declared or not, as its `ApiException`; an
 * undecodable 2xx or one past the cap as a `DecodeException`) beside its `RawResponse`, and only a failure without
 * an answer still throws (a timeout, the caller's interrupt, a refused connection, a throwing hook: f2). Driven through
 * the `http` and `lenient` drivers in the safe style, the driver reading each `Result` strictly (Observe.settle); a
 * consumer program reads every member of `Result` as a caller does, and the removed safe mode's pattern fails to
 * compile (R-i4).
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { JavaError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { REFUSED_URL, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether the pinned JDK is here: a missing pin fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate compiles the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

const MEMBERS: Call = {
	operation: "members.get",
	params: { org: "o", "user-id": "u" },
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
}
const USER: Call = { operation: "users.get", params: { id: "1" }, route: { method: "GET", path: "/users/{id}" } }

/** The registry SDK `key` with the driver aimed at it (it must compile). */
function driven(key: "http" | "lenient"): DrivenJavaSdk {
	const sdk = drivenJavaSdk(key)
	expect(sdk.javac.diagnostics, sdk.javac.diagnostics.join("\n")).toEqual([])
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup; readonly safe?: boolean }

/** `calls` on `sdk` (its `client.safe()` unless `safe` is false) under `options`, against a server answering `replies`. */
function drive(sdk: DrivenJavaSdk, replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	return served(replies, async (server) => {
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(
			cell,
			{ url: server.url },
			{ safe: options.safe ?? true, script: options.script ?? {} },
		)
		return { hops: server.hops.length, run }
	})
}

/** `calls` on `client.safe()` against an origin that refuses every connection. */
const refused = (sdk: DrivenJavaSdk, calls: readonly Call[]) =>
	sdk.runCalls({ calls, setup: {} }, { url: REFUSED_URL }, { safe: true, script: {} })

type Traced = Trace<JavaError>["calls"][number]
/** An error status as the driver observes it, for a `{"message": "m"}` body. */
const failed = (status: number) => ({ body: { message: "m" }, errorKey: null, kind: "error", status })
const answer = (status: number): Reply => ({ json: { message: "m" }, status })
/** A safe call's Err: no data, its response its answer's. */
const missed = (status: number) => ({ data: false, ok: false, response: true, status })
/** A 2xx whose JSON body is cut short. */
const TORN: Reply = { headers: { "content-type": "application/json" }, status: 200, text: '{"id":' }

/**
 * Where a call's failure landed: its route ("result" for a Result Err), class (`canceled` for the caller's interrupt),
 * whether it is the `SdkException` base, its status, and its result's summary.
 */
const landed = (call: Traced | undefined) => {
	const error = call?.error
	const answered = error === undefined ? undefined : error.chain.includes("SdkException")
	return [error?.via, error?.canceled ? "canceled" : error?.type, answered, error?.status, call?.result]
}

describe.skipIf(!JAVA)("client.safe(): an answer a Result.Err with its response, only no answer thrown", SLOW, () => {
	it("answers a 404 and an undeclared 418 (the SdkException base) as Err, a refused connection thrown", async () => {
		const sdk = driven("http")
		const { run } = await drive(sdk, [answer(404), answer(418)], [MEMBERS, MEMBERS])
		const lost = await refused(sdk, [MEMBERS])
		const [found, teapot, gone] = [...(run.trace?.calls ?? []), ...(lost.trace?.calls ?? [])].map(landed)
		expect({ found, gone, observed: [run.observed, lost.observed], teapot }, run.stderr + lost.stderr).toEqual({
			found: ["result", "NotFoundException", true, 404, missed(404)],
			gone: ["return", "ApiConnectionException", false, undefined, undefined],
			observed: [[failed(404), failed(418)], [{ kind: "transport" }]],
			teapot: ["result", "UnexpectedStatusException", true, 418, missed(418)],
		})
	})
})

describe.skipIf(!JAVA)(
	"client.safe(): an undecodable or over-cap 2xx an Err, a timeout, a cancel and a hook throw thrown",
	SLOW,
	() => {
		/* R-i1 and the i1 carry-in: an undecodable 2xx and one past the cap are answers; a timeout, a cancel and a hook throw are none (f2) */
		it("answers an undecodable or over-cap 2xx as Err(DecodeException), and throws a timeout, a cancel and a hook throw", async () => {
			const sdk = driven("http")
			const late: Reply = { delayMs: 2000, json: { id: "u", name: "n" }, status: 200 }
			const calls = [USER, { ...MEMBERS, timeoutMs: 300 }, MEMBERS]
			const script: Script = { calls: [null, null, { cancel: "before" }] }
			const { hops, run } = await drive(sdk, [TORN, late], calls, { script })
			const big: Reply = { json: { id: "u", name: "a name past the cap" }, status: 200 }
			const capped = await drive(sdk, [big], [USER], { setup: { maxResponseBytes: 16 } })
			const hooked = await drive(sdk, [], [MEMBERS], { script: { hooks: { request: [{ fail: "boom" }] } } })
			const traces = [run, capped.run, hooked.run].flatMap((r) => r.trace?.calls ?? [])
			expect(
				{
					hops: [hops, capped.hops, hooked.hops],
					landed: traces.map(landed),
					observed: [run.observed, capped.run.observed, hooked.run.observed],
				},
				run.stderr + capped.run.stderr + hooked.run.stderr,
			).toEqual({
				hops: [2, 1, 0],
				landed: [
					["result", "DecodeException", true, undefined, missed(200)],
					["return", "ApiTimeoutException", false, undefined, undefined],
					["return", "canceled", false, undefined, undefined],
					["result", "DecodeException", true, undefined, missed(200)],
					["return", "HookException", false, undefined, undefined],
				],
				observed: [
					[{ kind: "decode", status: 200 }, { kind: "timeout" }, null],
					[{ kind: "decode", status: 200 }],
					[null],
				],
			})
		})
	},
)

describe.skipIf(!JAVA)("the cap's DecodeException in both styles, and the server's key in an Err", SLOW, () => {
	/* the cap's DecodeException in both styles: the normal client throws what client.safe() holds */
	it("throws an over-cap 2xx on the client as its DecodeException, the answer's text", async () => {
		const big: Reply = { json: { id: "u", name: "a name past the cap" }, status: 200 }
		const { run } = await drive(driven("http"), [big], [USER], { safe: false, setup: { maxResponseBytes: 16 } })
		const error = run.trace?.calls[0]?.error
		expect({ error: [error?.via, error?.type, error?.chain, error?.text], observed: run.observed }, run.stderr).toEqual(
			{
				error: [
					"return",
					"DecodeException",
					["DecodeException", "SdkException", "HoneyException"],
					"the answer exceeds 16 bytes",
				],
				observed: [{ kind: "decode", status: 200 }],
			},
		)
	})

	/* ported from csharp/errors.safe.test.ts: http declares no keys, so the declared-member path is errors.test.ts's */
	it("reads the server's key in a safe call's Err, no member for an API that declares none", async () => {
		const missing: Reply = { json: { error_key: "member.missing", message: "gone" }, status: 404 }
		const { run } = await drive(driven("http"), [missing], [MEMBERS])
		const call = run.trace?.calls[0]
		expect({ error: call?.error, result: call?.result }, run.stderr).toEqual({
			error: {
				canceled: false,
				chain: ["NotFoundException", "ApiException", "SdkException", "HoneyException"],
				display: expect.any(String),
				inner: null,
				key: "member.missing",
				keyMember: null,
				message: "gone",
				status: 404,
				text: "HTTP 404: gone",
				type: "NotFoundException",
				via: "result",
			},
			result: missed(404),
		})
	})
})

/* lenient's three operations: answers a fallback (a NullNode, a null) would fit */
const LENIENT: readonly Call[] = [
	{ operation: "any.get", route: { method: "GET", path: "/any" } },
	{ operation: "count.get", route: { method: "GET", path: "/count" } },
	{ operation: "maybe.get", route: { method: "GET", path: "/maybe" } },
]

describe.skipIf(!JAVA)(
	"a decode failure is never Ok, whatever the answer type would accept (the runtime's, not the type's)",
	SLOW,
	() => {
		it.each([
			["the client: DecodeException thrown", false],
			["client.safe(): Err(DecodeException)", true],
		] as const)(
			"answers an undecodable 2xx to a JsonNode, a Long and a nullable record op as its decode error, on %s",
			async (_, safe) => {
				const { run } = await drive(driven("lenient"), [TORN, TORN, TORN], LENIENT, { safe })
				const decoded = safe
					? ["result", "DecodeException", true, undefined, missed(200)]
					: ["return", "DecodeException", true, undefined, undefined]
				expect({ landed: run.trace?.calls.map(landed), observed: run.observed }, run.stderr).toEqual({
					landed: [decoded, decoded, decoded],
					observed: Array.from({ length: 3 }, () => ({ kind: "decode", status: 200 })),
				})
			},
		)
	},
)

describe.skipIf(!JAVA)("client.safe(): each Result its own", SLOW, () => {
	/* the grid runs one JVM per cell: two Ok answers on one client prove each holds its own data and response */
	it("holds each Ok's own data and response across calls on one client", async () => {
		const replies: Reply[] = [
			{ json: { id: "1" }, status: 200 },
			{ json: { id: "2" }, status: 201 },
		]
		const { run } = await drive(driven("http"), replies, [USER, { ...USER, params: { id: "2" } }])
		expect({ observed: run.observed, results: run.trace?.calls.map((c) => c.result) }, run.stderr).toEqual({
			observed: [
				{ data: { id: "1" }, kind: "data", status: 200 },
				{ data: { id: "2" }, kind: "data", status: 201 },
			],
			results: [
				{ data: true, ok: true, response: true, status: 200 },
				{ data: true, ok: true, response: true, status: 201 },
			],
		})
	})
})

/**
 * The `Result` consumer: users.get answered 404, then 201, each `Result<T>` read through every member as a caller
 * does on `--release 17` (no pattern switch: `instanceof` patterns, `fold`, `orElseThrow`), the Err's `orElseThrow`
 * throwing its own error.
 */
const RESULT = (url: string) => `package probe;

import ai.anyrow.*;

public final class Probe {
  public static void main(String[] args) {
    AnyrowClient client = AnyrowClient.builder().baseUrl("${url}").build();
    Result<UsersGetResponse> missing =
        client.safe().users().get(UsersGetParams.builder().id("missing").build());
    if (missing instanceof Result.Err<UsersGetResponse> err) {
      SdkException base = err.error();
      System.out.println(
          missing.isOk() + " " + (base instanceof NotFoundException) + " " + err.response().status());
    }
    String folded = missing.fold(v -> "ok " + v.id(), e -> "err " + e.getMessage());
    System.out.println(folded);
    try {
      System.out.println(missing.orElseThrow().id());
    } catch (NotFoundException e) {
      System.out.println("thrown " + e.getMessage());
    }
    Result<UsersGetResponse> found =
        client.safe().users().get(UsersGetParams.builder().id("u1").build());
    if (found instanceof Result.Ok<UsersGetResponse> ok) {
      System.out.println(found.isOk() + " " + ok.data().id() + " " + ok.response().status());
    }
    String held = found.fold(v -> "ok " + v.id(), e -> "err");
    System.out.println(held + " " + found.orElseThrow().id());
  }
}
`

const RESULT_REPLIES: readonly Reply[] = [
	{ json: { message: "gone" }, status: 404 },
	{ json: { id: "u1" }, status: 201 },
]

describe.skipIf(!JAVA)("Result<T> from a consumer program (http)", SLOW, () => {
	it("holds a 404 as its Err, a 201 as its Ok, and orElseThrow throws the Err's own error", async () => {
		const { run, wire } = await served(RESULT_REPLIES, async (server) => {
			const ran = await driven("http").exec("probe.Probe", RESULT(server.url))
			return { run: ran, wire: server.hops.map((h) => `${h.method} ${h.url}`) }
		})
		expect(
			{ diagnostics: run.diagnostics, out: run.stdout.trim().split("\n"), status: run.status, wire },
			run.stderr,
		).toEqual({
			diagnostics: [],
			out: ["false true 404", "err HTTP 404: gone", "thrown HTTP 404: gone", "true u1 201", "ok u1 u1"],
			status: 0,
			wire: ["GET /users/missing", "GET /users/u1"],
		})
	})
})

/**
 * The removed safe mode's pattern, unchanged (R-i4): a normal call read as a Result, the Result's removed `status()`,
 * and an Err's error read as the `ApiException` it no longer is typed as.
 */
const OLD = `package probe;

import ai.anyrow.*;

public final class Old {
  public static void main(String[] args) {
    AnyrowClient client = AnyrowClient.builder().baseUrl("http://127.0.0.1:9").build();
    UsersGetParams params = UsersGetParams.builder().id("1").build();
    Result<UsersGetResponse> old = client.users().get(params);
    int status = client.safe().users().get(params).status();
    ApiException error = ((Result.Err<UsersGetResponse>) client.safe().users().get(params)).error();
    System.out.println(old + " " + status + " " + error);
  }
}
`

describe.skipIf(!JAVA)("the removed safe mode (R-i4)", SLOW, () => {
	it("refuses its pattern at compile time: a normal call is no Result, and a Result has no status() nor an ApiException", () => {
		const ran = driven("http").run("probe.Old", OLD)
		const errors = ran.diagnostics
			.filter((line) => /: error: /.test(line))
			.map((line) => line.replace(/^.*?: error: /, ""))
		expect(errors).toEqual([
			"incompatible types: UsersGetResponse cannot be converted to Result<UsersGetResponse>",
			"cannot find symbol",
			"incompatible types: SdkException cannot be converted to ApiException",
		])
	})
})
