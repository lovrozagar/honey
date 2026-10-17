/**
 * The C# SDK's errors (contract 47 §5.8; Fc3, Fc4): an error status throws its `ApiStatusException` subclass, its
 * `Message` `HTTP <status>: <Detail>` (the detail sanitized and cut at 512 runes), every other failure its own
 * `HoneyException`; each API's `ErrorKey`, a static class of string constants (§2.3), and its `<Key>Data`, read
 * through `Key` and `DecodeBody<T>()`; `ErrorEnvelope`, the body's envelope. Driven through the C# driver on
 * `errors` (its one async client: no drift check), one consumer program, and csc's findings. Safe mode is
 * errors.safe.test.ts. Ported from Python's errors.test.ts:60-434 (contract 47 §6).
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { CsError, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, recordingServer, served } from "../shared/__fixtures__/recording-server.ts"
import { errors } from "../shared/__fixtures__/documents-http.ts"
import { checked, consume, program, seen } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { csharpHttp } from "./__fixtures__/documents-http.ts"
import { type DrivenCSharpSdk, drivenCSharpSdk } from "./__fixtures__/driven.ts"
import { generateCSharpSdk } from "./sdk.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
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

/** §2.3's `ErrorKey` for KEYS, exactly as `Types.cs` ends. */
const ERROR_KEY = `/// <summary>The error keys the API declares: ApiStatusException.Key is one of these, else the server's own string.</summary>
/// <remarks>item.locked: its body decodes as ItemLockedData (ApiStatusException.DecodeBody). order.locked: its body decodes as Lock.</remarks>
public static class ErrorKey
{
${KEYS.map(([member, wire]) => `    public const string ${member} = "${wire}";\n`).join("")}}
`

/** `ItemLockedData`, item.locked's inline schema as a hoisted record (§2.3). */
const ITEM_LOCKED_DATA = `
public sealed record ItemLockedData
{
    [JsonPropertyName("until")]
    public string? Until { get; init; }
}
`

/** The line of `files[name]` that declares `_defaults`. */
const defaultsOf = (files: Readonly<Record<string, string>>) =>
	(files["Client.cs"] ?? "").split("\n").find((line) => line.includes(" _defaults = "))

describe("ErrorKey: the string constants each API declares (Fc3, §2.3)", () => {
	// ported: python errors.test.ts:60 (the ErrorKey block)
	it("ends Types.cs with ErrorKey over every declared key in code-unit order, colliding names numbered", () => {
		const types = generateCSharpSdk(errors()).files["Types.cs"] ?? ""
		expect(types.endsWith(`}\n\n${ERROR_KEY}`), types.slice(-1500)).toBe(true)
	})

	// ported: python errors.test.ts:67 (ItemLockedData), :76 (the defaults, no envelope or ref Data)
	it("declares ItemLockedData and lists it in the context, hands the context's Options to Defaults, and names no envelope or ref Data", () => {
		const files = generateCSharpSdk(errors()).files
		const context = files["JsonContext.cs"] ?? ""
		expect({
			context: context.includes('[JsonSerializable(typeof(ItemLockedData), TypeInfoPropertyName = "ItemLockedData")]'),
			declared: (files["Types.cs"] ?? "").includes(ITEM_LOCKED_DATA),
			defaults: defaultsOf(files),
			unnamed: Object.values(files).flatMap((text) => text.match(/\bOrder(Closed|Locked)Data\b/g) ?? []),
		}).toEqual({
			context: true,
			declared: true,
			defaults:
				'    private static readonly Defaults _defaults = new(null, "X-API-Key", "", HoneySdkJsonContext.Default.Options);',
			unnamed: [],
		})
	})

	// ported: python errors.test.ts:90
	it("emits no ErrorKey for an API without keys (http), its Defaults still taking the context's Options", () => {
		const files = generateCSharpSdk(csharpHttp()).files
		expect({
			declared: Object.entries(files)
				.filter(([, text]) => /\bclass ErrorKey\b/.test(text))
				.map(([name]) => name),
			defaults: defaultsOf(files),
		}).toEqual({
			declared: [],
			defaults:
				'    private static readonly Defaults _defaults = new(null, "Authorization", "Bearer ", HoneySdkJsonContext.Default.Options);',
		})
	})
})

/** One op declaring keys whose names collide with ErrorKey, an object member, and each other, in code-unit order. */
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

describe("ErrorKey's member names (Fc3)", () => {
	it("names each key by csTypeName in a scope reserving ErrorKey and the object members: a repeat numbered", () => {
		/* Fc3: ErrorKey (CS0542) and Equals/GetHashCode/… (CS0108 under warnings as errors) are claimed first */
		const types = generateCSharpSdk(NAMES).files["Types.cs"] ?? ""
		const members = [...types.matchAll(/^ {4}public const string (\w+) = "([^"]*)";$/gm)].map((m) => [m[1], m[2]])
		expect(members).toEqual([
			["NotFound", "NotFound"],
			["Equals2", "equals"],
			["ErrorKey2", "error_key"],
			["NotFound2", "not-found"],
			["NotFound3", "not_found"],
		])
	})
})

const ITEM: Call = { operation: "items.get", params: { id: "i1" }, route: { method: "GET", path: "/items/{id}" } }

/** The `errors` SDK with the driver aimed at it (it must build). */
function on(): DrivenCSharpSdk {
	const sdk = drivenCSharpSdk("errors")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
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

/** `calls` against an origin that refuses every connection. */
async function refused(calls: readonly Call[]) {
	const sdk = on()
	const closed = await recordingServer([])
	await closed.close()
	return sdk.runCalls({ calls, setup: {} }, { url: closed.url }, { script: {} })
}

type Run = Awaited<ReturnType<DrivenCSharpSdk["runCalls"]>>
const errorsOf = (run: Run) => (run.trace?.calls ?? []).map((call) => call.error)

/** A C# error as the trace records it: no inner, not canceled, the method's own throw unless given, any display. */
const plain = (entry: Partial<CsError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})
const statusChain = (type: string) => [type, "ApiStatusException", "HoneyException"]
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

describe.skipIf(!DOTNET)(
	"an error status throws its ApiStatusException subclass: HTTP <status>: <Detail>",
	SLOW,
	() => {
		// ported: python errors.test.ts:171
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

		// ported: python errors.test.ts:186
		it("throws a status no subclass names as UnexpectedStatusException: 418 and 410", async () => {
			const { run } = await drive([answer(418), answer(410)], [ITEM, ITEM])
			expect({ errors: errorsOf(run), observed: run.observed }, run.stderr).toEqual({
				errors: [unkeyed(418, "UnexpectedStatusException"), unkeyed(410, "UnexpectedStatusException")],
				observed: [failed(418), failed(410)],
			})
		})
	},
)

describe.skipIf(!DOTNET)("a hostile error body in Detail and Message", SLOW, () => {
	// ported: python errors.test.ts:197
	it("drops category C and U+FFFD, then cuts Detail at 512 runes plus …; the raw body kept", async () => {
		const hostile = `\x1b]0;pwned\x07${"x".repeat(20_000 - 10)}`
		const message = `]0;pwned${"x".repeat(504)}…`
		const { run } = await drive([{ status: 500, text: hostile }], [ITEM])
		const error = run.trace?.calls[0]?.error
		expect({ message: error?.message, observed: run.observed, text: error?.text }, run.stderr).toEqual({
			message,
			observed: [{ body: hostile, errorKey: null, kind: "error", status: 500 }],
			text: `HTTP 500: ${message}`,
		})
	})

	// ported: python errors.test.ts:214
	it("reads a problem+json 422 into the envelope, its Detail and Message free of ESC", async () => {
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

describe.skipIf(!DOTNET)(
	"each way a call fails, one HoneyException class each: a status only with an answer",
	SLOW,
	() => {
		// ported: python errors.test.ts:238
		it("ends an error status as its subclass, an undecodable 2xx as DecodeException, a bad path param as PathParamException, a refused connection as ApiConnectionException", async () => {
			const gone: Reply = { json: { message: "gone" }, status: 404 }
			const torn: Reply = { headers: { "content-type": "application/json" }, status: 200, text: '{"id":' }
			const dots: Call = { ...ITEM, params: { id: ".." } }
			const { hops, run } = await drive([gone, torn], [ITEM, ITEM, dots])
			const lost = await refused([ITEM])
			const [api, decode, path] = errorsOf(run)
			const transport = lost.trace?.calls[0]?.error
			const shapes = [api, decode, path, transport].map((e) => [e?.chain, e?.status, e?.inner])
			const observed = [run.observed, lost.observed]
			expect({ hops, observed, path: path?.text, shapes }, run.stderr + lost.stderr).toEqual({
				hops: 2,
				observed: [[{ body: { message: "gone" }, errorKey: null, kind: "error", status: 404 }, null, null], [null]],
				path: 'path param id: ".." is not a path segment',
				shapes: [
					[statusChain("NotFoundException"), 404, null],
					[["DecodeException", "HoneyException"], undefined, "JsonException"],
					[["PathParamException", "HoneyException"], undefined, null],
					[["ApiConnectionException", "HoneyException"], undefined, "HttpRequestException"],
				],
			})
		})

		// ported: python errors.test.ts:266
		it("ends a lapsed per-call timeout as ApiTimeoutException and a cancel before the call as the caller's OCE, neither with a status", async () => {
			const late: Reply = { delayMs: 2000, json: { id: "i1", name: "n" }, status: 200 }
			const script: Script = { calls: [null, { cancel: "before" }] }
			const { hops, run } = await drive([late], [{ ...ITEM, timeoutMs: 300 }, ITEM], script)
			const [timeout, canceled] = errorsOf(run)
			expect(
				{ canceled, hops, observed: run.observed, statuses: [timeout?.status, canceled?.status], timeout },
				run.stderr,
			).toEqual({
				canceled: expect.objectContaining({ canceled: true, via: "return" }),
				hops: 1,
				observed: [{ kind: "timeout" }, null],
				statuses: [undefined, undefined],
				timeout: plain({
					chain: ["ApiTimeoutException", "HoneyException"],
					inner: expect.stringMatching(/^(Task|Operation)CanceledException$/),
					text: "GET /items/{id} timed out after 300 ms",
					type: "ApiTimeoutException",
				}),
			})
		})
	},
)

/** The `caught` section: `catch` on a subclass and on the base. */
const CAUGHT = `Section("caught");
using var c = Client();
try
{
    await c.Items.GetAsync("i1");
}
catch (NotFoundException nf)
{
    Note($"{nf.GetType().Name} {nf.Status} {nf.Message}");
}
try
{
    await c.Items.GetAsync("i2");
}
catch (NotFoundException)
{
    Note("a 418 caught as NotFoundException");
}
catch (ApiStatusException st)
{
    Note($"{st.GetType().Name} {st.Status} {st.Message}");
}`

/** The `keys` section: every ErrorKey constant, then Key, DecodeBody<T>() and the envelope over KEYS_REPLIES. */
const KEYED = `Section("keys");
var names = new List<string>();
foreach (var field in typeof(ErrorKey).GetFields())
{
    names.Add($"{field.Name}={field.GetRawConstantValue()}");
}
Note(string.Join(" ", names));
async Task<ApiStatusException> Caught(Func<Task> call)
{
    try
    {
        await call();
    }
    catch (ApiStatusException failure)
    {
        return failure;
    }
    throw new InvalidOperationException("an error status was expected");
}
var err = await Caught(() => c.Items.GetAsync("i3"));
Note($"{err.Status} {err.Key == ErrorKey.ItemLocked} {err.DecodeBody<ItemLockedData>().Until}");
err = await Caught(() => c.Orders.CloseAsync());
Note($"{err.Key == ErrorKey.OrderLocked} {err.DecodeBody<Lock>().Until}");
err = await Caught(() => c.Users.CreateAsync(new UsersCreateBody { Email = "a@x.test" }));
var env = err.Envelope;
Note($"{err.GetType().Name} {err.Key == ErrorKey.EmailTaken} {env.Status} {env.StatusKey} {err.Detail} {env.Fields["email"][0].Path} {string.Join(",", env.Extra.Keys)}");
err = await Caught(() => c.Users.CreateAsync(new UsersCreateBody { Email = "a@x.test" }));
Note($"{err.GetType().Name} {err.Key == ErrorKey.UserNotFound}");
err = await Caught(() => c.Items.GetAsync("i4"));
Note($"{err.Key == ErrorKey.ItemMissing} {err.Detail}");
err = await Caught(() => c.Items.GetAsync("i5"));
Note($"{err.Key} {err.Key is ErrorKey.Other}");
err = await Caught(() => c.Items.GetAsync("i6"));
env = err.Envelope;
var empty = env.Status is null && env.ErrorKey is null && env.StatusKey is null && env.Message is null && env.Fields.Count == 0 && env.Extra.Count == 0;
Note($"{err.Detail} {empty} {err.Key is null}");
try
{
    Note(err.DecodeBody<Lock>().Until);
}
catch (DecodeException d)
{
    Note($"{d.GetType().Name} {d.Message}");
}`

/** error-keys.json's 400 envelope (`fields` set), with `success` the one member ErrorEnvelope does not name. */
const TAKEN = {
	error_key: "email_taken",
	fields: { email: [{ error_key: "taken", message: "is taken", path: "email" }] },
	message: "taken",
	status: 400,
	status_key: "bad_request",
	success: false,
}

/** What the program's server answers, in order: CAUGHT's two, then KEYED's. */
const REPLIES: readonly Reply[] = [
	answer(404),
	answer(418),
	{ json: { error_key: "item.locked", until: "2026-10-17" }, status: 423 },
	{ json: { error_key: "order.locked", until: "noon" }, status: 423 },
	{ json: TAKEN, status: 400 },
	{ json: { ...TAKEN, error_key: "user_not_found", fields: {}, message: "no user", status: 404 }, status: 404 },
	{ json: { error_key: "item_missing", message: "gone", status: 404, success: false }, status: 404 },
	{ json: { error_key: "nope", message: "m" }, status: 409 },
	{ status: 422, text: "oops" },
]

/** The `errors` program, run once against REPLIES: the run and its wire. */
let errorsRun: Promise<{ run: Awaited<ReturnType<typeof consume>>; wire: string[] }> | undefined
const consumed = () =>
	(errorsRun ??= served(REPLIES, async (server) => {
		const run = await consume("errors", "errors", { base: server.url, body: `${CAUGHT}\n${KEYED}` })
		return { run, wire: server.hops.map((h) => `${h.method} ${h.url}`) }
	}))

describe.skipIf(!DOTNET)(
	"ApiStatusException, ErrorKey and ErrorEnvelope from a consumer program (errors)",
	SLOW,
	() => {
		// ported: python errors.test.ts:372
		it("catches a 404 with catch (NotFoundException) and a 418 with catch (ApiStatusException) alone", async () => {
			const { run, wire } = await consumed()
			expect({ ...seen(run, "caught"), wire: wire.slice(0, 2) }, run.stderr).toEqual({
				out: ["NotFoundException 404 HTTP 404: m", "UnexpectedStatusException 418 HTTP 418: m"],
				ran: true,
				wire: ["GET /items/i1", "GET /items/i2"],
			})
		})

		// ported: python errors.test.ts:381
		it("spells each key as the wire does, reads Key against the constants (else the server's string), the envelope, and DecodeBody<T>()", async () => {
			const { run, wire } = await consumed()
			expect({ ...seen(run, "keys"), wire: wire.slice(2) }, run.stderr).toEqual({
				out: [
					KEYS.map(([member, spelled]) => `${member}=${spelled}`).join(" "),
					"423 True 2026-10-17",
					"True noon",
					"BadRequestException True 400 bad_request taken email success",
					"NotFoundException True",
					"True gone",
					"nope False",
					"oops True True",
					"DecodeException HTTP 422: the body is not JSON",
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
	},
)

/** A program csc checks against `errors`: ErrorKey's type, DecodeBody<T>'s, and what is not emitted. */
const TYPES = [
	"ApiStatusException? e = null;",
	"if (e is not null)",
	"{",
	"    ItemLockedData d = e.DecodeBody<ItemLockedData>();",
	"    string? key = e.Key;",
	"    Note(d);",
	"    Note(key);",
	"}",
	"int x = ErrorKey.EmailTaken;",
	"Note(x);",
	"Note(typeof(OrderClosedData));",
	"Note(typeof(OrderLockedData));",
]

/** csc's errors for TYPES against `errors`, each as `<the statement> → <CS code>: <message>`. */
function findings(): string[] {
	const source = program("HoneySdk", "HoneySdkClient", TYPES.join("\n"))
	const text = source.split("\n")
	return checked("errors", source).map((line) => {
		const found = /^\((\d+),\d+\): error (CS\d+: .*)$/.exec(line)
		return found === null ? line : `${text[Number(found[1]) - 1]?.trim()} → ${found[2]}`
	})
}

/** csc's CS0246 for a type the SDK does not declare. */
const missing = (type: string) =>
	`CS0246: The type or namespace name '${type}' could not be found (are you missing a using directive or an assembly reference?)`

describe.skipIf(!DOTNET)("ErrorKey and DecodeBody<T> as csc reads them (errors)", SLOW, () => {
	// ported: python errors.test.ts:434
	it("types a constant as string (not int), DecodeBody<T>() as T, and has no Data for an envelope or a ref key", () => {
		expect(findings()).toEqual([
			"int x = ErrorKey.EmailTaken; → CS0029: Cannot implicitly convert type 'string' to 'int'",
			`Note(typeof(OrderClosedData)); → ${missing("OrderClosedData")}`,
			`Note(typeof(OrderLockedData)); → ${missing("OrderLockedData")}`,
		])
	})
})
