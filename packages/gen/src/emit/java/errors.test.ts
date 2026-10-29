/**
 * The Java SDK's errors (bit 16, C4): an error status throws its per-status `ApiException` subclass, its message
 * `HTTP <status>: <detail>` with no reason phrase (R3), the detail stripped of control and format characters and cut
 * at 512 code points; every other failure its own `HoneyException`. Each API's `ErrorKey`, a class of string
 * constants, and its `<Key>Data` for an inline key schema; the envelope in the trace, and `decodeBody(Class)` through
 * one compiled consumer program, since the trace holds no decoded value. Driven through the Java driver on `errors`
 * (`drivenJavaSdk`), observed as `JavaError`. Safe mode is errors.safe.test.ts. Ported from C#'s errors.test.ts.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { JavaError, Script } from "../shared/__fixtures__/protocol.ts"
import { REFUSED_URL, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { generateJavaSdk } from "./sdk.ts"

/** Whether the pinned JDK and Gradle are here: a missing pin fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate compiles the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

/** The `errors` document's keys in code-unit order: the constant's name and the wire spelling (§2.3). */
const KEYS: readonly (readonly [member: string, wire: string])[] = [
	["EmailTaken", "email_taken"],
	["InvalidPassword", "invalid_password"],
	["ItemLocked", "item.locked"],
	["ItemLocked2", "item_locked"],
	["ItemMissing", "item_missing"],
	["ItemNotFound", "item_not_found"],
	["OrderClosed", "order.closed"],
	["OrderLocked", "order.locked"],
	["Other", "other"],
	["ResponseTooLarge", "response.too_large"],
	["UserNotFound", "user_not_found"],
]

/** The path of the generated file named `name`, its class's `.java` file in the SDK's package. */
const fileNamed = (files: Readonly<Record<string, string>>, name: string) =>
	Object.keys(files).find((path) => path.endsWith(`/${name}.java`))

/** Every `public static final String` constant in `text`, as `[member, value]`, in the order it is written. */
const constantsOf = (text: string): [string, string][] =>
	[...text.matchAll(/public static final String (\w+) = "([^"]*)";/g)].map((m) => [m[1] as string, m[2] as string])

describe("ErrorKey: the string constants each API declares (C4, §2.3)", () => {
	// ported: csharp errors.test.ts:ERROR_KEY (the class of constants, in code-unit order of the wire key)
	it("writes ErrorKey over every declared key in code-unit order, a colliding name numbered", () => {
		const files = generateJavaSdk(FIXTURES.errors.document()).files
		const path = fileNamed(files, "ErrorKey")
		expect(path === undefined ? undefined : constantsOf(files[path] ?? "")).toEqual(KEYS)
	})

	// ported: csharp errors.test.ts:67 (ItemLockedData), :76 (no envelope or ref Data)
	it("declares ItemLockedData for item.locked's inline schema, and no Data for an envelope or a ref key", () => {
		const files = generateJavaSdk(FIXTURES.errors.document()).files
		const data = Object.keys(files)
			.filter((path) => path.endsWith("Data.java"))
			.map((path) => path.split("/").at(-1))
		const declared = fileNamed(files, "ItemLockedData")
		expect({
			data,
			declared: declared === undefined ? undefined : /\brecord ItemLockedData\b/.test(files[declared] ?? ""),
		}).toEqual({ data: ["ItemLockedData.java"], declared: true })
	})

	// ported: csharp errors.test.ts:90
	it("writes no ErrorKey for an API without keys (http)", () => {
		const files = generateJavaSdk(FIXTURES.http.document()).files
		expect(Object.keys(files).filter((path) => path.endsWith("/ErrorKey.java"))).toEqual([])
	})
})

/** One op declaring keys whose names collide with each other, in code-unit order. Java has no member a key can hide. */
const NAMES = {
	info: { title: "Names", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/x": {
			get: {
				operationId: "x.get",
				responses: { 204: { description: "done" } },
				"x-honey-errors": Object.fromEntries(
					["NotFound", "equals", "error_key", "not-found", "not_found"].map((key) => [key, { status: 409 }]),
				),
			},
		},
	},
}

describe("ErrorKey's member names (C4)", () => {
	it("names each key by its Java name in a scope of the other keys alone: a repeat numbered", () => {
		const files = generateJavaSdk(NAMES).files
		const path = fileNamed(files, "ErrorKey")
		const members = path === undefined ? [] : constantsOf(files[path] ?? "")
		expect(members).toEqual([
			["NotFound", "NotFound"],
			["Equals", "equals"],
			["ErrorKey", "error_key"],
			["NotFound2", "not-found"],
			["NotFound3", "not_found"],
		])
	})
})

/** The `errors` SDK with the driver aimed at it; the driver must compile against it. */
function on(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("errors")
	expect(sdk.javac.diagnostics, sdk.javac.diagnostics.join("\n")).toEqual([])
	return sdk
}

/** `calls` run under `script` (`{}` by default) against a server answering `replies`: the run and the hop count. */
function drive(replies: readonly Reply[], calls: readonly Call[], script: Script = {}) {
	const sdk = on()
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: {} }, { url: server.url }, { script })
		return { hops: server.hops.length, run }
	})
}

/** `calls` against an origin that refuses every connection: REFUSED_URL, never a server this test closed. */
function refused(calls: readonly Call[]) {
	return on().runCalls({ calls, setup: {} }, { url: REFUSED_URL }, { script: {} })
}

type Run = Awaited<ReturnType<DrivenJavaSdk["runCalls"]>>
const errorsOf = (run: Run) => (run.trace?.calls ?? []).map((call) => call.error)

const ITEM: Call = { operation: "items.get", params: { id: "i1" }, route: { method: "GET", path: "/items/{id}" } }
const item = (id: string): Call => ({ ...ITEM, params: { id } })
const ORDER: Call = { operation: "orders.close", route: { method: "POST", path: "/a" } }
const USER: Call = {
	body: { kind: "json", value: { email: "a@x.test" } },
	operation: "users.create",
	route: { method: "POST", path: "/users" },
}

/** A Java error as the trace records it: no inner, not canceled, the method's own throw unless given. */
const plain = (entry: Partial<JavaError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})
const statusChain = (type: string) => [type, "ApiException", "SdkException", "HoneyException"]
/** An error status with no key whose detail is `message`, as the trace records it. */
const unkeyed = (status: number, type: string, message = "m") =>
	plain({
		chain: statusChain(type),
		key: null,
		keyMember: null,
		message,
		status,
		text: `HTTP ${status}: ${message}`,
		type,
	})
/** An error status as the driver observes it, for a `{"message": "m"}` body. */
const failed = (status: number) => ({ body: { message: "m" }, errorKey: null, kind: "error", status })
const answer = (status: number): Reply => ({ json: { message: "m" }, status })

/** The eleven statuses with a class of their own (Fb14). */
const NAMED: readonly (readonly [number, string])[] = [
	[400, "BadRequestException"],
	[401, "UnauthorizedException"],
	[403, "ForbiddenException"],
	[404, "NotFoundException"],
	[409, "ConflictException"],
	[422, "UnprocessableEntityException"],
	[429, "RateLimitException"],
	[500, "InternalServerException"],
	[502, "BadGatewayException"],
	[503, "ServiceUnavailableException"],
	[504, "GatewayTimeoutException"],
]

describe.skipIf(!JAVA)("an error status throws its ApiException subclass: HTTP <status>: <detail>", SLOW, () => {
	// ported: csharp errors.test.ts:171
	it("throws each of the eleven named statuses as its own subclass", async () => {
		const { hops, run } = await drive(
			NAMED.map(([status]) => answer(status)),
			NAMED.map(() => ITEM),
		)
		expect({ errors: errorsOf(run), hops, observed: run.observed }, run.stderr).toEqual({
			errors: NAMED.map(([status, type]) => unkeyed(status, type)),
			hops: NAMED.length,
			observed: NAMED.map(([status]) => failed(status)),
		})
	})

	// ported: csharp errors.test.ts:186
	it("throws a status no subclass names as UnexpectedStatusException: 418 and 410", async () => {
		const { run } = await drive([answer(418), answer(410)], [ITEM, ITEM])
		expect({ errors: errorsOf(run), observed: run.observed }, run.stderr).toEqual({
			errors: [unkeyed(418, "UnexpectedStatusException"), unkeyed(410, "UnexpectedStatusException")],
			observed: [failed(418), failed(410)],
		})
	})
})

/** The hostile body's prefix: ESC and BEL (Cc), U+FFFD, and a zero-width space (Cf); the rest is `x`. */
const PREFIX = "\x1b]0;pwned\x07�​"
/** The detail that prefix leaves: its printable characters, then 504 more to make 512 code points, and `…`. */
const CUT = `]0;pwned${"x".repeat(504)}…`

describe.skipIf(!JAVA)("a hostile error body in the detail and the message", SLOW, () => {
	// ported: csharp errors.test.ts:197
	it("drops control, format and U+FFFD characters, then cuts the detail at 512 code points plus …; the raw body kept", async () => {
		const hostile = `${PREFIX}${"x".repeat(20_000 - PREFIX.length)}`
		const { run } = await drive([{ status: 500, text: hostile }], [ITEM])
		const error = run.trace?.calls[0]?.error
		expect({ message: error?.message, observed: run.observed, text: error?.text }, run.stderr).toEqual({
			message: CUT,
			observed: [{ body: hostile, errorKey: null, kind: "error", status: 500 }],
			text: `HTTP 500: ${CUT}`,
		})
	})

	it("counts the 512 cut in code points, so an astral character is one, not two", async () => {
		const { run } = await drive([{ status: 500, text: "😀".repeat(600) }], [ITEM])
		const message = `${"😀".repeat(512)}…`
		expect({ message: run.trace?.calls[0]?.error?.message }, run.stderr).toEqual({ message })
	})

	// ported: csharp errors.test.ts:214
	it("reads a problem+json 422 into the envelope, its detail and message free of ESC", async () => {
		const problem: Reply = {
			headers: { "content-type": "application/problem+json" },
			json: { message: "bad\x1b[31m", type: "about:blank" },
			status: 422,
		}
		const { run } = await drive([problem], [ITEM], { calls: [{ envelope: true }] })
		const error = run.trace?.calls[0]?.error
		const envelope = error?.envelope as Readonly<Record<string, unknown>> | undefined
		const read = { extraKeys: envelope?.extraKeys, message: error?.message, text: error?.text }
		expect({ chain: error?.chain, read, status: error?.status }, run.stderr).toEqual({
			chain: statusChain("UnprocessableEntityException"),
			read: { extraKeys: ["type"], message: "bad[31m", text: "HTTP 422: bad[31m" },
			status: 422,
		})
	})
})

describe.skipIf(!JAVA)(
	"each way a call fails, one HoneyException class each: a status only with an answer",
	SLOW,
	() => {
		// ported: csharp errors.test.ts:238
		it("ends an error status as its subclass, an undecodable 2xx as DecodeException, a bad path param as PathParamException, a refused connection as ApiConnectionException", async () => {
			const gone: Reply = { json: { message: "gone" }, status: 404 }
			const torn: Reply = { headers: { "content-type": "application/json" }, status: 200, text: '{"id":' }
			const dots: Call = { ...ITEM, params: { id: ".." } }
			const { hops, run } = await drive([gone, torn], [ITEM, ITEM, dots])
			const lost = await refused([ITEM])
			const [api, decode, path] = errorsOf(run)
			const shapes = [api, decode, path, lost.trace?.calls[0]?.error].map((e) => [e?.chain, e?.status, e?.inner])
			const observed = [run.observed, lost.observed]
			expect({ hops, observed, path: path?.text, shapes }, run.stderr + lost.stderr).toEqual({
				hops: 2,
				/* bit 21 i0: the undecodable 2xx and the refused connection are grid outcomes; a bad path param is none */
				observed: [
					[
						{ body: { message: "gone" }, errorKey: null, kind: "error", status: 404 },
						{ kind: "decode", status: 200 },
						null,
					],
					[{ kind: "transport" }],
				],
				path: 'path param id: ".." is not a path segment',
				shapes: [
					[statusChain("NotFoundException"), 404, null],
					[["DecodeException", "SdkException", "HoneyException"], undefined, "UnexpectedEndOfInputException"],
					[["PathParamException", "HoneyException"], undefined, null],
					[["ApiConnectionException", "HoneyException"], undefined, "ConnectException"],
				],
			})
		})

		// ported: csharp errors.test.ts:266; an unbounded call first, as the cold first request can outlast 300 ms
		it("ends a lapsed per-call timeout as ApiTimeoutException and a cancel before the call with canceled set, neither with a status", async () => {
			const found: Reply = { json: { id: "i1", name: "n" }, status: 200 }
			const calls = [{ ...ITEM, timeoutMs: 0 }, { ...ITEM, timeoutMs: 300 }, ITEM]
			const script: Script = { calls: [null, null, { cancel: "before" }] }
			const { hops, run } = await drive([found, { ...found, delayMs: 2000 }], calls, script)
			const [, timeout, canceled] = errorsOf(run)
			expect(
				{ canceled: canceled?.canceled, hops, observed: run.observed, statuses: [timeout?.status, canceled?.status] },
				run.stderr,
			).toEqual({
				canceled: true,
				hops: 2,
				observed: [{ data: { id: "i1", name: "n" }, kind: "data", status: 200 }, { kind: "timeout" }, null],
				statuses: [undefined, undefined],
			})
			expect(timeout).toEqual(
				plain({
					chain: ["ApiTimeoutException", "HoneyException"],
					inner: expect.stringMatching(/^(TimeoutException|CompletionException|CancellationException)$/),
					text: "GET /items/{id} timed out after 300 ms",
					type: "ApiTimeoutException",
				}),
			)
		})
	},
)

/** The item's `until` in each body the program decodes, read through `decodeBody(Class)` by a compiled consumer. */
const PROBE = (url: string) => `package probe;

import ai.anyrow.*;

public final class Probe {
  public static void main(String[] args) {
    AnyrowClient client = AnyrowClient.builder().baseUrl("${url}").build();
    try {
      client.items().get(ItemsGetParams.builder().id("i3").build());
    } catch (ApiException e) {
      System.out.println(e.decodeBody(ItemLockedData.class));
    }
    try {
      client.orders().close(OrdersCloseParams.builder().build());
    } catch (ApiException e) {
      System.out.println(e.decodeBody(Lock.class));
    }
  }
}
`

/** The keyed calls, in order, each asking for its envelope; their replies answer from `errors` (§2.3's keys). */
const KEY_CALLS: readonly Call[] = [item("i3"), ORDER, USER, USER, item("i4"), item("i5"), item("i6")]
const TAKEN = {
	error_key: "email_taken",
	fields: { email: [{ error_key: "taken", message: "is taken", path: "email" }] },
	message: "taken",
	status: 400,
	status_key: "bad_request",
	success: false,
}
const KEY_REPLIES: readonly Reply[] = [
	{ json: { error_key: "item.locked", until: "2026-10-17" }, status: 423 },
	{ json: { error_key: "order.locked", until: "noon" }, status: 423 },
	{ json: TAKEN, status: 400 },
	{ json: { ...TAKEN, error_key: "user_not_found", fields: {}, message: "no user", status: 404 }, status: 404 },
	{ json: { error_key: "item_missing", message: "gone", status: 404, success: false }, status: 404 },
	{ json: { error_key: "nope", message: "m" }, status: 409 },
	{ status: 422, text: "oops" },
]

describe.skipIf(!JAVA)("ApiException, ErrorKey and the envelope from the driver (errors)", SLOW, () => {
	// ported: csharp errors.test.ts:381 (the key, its constant, the status and the observed error key)
	it("reads Key against the constants, else the server's string, and keyMember names the constant", async () => {
		const script: Script = { calls: KEY_CALLS.map(() => ({ envelope: true })) }
		const { run } = await drive(KEY_REPLIES, KEY_CALLS, script)
		const errors = errorsOf(run).map((e) => [e?.key, e?.keyMember, e?.status])
		expect(
			{ errors, observed: run.observed?.map((o) => (o as { errorKey?: string | null }).errorKey) },
			run.stderr,
		).toEqual({
			errors: [
				["item.locked", "ItemLocked", 423],
				["order.locked", "OrderLocked", 423],
				["email_taken", "EmailTaken", 400],
				["user_not_found", "UserNotFound", 404],
				["item_missing", "ItemMissing", 404],
				["nope", null, 409],
				[null, null, 422],
			],
			observed: ["item.locked", "order.locked", "email_taken", "user_not_found", "item_missing", "nope", null],
		})
	})

	// ported: csharp errors.test.ts:381 (the envelope: its set members, and the extra key `success`)
	it("reads the envelope of each full error body: its set members, its fields, and its extra keys", async () => {
		const script: Script = { calls: KEY_CALLS.map(() => ({ envelope: true })) }
		const { run } = await drive(KEY_REPLIES, KEY_CALLS, script)
		const envelopes = errorsOf(run).map((e) => e?.envelope)
		expect(envelopes.slice(2, 5), run.stderr).toEqual([
			{
				error_key: "email_taken",
				extraKeys: ["success"],
				fields: { email: [{ error_key: "taken", message: "is taken", path: "email" }] },
				message: "taken",
				status: 400,
				status_key: "bad_request",
			},
			{
				error_key: "user_not_found",
				extraKeys: ["success"],
				message: "no user",
				status: 404,
				status_key: "bad_request",
			},
			{ error_key: "item_missing", extraKeys: ["success"], message: "gone", status: 404 },
		])
	})

	// ported: csharp errors.test.ts:381 (DecodeBody<T>() through the mapper, one compiled consumer)
})

describe.skipIf(!JAVA)("decodeBody(Class) through one compiled consumer (errors)", SLOW, () => {
	it("decodes an error body through decodeBody(Class) into the record the key declares, the mapper's own reader", async () => {
		const decoded = await served(
			[
				{ json: { error_key: "item.locked", until: "2026-10-17" }, status: 423 },
				{ json: { error_key: "order.locked", until: "noon" }, status: 423 },
			],
			async (server) => on().exec("probe.Probe", PROBE(server.url)),
		)
		expect({ status: decoded.status, stderr: decoded.stderr, stdout: decoded.stdout.trim().split("\n") }).toEqual({
			status: 0,
			stderr: "",
			stdout: ["ItemLockedData[until=2026-10-17]", "Lock[until=noon]"],
		})
	})
})
