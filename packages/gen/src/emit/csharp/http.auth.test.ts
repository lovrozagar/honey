/**
 * The C# SDK's auth (contract 47 §5.2; Python's, Rust's and Go's `http.auth.test.ts` analog), driven on `http` (an
 * http bearer scheme) and `errors` (an apiKey in `X-API-Key`) on C#'s one async client: the scheme's header and
 * prefix read from `IR.auth` (`_defaults`, now with the context's options), the pair rule over `AuthHeaderName` and
 * `AuthHeaderPrefix`, the credential laid last over a config or per-call `Authorization`, and `OnAuthExpired`'s one
 * refresh and one retry, a replayable body (JSON, `byte[]`) resent and a one-shot `Stream` never. Consumer programs
 * cover what the driver cannot: concurrent 401s sharing one refresh (`Task.WhenAll`), and a refresher that honors
 * the call's token (Fc8).
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { CsError, Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, seen } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { type DrivenCSharpSdk, drivenCSharpSdk } from "./__fixtures__/driven.ts"
import { generateCSharpSdk } from "./sdk.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }
type Key = "errors" | "http"

const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const ITEM: Call = { operation: "items.get", params: { id: "i1" }, route: { method: "GET", path: "/items/{id}" } }
const post = (operation: string, path: string, body: Call["body"]): Call => ({
	body,
	operation,
	route: { method: "POST", path },
})
const CREATE = post("users.create", "/users", { kind: "json", value: { name: "retry-body" } })
const RAW = post("raw.send", "/raw", { contentType: "application/octet-stream", kind: "binary", size: 4096 })
const GET_USER: Call = { operation: "users.get", params: { id: "1" }, route: { method: "GET", path: "/users/{id}" } }

const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 }
const USER: Reply = { json: { id: "u1" }, status: 200 }
const USER_DATA = { data: { id: "u1" }, kind: "data", status: 200 }
const ITEM_REPLY: Reply = { json: { id: "i1", name: "n" }, status: 200 }
const ITEM_DATA = { data: { id: "i1", name: "n" }, kind: "data", status: 200 }
const UNAUTHORIZED = { errorKey: null, kind: "error", status: 401 }

/** The registry SDK `key` with the driver aimed at it (it must build). */
function on(key: Key): DrivenCSharpSdk {
	const sdk = drivenCSharpSdk(key)
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

type Options = { readonly key?: Key; readonly script?: Script; readonly setup?: Setup }

/** `calls` run by the `key` driver against a server answering `replies`: the run, every hop and its raw body and header lines. */
function drive(replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = on(options.key ?? "http")
	return served(replies, async (server) => {
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, { alt: server.alt, url: server.url }, { script: options.script })
		return { bodies: [...server.bodies], hops: [...server.hops], raw: [...server.rawHeaders], run }
	})
}

/** Every header a hop may carry the credential in, unset ones dropped by `toEqual` (Go `http.auth.test.ts:97-102`). */
const credentials = (hop: RecordedHop | undefined) => ({
	authorization: hop?.headers.authorization,
	"x-api-key": hop?.headers["x-api-key"],
	"x-raw": hop?.headers["x-raw"],
	"x-token": hop?.headers["x-token"],
})

/** A body of `size` bytes `i & 0xff`, as a hop records an upload of it. */
function binaryBody(size: number, contentType: string) {
	const bytes = Buffer.from(Array.from({ length: size }, (_, i) => i & 0xff))
	return { contentType, sha256: createHash("sha256").update(bytes).digest("hex"), size }
}

/** A C# error as the trace records it: no inner, not canceled, the method's own throw unless given, any display. */
const plain = (entry: Partial<CsError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})
/** A traced error by its type and status, the legs that read no text. */
const kind = (error: CsError | undefined) => (error === undefined ? undefined : [error.type, error.status])

const T: Setup = { auth: { kind: "bearer", token: "t" } }
const OLD: Setup = { auth: { kind: "bearer", token: "old" } }
const FRESH: Script = { onAuthExpired: { tokens: ["new"] } }

describe.skipIf(!DOTNET)("the auth header: the spec's scheme picks its name and prefix", SLOW, () => {
	// parity: py http.auth.test.ts:92
	it("sends Authorization: Bearer abc for BearerToken abc under http bearer", async () => {
		const { hops, run } = await drive([OK], [ECHO], { setup: { auth: { kind: "bearer", token: "abc" } } })
		expect({ observed: run.observed, sent: credentials(hops[0]) }, run.stderr).toEqual({
			observed: [OK_DATA],
			sent: { authorization: "Bearer abc" },
		})
	})

	// parity: py http.auth.test.ts:100
	it("sends the bare token in X-API-Key under the apiKey scheme, no Authorization", async () => {
		const { hops, run } = await drive([ITEM_REPLY], [ITEM], { key: "errors", setup: T })
		expect({ observed: run.observed, sent: credentials(hops[0]) }, run.stderr).toEqual({
			observed: [ITEM_DATA],
			sent: { "x-api-key": "t" },
		})
	})

	// parity: py http.auth.test.ts:111
	it("keeps the scheme's header for a prefix alone, \"\" meaning none; a set name takes the caller's prefix or none", async () => {
		const legs: [Key, NonNullable<Script["config"]>][] = [
			["http", { authHeaderName: "X-Token", authHeaderPrefix: "Token " }],
			["http", { authHeaderPrefix: "Key " }],
			["http", { authHeaderPrefix: "" }],
			["http", { authHeaderName: "X-Raw" }],
			["errors", { authHeaderPrefix: "Key " }],
		]
		const runs = []
		for (const [key, config] of legs)
			runs.push(
				await drive([key === "http" ? OK : ITEM_REPLY], [key === "http" ? ECHO : ITEM], {
					key,
					script: { config },
					setup: T,
				}),
			)
		expect(
			runs.map(({ hops }) => credentials(hops[0])),
			runs.map(({ run }) => run.stderr).join("\n"),
		).toEqual([
			{ "x-token": "Token t" },
			{ authorization: "Key t" },
			{ authorization: "t" },
			{ "x-raw": "t" },
			{ "x-api-key": "Key t" },
		])
	})
})

/** A one-op document under `schemes`: its emitted `_defaults` line is what the transport reads `IR.auth` from. */
function defaultsOf(schemes?: Readonly<Record<string, unknown>>): string | undefined {
	const answer = { 200: { description: "ok" } }
	const document = {
		...(schemes === undefined ? {} : { components: { securitySchemes: schemes } }),
		info: { title: "Auth", version: "1" },
		openapi: "3.1.0",
		paths: { "/echo": { get: { operationId: "echo.get", responses: answer } } },
	}
	const client = generateCSharpSdk(document).files["Client.cs"] ?? ""
	return client
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.startsWith("private static readonly Defaults _defaults = "))
}

/** The `_defaults` line for `header` and `prefix`, with no server and the default context's options (§2, Fc4). */
const defaults = (header: string, prefix: string) =>
	`private static readonly Defaults _defaults = new(null, "${header}", "${prefix}", HoneySdkJsonContext.Default.Options);`

describe("the auth header: the emitter hands the transport IR.auth's name and prefix (Go's scheme legs)", () => {
	// parity: py http.auth.test.ts:157, go http.auth.test.ts:115-169
	it("emits the scheme's pair: none or a query apiKey Bearer, basic, an apiKey's own header bare or its Format hint, the first of two schemes", () => {
		const schemes = [
			undefined,
			{ basic: { scheme: "basic", type: "http" } },
			{ key: { in: "header", name: "X-API-Key", type: "apiKey" } },
			{
				key: {
					description: "API key authentication. Format: ApiKey {your_api_key}",
					in: "header",
					name: "Authorization",
					type: "apiKey",
				},
			},
			{ q: { in: "query", name: "api_key", type: "apiKey" } },
			{ zeta: { scheme: "bearer", type: "http" }, alpha: { scheme: "basic", type: "http" } },
		]
		expect(schemes.map(defaultsOf)).toEqual([
			defaults("Authorization", "Bearer "),
			defaults("Authorization", "Basic "),
			defaults("X-API-Key", ""),
			defaults("Authorization", "ApiKey "),
			defaults("Authorization", "Bearer "),
			defaults("Authorization", "Basic "),
		])
	})
})

describe.skipIf(!DOTNET)("the auth header: the credential is laid last, one value per name", SLOW, () => {
	// parity: py http.auth.test.ts:187
	it("sends one authorization, the credential, over a config and a per-call Authorization", async () => {
		const setup: Setup = { auth: { kind: "bearer", token: "b" }, headers: { authorization: "Bearer a" } }
		const calls = [ECHO, { ...ECHO, headers: { Authorization: "Bearer call" } }]
		const { hops, raw, run } = await drive([OK, OK], calls, { setup })
		/* req.headers keeps one of a repeated authorization: the raw lines show a duplicate */
		const lines = raw.map((pairs) => pairs.filter(([name]) => name === "authorization").length)
		expect({ lines, observed: run.observed, sent: hops.map((h) => h.headers.authorization) }, run.stderr).toEqual({
			lines: [1, 1],
			observed: [OK_DATA, OK_DATA],
			sent: ["Bearer b", "Bearer b"],
		})
	})
})

describe.skipIf(!DOTNET)("the auth refresh: a 401 calls OnAuthExpired once and retries once", SLOW, () => {
	// parity: py http.auth.test.ts:206
	it("retries with the fresh token, gives up after a second 401, and sends nothing more for an empty token", async () => {
		const legs = [
			await drive([{ status: 401 }, OK], [ECHO], { script: FRESH, setup: OLD }),
			await drive([{ status: 401 }, { status: 401 }], [ECHO], { script: FRESH, setup: OLD }),
			await drive([{ status: 401 }], [ECHO], { script: { onAuthExpired: { tokens: [""] } }, setup: OLD }),
		]
		expect(
			legs.map(({ hops, run }) => ({
				auth: hops.map((h) => h.headers.authorization),
				error: kind(run.trace?.calls[0]?.error),
				expired: run.trace?.authExpired,
				observed: run.observed,
			})),
			legs.map(({ run }) => run.stderr).join("\n"),
		).toEqual([
			{ auth: ["Bearer old", "Bearer new"], error: undefined, expired: 1, observed: [OK_DATA] },
			{
				auth: ["Bearer old", "Bearer new"],
				error: ["UnauthorizedException", 401],
				expired: 1,
				observed: [UNAUTHORIZED],
			},
			{ auth: ["Bearer old"], error: ["UnauthorizedException", 401], expired: 1, observed: [UNAUTHORIZED] },
		])
	})

	// parity: py http.auth.test.ts:232
	it("resends a JSON body intact on the retry and keeps the fresh token for the next call", async () => {
		const { bodies, hops, run } = await drive([{ status: 401 }, USER, USER], [CREATE, GET_USER], {
			script: FRESH,
			setup: OLD,
		})
		const sent = '{"name":"retry-body"}'
		expect(
			{
				auth: hops.map((h) => `${h.method} ${h.url} ${h.headers.authorization}`),
				bodies: bodies.map((b) => b.toString("utf8")),
				expired: run.trace?.authExpired,
				observed: run.observed,
			},
			run.stderr,
		).toEqual({
			auth: ["POST /users Bearer old", "POST /users Bearer new", "GET /users/1 Bearer new"],
			bodies: [sent, sent, ""],
			expired: 1,
			observed: [USER_DATA, USER_DATA],
		})
	})
})

describe.skipIf(!DOTNET)("the auth refresh: a replayable body is resent, a one-shot one never", SLOW, () => {
	// parity: py http.auth.test.ts:260
	it("resends a byte[] upload unchanged on the retry (byte[] is replayable, Fc6)", async () => {
		const { hops, run } = await drive([{ status: 401 }, OK], [RAW], { script: FRESH, setup: OLD })
		const sent = binaryBody(4096, "application/octet-stream")
		expect(
			{
				expired: run.trace?.authExpired,
				hops: hops.map((h) => [h.headers.authorization, h.body]),
				observed: run.observed,
			},
			run.stderr,
		).toEqual({
			expired: 1,
			hops: [
				["Bearer old", sent],
				["Bearer new", sent],
			],
			observed: [OK_DATA],
		})
	})

	// parity: py http.auth.test.ts:281, rust http.auth.test.ts:216
	it("never resends a one-shot Stream: one hop with the whole body chunked, the 401 thrown, no refresh", async () => {
		const script: Script = { ...FRESH, calls: [{ oneShotBody: true }] }
		const { hops, run } = await drive([{ status: 401 }], [RAW], { script, setup: OLD })
		const sent = hops.map((h) => [
			`${h.method} ${h.url}`,
			h.headers.authorization,
			h.headers["transfer-encoding"],
			h.body,
		])
		expect(
			{ error: kind(run.trace?.calls[0]?.error), expired: run.trace?.authExpired, observed: run.observed, sent },
			run.stderr,
		).toEqual({
			error: ["UnauthorizedException", 401],
			expired: 0,
			observed: [UNAUTHORIZED],
			sent: [["POST /raw", "Bearer old", "chunked", binaryBody(4096, "application/octet-stream")]],
		})
	})
})

describe.skipIf(!DOTNET)("the auth refresh: a failing OnAuthExpired is the call's HookException", SLOW, () => {
	// parity: py http.auth.test.ts:306
	it("a throwing OnAuthExpired ends the call as HookException with its text and its exception inner", async () => {
		const script: Script = { onAuthExpired: { tokens: [] } }
		const { hops, run } = await drive([{ status: 401 }], [ECHO], { script, setup: OLD })
		const text = "on_auth_expired: driver: no token left"
		expect({ error: run.trace?.calls[0]?.error, hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			error: plain({
				chain: ["HookException", "HoneyException"],
				inner: "InvalidOperationException",
				text,
				type: "HookException",
			}),
			hops: 1,
			observed: [null],
		})
	})
})

/** Consumer program `name` on `http` run once against a server answering `replies`: its run and every hop's credential. */
const program = (name: string, replies: readonly Reply[], body: string) =>
	served(replies, async (server) => {
		const run = await consume("http", name, { base: server.url, body })
		return { auth: server.hops.map((h) => h.headers.authorization), run }
	})

/** Three concurrent `users.get` on one client: a refresher that waits 100 ms on the call's token and counts, then what answered. */
const CONCURRENT = `var count = 0;
var config = new ClientConfig
{
    BearerToken = "old",
    OnAuthExpired = async ct =>
    {
        await Task.Delay(100, ct);
        System.Threading.Interlocked.Increment(ref count);
        return "fresh";
    },
};
using var c = Client(config);
async Task<bool> Get(string id)
{
    try
    {
        await c.Users.GetAsync(id);
        return true;
    }
    catch (HoneyException)
    {
        return false;
    }
}
var got = await Task.WhenAll(Get("1"), Get("2"), Get("3"));
Note($"refreshes {count}");
Note($"ok {Array.FindAll(got, answered => answered).Length}");`

/** Three 401s, then three users. */
const CONCURRENT_REPLIES: readonly Reply[] = [
	...Array.from({ length: 3 }, () => ({ status: 401 })),
	...Array.from({ length: 3 }, () => USER),
]

/**
 * A refresher waiting on the call's token, the call's token canceled at 100 ms: the caller's cancel as thrown, well
 * before the refresher's own 5 s (a refresher handed no token would answer after it, and the retry with it).
 */
const HONORED = `var config = new ClientConfig
{
    BearerToken = "old",
    OnAuthExpired = async ct =>
    {
        await Task.Delay(5000, ct);
        return "late";
    },
};
using var c = Client(config);
using var cts = new System.Threading.CancellationTokenSource(100);
var clock = System.Diagnostics.Stopwatch.StartNew();
try
{
    await c.Users.GetAsync("1", cancellationToken: cts.Token);
    Note("answered");
}
catch (OperationCanceledException)
{
    Note($"canceled {clock.ElapsedMilliseconds < 2000}");
}
catch (HoneyException e)
{
    Note($"{e.GetType().Name}: {e.Message}");
}`

describe.skipIf(!DOTNET)(
	"the auth refresh: concurrent 401s share one refresh; the refresher gets the call's token",
	SLOW,
	() => {
		// parity: py http.auth.test.ts:374
		it("refreshes once for three concurrent 401s under Task.WhenAll, each retried with the one fresh token", async () => {
			const { auth, run } = await program("concurrent", CONCURRENT_REPLIES, CONCURRENT)
			expect({ auth, ...seen(run) }, run.stderr).toEqual({
				auth: ["Bearer old", "Bearer old", "Bearer old", "Bearer fresh", "Bearer fresh", "Bearer fresh"],
				out: ["refreshes 1", "ok 3"],
				ran: true,
			})
		})

		// parity: Fc8 (a refresher is async on the call's token)
		it("ends a refresh waiting on the call's token when the caller cancels: the cancel as thrown, one hop", async () => {
			const { auth, run } = await program("honored", [{ status: 401 }, USER], HONORED)
			expect({ auth, ...seen(run) }, run.stderr).toEqual({
				auth: ["Bearer old"],
				out: ["canceled True"],
				ran: true,
			})
		})
	},
)
