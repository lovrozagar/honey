/**
 * The Python SDK's errors (contract 29 §5.7, G6/G7, Fc2–Fc4): an error status raises its `APIStatusError` subclass
 * (`HTTP <status>: <message>`, the message sanitized and cut at 512 characters), every other failure its own
 * `HoneyError`; each API's functional `ErrorKey` StrEnum (§3.4) and `<Key>Data`, read through `e.key` and
 * `e.decode_body`; the frozen `ErrorEnvelope`. Driven through the `errors` driver on `AsyncSDK` and `SDK` with one
 * expectation (G17); consumers `caught` and `errors` and one mypy program. Safe mode is errors.safe.test.ts.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { PythonError, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, recordingServer, served } from "../shared/__fixtures__/recording-server.ts"
import { errors } from "../shared/__fixtures__/documents-http.ts"
import { checked, consume, once, seen } from "./__fixtures__/consumer.ts"
import { type DrivenPythonSdk, drivenPythonSdk } from "./__fixtures__/driven.ts"
import { pythonHttp } from "./__fixtures__/documents-http.ts"
import { withPython } from "./__fixtures__/python-env.ts"
import { generatePythonSdk } from "./sdk.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }
const CLIENTS = ["async", "sync"] as const
type Client = (typeof CLIENTS)[number]

/** The `errors` document's keys in code-unit order: the member name and the wire spelling. */
const KEYS: readonly (readonly [member: string, wire: string])[] = [
	["EMAIL_TAKEN", "email_taken"],
	["INVALID_PASSWORD", "invalid_password"],
	["ITEM_LOCKED", "item.locked"],
	["ITEM_LOCKED2", "item_locked"],
	["ITEM_MISSING", "item_missing"],
	["ITEM_NOT_FOUND", "item_not_found"],
	["ORDER_CLOSED", "order.closed"],
	["ORDER_LOCKED", "order.locked"],
	["OTHER", "other"],
	["RESPONSE_TOO_LARGE", "response.too_large"],
	["USER_NOT_FOUND", "user_not_found"],
]

/** §3.4's ErrorKey for KEYS, exactly as `types.py` ends (honey-a8: its own trailing block; `<Key>Data` is not in it). */
const ERROR_KEY = `# The error keys the API declares: APIStatusError.key is one of these, else the server's string.
# item.locked: its body decodes into ItemLockedData (APIStatusError.decode_body).
# order.locked: its body decodes into Lock (APIStatusError.decode_body).
ErrorKey = StrEnum(
    "ErrorKey",
    {
${KEYS.map(([member, wire]) => `        "${member}": "${wire}",\n`).join("")}    },
)
`

/** `types.py`'s classes in order: the components, then the hoisted declarations name-sorted, ItemLockedData among them. */
const CLASSES = ["E404", "Item", "Lock", "User", "E404FieldsValueItem", "ItemLockedData", "UsersCreateBody"]

describe("the ErrorKey StrEnum each API declares (G6/G7, Fc3, §3.4)", () => {
	const files = generatePythonSdk(errors()).files
	const types = files["src/honey_sdk/types.py"] ?? ""

	it("ends types.py with the functional ErrorKey over every declared key, colliding names numbered, after every class", () => {
		/* Fc3: the class form trips ruff's S105 on INVALID_PASSWORD, and emitted code takes no noqa */
		expect(types.endsWith(`\n\n\n${ERROR_KEY}`), types.slice(-1500)).toBe(true)
	})

	it("declares ItemLockedData among the hoisted declarations in code-unit order, not after ErrorKey", () => {
		/* honey-a8 on §2 vs §3.4: one ordering rule for every declaration; a key's body type is a hoisted one */
		const classes = [...types.matchAll(/^class (\w+)\(TypedDict\):$/gm)].map((m) => m[1])
		const data = types.includes(
			"\n\n\nclass ItemLockedData(TypedDict):\n    until: NotRequired[str]\n\n\nclass UsersCreateBody(",
		)
		expect({ classes, data }).toEqual({ classes: CLASSES, data: true })
	})

	it("imports StrEnum before typing, hands ErrorKey to the transport, exports it, and names no envelope or ref Data", () => {
		const client = files["src/honey_sdk/client.py"] ?? ""
		const init = files["src/honey_sdk/__init__.py"] ?? ""
		expect({
			defaults: client.split("\n").find((line) => line.startsWith("_DEFAULTS = ")),
			exported: ["ErrorKey", "ItemLockedData"].map((name) => init.includes(`"${name}",`)),
			imports: types.includes("\nfrom enum import StrEnum\nfrom typing import "),
			unnamed: types.match(/\bOrder(Closed|Locked)Data\b/g),
		}).toEqual({
			defaults: '_DEFAULTS = Defaults(None, "X-API-Key", "", ErrorKey)',
			exported: [true, true],
			imports: true,
			unnamed: null,
		})
	})

	it("emits no ErrorKey, no StrEnum import and no fourth Defaults argument for an API without keys (http)", () => {
		const http = generatePythonSdk(pythonHttp()).files
		const client = http["src/honey_sdk/client.py"] ?? ""
		expect({
			defaults: client.split("\n").find((line) => line.startsWith("_DEFAULTS = ")),
			keyed: [http["src/honey_sdk/types.py"] ?? "", client, http["src/honey_sdk/__init__.py"] ?? ""].map((text) =>
				/\bErrorKey\b|\bStrEnum\b/.test(text),
			),
		}).toEqual({ defaults: '_DEFAULTS = Defaults(None, "Authorization", "Bearer ")', keyed: [false, false, false] })
	})
})

const ITEM: Call = { operation: "items.get", params: { id: "i1" }, route: { method: "GET", path: "/items/{id}" } }

/** The SDK to drive and the client to drive it on. */
type On = { readonly client: Client; readonly sdk: DrivenPythonSdk }

/** The `errors` SDK with the driver aimed at it (it must import), on `client`. */
function on(client: Client): On {
	const sdk = drivenPythonSdk("errors")
	expect(sdk.imported, sdk.stderr).toBe(true)
	return { client, sdk }
}

/** `calls` run on `at` under `script` (`{}` by default) against a server answering `replies`: the run and the hops. */
function drive(at: On, replies: readonly Reply[], calls: readonly Call[], script: Script = {}) {
	return served(replies, async (server) => {
		const run = await at.sdk.runCalls({ calls, setup: {} }, { url: server.url }, { client: at.client, script })
		return { hops: [...server.hops], run }
	})
}

/** `calls` on `at` against an origin that refuses every connection. */
async function refused(at: On, calls: readonly Call[]) {
	const closed = await recordingServer([])
	await closed.close()
	return at.sdk.runCalls({ calls, setup: {} }, { url: closed.url }, { client: at.client, script: {} })
}

type Run = Awaited<ReturnType<On["sdk"]["runCalls"]>>
const errorsOf = (run: Run) => (run.trace?.calls ?? []).map((call) => call.error)
/** A Python error as the trace records it: no cause and the method's own raise unless given, any repr. */
const plain = (entry: Partial<PythonError>) => ({ cause: null, repr: expect.any(String), via: "return", ...entry })
/** The chain of an `APIStatusError` subclass `type` (or of `APIStatusError` itself). */
const statusChain = (type: string) =>
	type === "APIStatusError" ? ["APIStatusError", "HoneyError"] : [type, "APIStatusError", "HoneyError"]
/** An error status with no key whose message is `message`, as the trace records it. */
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

/** The eleven statuses with a class of their own (G6: v0's names, which Go and Rust share). */
const NAMED: readonly (readonly [number, string])[] = [
	[400, "BadRequestError"],
	[401, "UnauthorizedError"],
	[403, "ForbiddenError"],
	[404, "NotFoundError"],
	[409, "ConflictError"],
	[422, "UnprocessableEntityError"],
	[429, "RateLimitError"],
	[500, "InternalServerError"],
	[502, "BadGatewayError"],
	[503, "ServiceUnavailableError"],
	[504, "GatewayTimeoutError"],
]

describe.skipIf(!PY)(
	"an error status raises its APIStatusError subclass, its text HTTP <status>: <message>",
	SLOW,
	() => {
		// v0: a4c9ff918e
		it.each(CLIENTS)("%s: raises each of the eleven named statuses as its own subclass", async (client) => {
			/* test text: v0 grepped _errors.py for the class names; the port pins the status → class map and the text (Fc2) */
			const { hops, run } = await drive(
				on(client),
				NAMED.map(([status]) => answer(status)),
				NAMED.map(() => ITEM),
			)
			expect({ errors: errorsOf(run), hops: hops.length, observed: run.observed }, run.stderr).toEqual({
				errors: NAMED.map(([status, type]) => unkeyed(status, type)),
				hops: NAMED.length,
				observed: NAMED.map(([status]) => failed(status)),
			})
		})

		// v0: a4c9ff918e
		it.each(CLIENTS)("%s: raises a status no subclass names as APIStatusError itself: 418 and 410", async (client) => {
			const { run } = await drive(on(client), [answer(418), answer(410)], [ITEM, ITEM])
			expect({ errors: errorsOf(run), observed: run.observed }, run.stderr).toEqual({
				errors: [unkeyed(418, "APIStatusError"), unkeyed(410, "APIStatusError")],
				observed: [failed(418), failed(410)],
			})
		})
	},
)

describe.skipIf(!PY)("a hostile error body in the error's message and text", SLOW, () => {
	it.each(CLIENTS)(
		"%s: drops control characters and cuts the message at 512 characters, the raw body kept",
		async (client) => {
			/* Fc2: v0's sanitized message restored (H4); Unicode category C and U+FFFD dropped, then the 512-character cut */
			const hostile = `\x1b]0;pwned\x07${"x".repeat(20_000 - 10)}`
			const message = `]0;pwned${"x".repeat(504)}…`
			const { run } = await drive(on(client), [{ status: 500, text: hostile }], [ITEM])
			const error = run.trace?.calls[0]?.error
			expect({ message: error?.message, observed: run.observed, text: error?.text }, run.stderr).toEqual({
				message,
				observed: [{ body: hostile, errorKey: null, kind: "error", status: 500 }],
				text: `HTTP 500: ${message}`,
			})
		},
	)

	// v0: 31aba57f46
	it.each(CLIENTS)(
		"%s: reads a problem+json 422 into the envelope, its message and text free of ESC",
		async (client) => {
			/* v0's e.data is the envelope (plan 15:76): an unknown member lands in its extra */
			const problem: Reply = {
				headers: { "content-type": "application/problem+json" },
				json: { message: "bad\x1b[31m", type: "about:blank" },
				status: 422,
			}
			const { run } = await drive(on(client), [problem], [ITEM], { calls: [{ envelope: true }] })
			const error = run.trace?.calls[0]?.error
			/* the trace's envelope is Json: an object here, its extraKeys the sorted extra */
			const envelope = error?.envelope as Readonly<Record<string, unknown>> | undefined
			const read = { extraKeys: envelope?.extraKeys, message: error?.message, text: error?.text }
			expect({ chain: error?.chain, read, status: error?.status }, run.stderr).toEqual({
				chain: statusChain("UnprocessableEntityError"),
				read: { extraKeys: ["type"], message: "bad[31m", text: "HTTP 422: bad[31m" },
				status: 422,
			})
		},
	)
})

describe.skipIf(!PY)("each way a call fails, one HoneyError class each: a status only with an answer", SLOW, () => {
	it.each(CLIENTS)(
		"%s: ends an error status as its subclass, an undecodable 2xx as DecodeError, a bad path param as PathParamError, a refused connection as APIConnectionError",
		async (client) => {
			const at = on(client)
			const gone: Reply = { json: { message: "gone" }, status: 404 }
			const torn: Reply = { headers: { "content-type": "application/json" }, status: 200, text: '{"id":' }
			const dots: Call = { ...ITEM, params: { id: ".." } }
			const { hops, run } = await drive(at, [gone, torn], [ITEM, ITEM, dots])
			const lost = await refused(at, [ITEM])
			const [api, decode, path] = errorsOf(run)
			const transport = lost.trace?.calls[0]?.error
			const shapes = [api, decode, path, transport].map((e) => [e?.chain, e?.status, e?.cause])
			const texts = [decode?.text, path?.text, transport?.text.startsWith("the request failed: ConnectError")]
			const observed = [run.observed, lost.observed]
			expect({ hops: hops.length, observed, shapes, texts }, run.stderr + lost.stderr).toEqual({
				hops: 2,
				observed: [[{ body: { message: "gone" }, errorKey: null, kind: "error", status: 404 }, null, null], [null]],
				shapes: [
					[statusChain("NotFoundError"), 404, null],
					[["DecodeError", "HoneyError"], undefined, null],
					[["PathParamError", "HoneyError"], undefined, null],
					[["APIConnectionError", "HoneyError"], undefined, "ConnectError"],
				],
				texts: ["HTTP 200: the body is not JSON", "path parameter 'id' is missing, empty, '.' or '..'", true],
			})
		},
	)

	it.each(CLIENTS)(
		"%s: ends a lapsed per-call timeout as APITimeoutError and a cancel before the call as CanceledError, neither with a status",
		async (client) => {
			const late: Reply = { delayMs: 1000, json: { id: "i1", name: "n" }, status: 200 }
			const script: Script = { calls: [null, { cancel: "before" }] }
			const { hops, run } = await drive(on(client), [late], [{ ...ITEM, timeoutMs: 50 }, ITEM], script)
			expect({ errors: errorsOf(run), hops: hops.length, observed: run.observed }, run.stderr).toEqual({
				errors: [
					plain({
						cause: "ReadTimeout",
						chain: ["APITimeoutError", "APIConnectionError", "HoneyError"],
						text: "the call ran past its timeout",
						type: "APITimeoutError",
					}),
					plain({ chain: ["CanceledError", "HoneyError"], text: "the call was canceled", type: "CanceledError" }),
				],
				hops: 1,
				observed: [{ kind: "timeout" }, null],
			})
		},
	)
})

/** The `caught` consumer: `except` on a subclass and on the base, one client each. */
const CAUGHT = `section("caught")
c = client()
try:
    c.items.get("i1")
except sdk.NotFoundError as e:
    note(f"{type(e).__name__} {e.status} {isinstance(e, sdk.APIStatusError)} {e}")
c.close()
a = aclient()
try:
    await a.items.get("i2")
except sdk.NotFoundError:
    note("a 418 caught as NotFoundError")
except sdk.APIStatusError as e:
    note(f"{type(e).__name__} {e.status} {e}")
await a.aclose()`

/** The `errors` consumer: every key member, then e.key, decode_body and the envelope over ERRORS_REPLIES. */
const ERRORS = `section("keys")
note(" ".join(f"{k.name}={k.value}" for k in sdk.ErrorKey))
note(f"{sdk.ErrorKey.ITEM_LOCKED == 'item.locked'} {isinstance(sdk.ErrorKey.OTHER, str)}")
c = client()


def caught(call):
    try:
        call()
    except sdk.APIStatusError as e:
        return e
    raise AssertionError("an error status was expected")


e = caught(lambda: c.items.get("i3"))
note(f"{e.status} {e.key is sdk.ErrorKey.ITEM_LOCKED} {e.decode_body(sdk.ItemLockedData)['until']}")
e = caught(lambda: c.orders.close())
note(f"{e.key is sdk.ErrorKey.ORDER_LOCKED} {e.decode_body(sdk.Lock)['until']}")
e = caught(lambda: c.users.create({"email": "a@x.test"}))
env = e.envelope
note(f"{type(e).__name__} {e.key is sdk.ErrorKey.EMAIL_TAKEN} {env.status} {env.status_key} {env.message} {env.fields['email'][0].path} {sorted(env.extra)}")
e = caught(lambda: c.users.create({"email": "a@x.test"}))
note(f"{type(e).__name__} {e.key is sdk.ErrorKey.USER_NOT_FOUND}")
e = caught(lambda: c.items.get("i4"))
note(f"{e.key is sdk.ErrorKey.ITEM_MISSING} {e.message}")
e = caught(lambda: c.items.get("i5"))
note(f"{type(e.key).__name__} {e.key}")
e = caught(lambda: c.items.get("i6"))
note(f"{e.message} {e.envelope == sdk.ErrorEnvelope()} {e.key}")
c.close()`

/** error-keys.json's 400 envelope (`fields` set), with `success` the one member ErrorEnvelope keeps in `extra`. */
const TAKEN = {
	error_key: "email_taken",
	fields: { email: [{ error_key: "taken", message: "is taken", path: "email" }] },
	message: "taken",
	status: 400,
	status_key: "bad_request",
	success: false,
}

/** What the `errors` consumer's server answers, in order. */
const ERRORS_REPLIES: readonly Reply[] = [
	{ json: { error_key: "item.locked", until: "2026-10-17" }, status: 423 },
	{ json: { error_key: "order.locked", until: "noon" }, status: 423 },
	{ json: TAKEN, status: 400 },
	{ json: { ...TAKEN, error_key: "user_not_found", fields: {}, message: "no user", status: 404 }, status: 404 },
	{ json: { error_key: "item_missing", message: "gone", status: 404, success: false }, status: 404 },
	{ json: { error_key: "nope", message: "m" }, status: 409 },
	{ status: 422, text: "oops" },
]

/** Consumer `name` (`body`) over `errors`, run against a server answering `replies`: the run and its wire. */
const consumed = (name: string, body: string, replies: readonly Reply[]) =>
	served(replies, async (server) => {
		const run = await consume("errors", name, { base: server.url, body })
		return { run, wire: server.hops.map((h) => `${h.method} ${h.url}`) }
	})

const caughtRun = once(() => consumed("caught", CAUGHT, [answer(404), answer(418)]))
const errorsRun = once(() => consumed("errors", ERRORS, ERRORS_REPLIES))

describe.skipIf(!PY)("APIStatusError, ErrorKey and ErrorEnvelope from a consumer program (errors)", SLOW, () => {
	// v0: a4c9ff918e
	it("catches a 404 with except NotFoundError (SDK) and a 418 with except APIStatusError alone (AsyncSDK)", async () => {
		const { run, wire } = await caughtRun()
		expect({ ...seen(run, "caught"), wire }, run.stderr).toEqual({
			out: ["NotFoundError 404 True HTTP 404: m", "APIStatusError 418 HTTP 418: m"],
			ran: true,
			wire: ["GET /items/i1", "GET /items/i2"],
		})
	})

	it("spells each key as the wire does, reads e.key as its member (else the server's str), the envelope, and decodes a key's body", async () => {
		/* G6: e.key is the declared member, else the server's string; decode_body is a cast; ITEM_MISSING is the $ref E404 envelope's key */
		const { run, wire } = await errorsRun()
		expect({ ...seen(run, "keys"), wire }, run.stderr).toEqual({
			out: [
				KEYS.map(([member, spelled]) => `${member}=${spelled}`).join(" "),
				"True True",
				"423 True 2026-10-17",
				"True noon",
				"BadRequestError True 400 bad_request taken email ['success']",
				"NotFoundError True",
				"True gone",
				"str nope",
				"oops True None",
			],
			ran: true,
			wire: [
				"GET /items/i3",
				"POST /a",
				"POST /users",
				"POST /users",
				"GET /items/i4",
				"GET /items/i5",
				"GET /items/i6",
			],
		})
	})
})

/** A program mypy checks against `errors`: ErrorKey's type, decode_body's, and what is not emitted. */
const TYPES = [
	"import honey_sdk as sdk",
	"",
	"",
	"def read(e: sdk.APIStatusError) -> None:",
	"    lock: sdk.ItemLockedData = e.decode_body(sdk.ItemLockedData)",
	"    wrong: int = e.decode_body(sdk.ItemLockedData)",
	"    key: sdk.ErrorKey | str | None = e.key",
	"    envelope: sdk.ErrorEnvelope = e.envelope",
	"    fields: list[sdk.FieldError] = list(envelope.fields.get('email', []))",
	"    message: str = e.message",
	"    print(lock, wrong, key, fields, message)",
	"",
	"",
	"taken: int = sdk.ErrorKey.EMAIL_TAKEN",
	"closed = sdk.OrderClosedData",
	"locked = sdk.OrderLockedData",
]

/** The finding mypy gives at `text`'s line of TYPES, as `<line>: <message>`. */
const at = (text: string, message: string) => `${TYPES.indexOf(text) + 1}: ${message}`

describe.skipIf(!PY)("ErrorKey and decode_body as mypy reads them (errors)", SLOW, () => {
	it("types a member as ErrorKey (not int), decode_body(kind) as kind, and has no Data for an envelope or a ref key", () => {
		/* §5.7 asks for reveal_type, whose note `checked` drops on a clean run: a wrong assignment names the type instead */
		const findings = checked("errors", `${TYPES.join("\n")}\n`).map((line) =>
			line.replace(/^[^:]+:(\d+): error: /, "$1: "),
		)
		expect(findings).toEqual([
			at(
				"    wrong: int = e.decode_body(sdk.ItemLockedData)",
				'Incompatible types in assignment (expression has type "ItemLockedData", variable has type "int")  [assignment]',
			),
			at(
				"taken: int = sdk.ErrorKey.EMAIL_TAKEN",
				'Incompatible types in assignment (expression has type "ErrorKey", variable has type "int")  [assignment]',
			),
			at("closed = sdk.OrderClosedData", 'Module has no attribute "OrderClosedData"  [attr-defined]'),
			at(
				"locked = sdk.OrderLockedData",
				'Module has no attribute "OrderLockedData"; maybe "ItemLockedData"?  [attr-defined]',
			),
		])
	})
})
