/**
 * The Python SDK's auth (contract 29 §5.2; Rust's and Go's `http.auth.test.ts` analog), driven on `http` (an http
 * bearer scheme) and `errors` (an apiKey in `X-API-Key`) on `AsyncSDK` and `SDK` with one expectation (G17): the
 * scheme's header and prefix read from `IR.auth`, the pair rule over `auth_header_name` and `auth_header_prefix`,
 * the credential laid last over a config or per-call `Authorization`, and `on_auth_expired`'s one refresh and one
 * retry, a replayable body resent and a one-shot one never. A consumer program `auth` covers what the driver
 * cannot: concurrent 401s (`asyncio.gather` and threads), a plain `on_auth_expired` on `AsyncSDK`, and Fc1's
 * refusals at construction (`SDK` runs plain hooks, `AsyncSDK` coroutine ones; one `ClientConfig` type serves
 * both, so mypy accepts either and only the runtime refuses).
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { PythonError, Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { checked, consume, seen } from "./__fixtures__/consumer.ts"
import { type DrivenPythonSdk, drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"
import { generatePythonSdk } from "./sdk.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }
const CLIENTS = ["async", "sync"] as const
type Client = (typeof CLIENTS)[number]
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

/** The registry SDK `key` with the driver aimed at it, which must import. */
function driven(key: Key): DrivenPythonSdk {
	const sdk = drivenPythonSdk(key)
	expect(sdk.imported, sdk.stderr).toBe(true)
	return sdk
}

type Options = { readonly key?: Key; readonly script?: Script; readonly setup?: Setup }

/** `calls` run on `client` by the `key` driver against a server answering `replies`: the run, every hop and its raw body and header lines. */
function drive(client: Client, replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = driven(options.key ?? "http")
	return served(replies, async (server) => {
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, { alt: server.alt, url: server.url }, { client, script: options.script })
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

/** A Python error as the trace records it: no cause and the method's own raise unless given, any repr. */
const plain = (entry: Partial<PythonError>) => ({ cause: null, repr: expect.any(String), via: "return", ...entry })
/** A traced error by its class and status, the legs that read no text. */
const kind = (error: PythonError | undefined) => (error === undefined ? undefined : [error.type, error.status])

const T: Setup = { auth: { kind: "bearer", token: "t" } }
const OLD: Setup = { auth: { kind: "bearer", token: "old" } }
const FRESH: Script = { onAuthExpired: { tokens: ["new"] } }

describe.skipIf(!PY)("the auth header: the spec's scheme picks its name and prefix", SLOW, () => {
	// v0: 738f6220bc
	it.each(CLIENTS)("%s: sends Authorization: Bearer abc for bearer_token abc under http bearer", async (client) => {
		const { hops, run } = await drive(client, [OK], [ECHO], { setup: { auth: { kind: "bearer", token: "abc" } } })
		expect({ observed: run.observed, sent: credentials(hops[0]) }, run.stderr).toEqual({
			observed: [OK_DATA],
			sent: { authorization: "Bearer abc" },
		})
	})

	it.each(CLIENTS)(
		"%s: sends the bare token in X-API-Key under the apiKey scheme, no Authorization",
		async (client) => {
			const { hops, run } = await drive(client, [ITEM_REPLY], [ITEM], { key: "errors", setup: T })
			expect({ observed: run.observed, sent: credentials(hops[0]) }, run.stderr).toEqual({
				observed: [ITEM_DATA],
				sent: { "x-api-key": "t" },
			})
		},
	)

	it.each(CLIENTS)(
		"%s: keeps the scheme's header for a prefix alone, \"\" meaning none; a set name takes the caller's prefix or none",
		async (client) => {
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
					await drive(client, [key === "http" ? OK : ITEM_REPLY], [key === "http" ? ECHO : ITEM], {
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
		},
	)
})

/** A one-op document under `schemes`: its emitted `_DEFAULTS` line is what the transport reads `IR.auth` from. */
function defaultsOf(schemes?: Readonly<Record<string, unknown>>): string | undefined {
	const answer = { 200: { description: "ok" } }
	const document = {
		...(schemes === undefined ? {} : { components: { securitySchemes: schemes } }),
		info: { title: "Auth", version: "1" },
		openapi: "3.1.0",
		paths: { "/echo": { get: { operationId: "echo.get", responses: answer } } },
	}
	const client = generatePythonSdk(document).files["src/honey_sdk/client.py"] ?? ""
	return client.split("\n").find((line) => line.startsWith("_DEFAULTS = "))
}

describe("the auth header: the emitter hands the transport IR.auth's name and prefix (Go's scheme legs)", () => {
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
			'_DEFAULTS = Defaults(None, "Authorization", "Bearer ")',
			'_DEFAULTS = Defaults(None, "Authorization", "Basic ")',
			'_DEFAULTS = Defaults(None, "X-API-Key", "")',
			'_DEFAULTS = Defaults(None, "Authorization", "ApiKey ")',
			'_DEFAULTS = Defaults(None, "Authorization", "Bearer ")',
			'_DEFAULTS = Defaults(None, "Authorization", "Basic ")',
		])
	})
})

describe.skipIf(!PY)("the auth header: the credential is laid last, one value per name", SLOW, () => {
	// v0: 1dccbf800f
	it.each(CLIENTS)(
		"%s: sends one authorization, the credential, over a config and a per-call Authorization",
		async (client) => {
			const setup: Setup = { auth: { kind: "bearer", token: "b" }, headers: { authorization: "Bearer a" } }
			const calls = [ECHO, { ...ECHO, headers: { Authorization: "Bearer call" } }]
			const { hops, raw, run } = await drive(client, [OK, OK], calls, { setup })
			/* req.headers keeps one of a repeated authorization: the raw lines show a duplicate */
			const lines = raw.map((pairs) => pairs.filter(([name]) => name === "authorization").length)
			expect({ lines, observed: run.observed, sent: hops.map((h) => h.headers.authorization) }, run.stderr).toEqual({
				lines: [1, 1],
				observed: [OK_DATA, OK_DATA],
				sent: ["Bearer b", "Bearer b"],
			})
		},
	)
})

describe.skipIf(!PY)("the auth refresh: a 401 calls on_auth_expired once and retries once", SLOW, () => {
	// v0: 0ce79093b8
	it.each(CLIENTS)(
		"%s: retries with the fresh token, gives up after a second 401, and sends nothing more for an empty token",
		async (client) => {
			const legs = [
				await drive(client, [{ status: 401 }, OK], [ECHO], { script: FRESH, setup: OLD }),
				await drive(client, [{ status: 401 }, { status: 401 }], [ECHO], { script: FRESH, setup: OLD }),
				await drive(client, [{ status: 401 }], [ECHO], { script: { onAuthExpired: { tokens: [""] } }, setup: OLD }),
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
				{ auth: ["Bearer old", "Bearer new"], error: ["UnauthorizedError", 401], expired: 1, observed: [UNAUTHORIZED] },
				{ auth: ["Bearer old"], error: ["UnauthorizedError", 401], expired: 1, observed: [UNAUTHORIZED] },
			])
		},
	)

	// v0: df803b008f
	// v0: 31aba57f46
	it.each(CLIENTS)(
		"%s: resends a JSON body intact on the retry and keeps the fresh token for the next call",
		async (client) => {
			const { bodies, hops, run } = await drive(client, [{ status: 401 }, USER, USER], [CREATE, GET_USER], {
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
		},
	)
})

describe.skipIf(!PY)("the auth refresh: a replayable body is resent, a one-shot one never", SLOW, () => {
	// v0: d657c2f44a
	it.each(CLIENTS)("%s: resends a bytes upload unchanged on the retry (bytes are replayable, G4)", async (client) => {
		const { hops, run } = await drive(client, [{ status: 401 }, OK], [RAW], { script: FRESH, setup: OLD })
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

	// v0: 31aba57f46
	it.each(CLIENTS)(
		"%s: never resends a one-shot upload: one hop with the whole body chunked, the 401 raised, no refresh",
		async (client) => {
			const script: Script = { ...FRESH, calls: [{ oneShotBody: true }] }
			const { hops, run } = await drive(client, [{ status: 401 }], [RAW], { script, setup: OLD })
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
				error: ["UnauthorizedError", 401],
				expired: 0,
				observed: [UNAUTHORIZED],
				sent: [["POST /raw", "Bearer old", "chunked", binaryBody(4096, "application/octet-stream")]],
			})
		},
	)
})

describe.skipIf(!PY)("the auth refresh: a failing on_auth_expired is the call's HookError", SLOW, () => {
	it.each(CLIENTS)("%s: a raising on_auth_expired ends the call as HookError with its text (Fc8)", async (client) => {
		const script: Script = { onAuthExpired: { tokens: [] } }
		const { hops, run } = await drive(client, [{ status: 401 }], [ECHO], { script, setup: OLD })
		const text = "on_auth_expired: driver: no token left"
		expect({ error: run.trace?.calls[0]?.error, hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			error: plain({ cause: "ValueError", chain: ["HookError", "HoneyError"], text, type: "HookError" }),
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

/** Three concurrent `users.get` on each client: a refresher that sleeps 100 ms and counts, then what answered. */
const CONCURRENT = `import threading
import time

section("async")
count = [0]

async def refresh() -> str:
    await asyncio.sleep(0.1)
    count[0] += 1
    return "fresh"

async with aclient(bearer_token="old", on_auth_expired=refresh) as ac:
    got = await asyncio.gather(*(ac.users.get(i) for i in ("1", "2", "3")), return_exceptions=True)
note(f"refreshes {count[0]}")
note(f"ok {sum(1 for g in got if not isinstance(g, BaseException))}")

section("threads")
counted = [0]
answered: list[bool] = []

def refresh_sync() -> str:
    time.sleep(0.1)
    counted[0] += 1
    return "fresh"

with client(bearer_token="old", on_auth_expired=refresh_sync) as c:
    def get(i: str) -> None:
        try:
            c.users.get(i)
            answered.append(True)
        except Exception:
            answered.append(False)

    threads = [threading.Thread(target=get, args=(i,)) for i in ("1", "2", "3")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
note(f"refreshes {counted[0]}")
note(f"ok {sum(answered)}")`

/** Six answers per client: three 401s, then three users. */
const CONCURRENT_REPLIES: readonly Reply[] = [0, 1].flatMap(() => [
	...Array.from({ length: 3 }, () => ({ status: 401 })),
	...Array.from({ length: 3 }, () => USER),
])

describe.skipIf(!PY)("the auth refresh: concurrent 401s share one refresh", SLOW, () => {
	it("refreshes once for three concurrent 401s, under asyncio.gather and under three threads, each retried with the one fresh token", async () => {
		const { auth, run } = await program("concurrent", CONCURRENT_REPLIES, CONCURRENT)
		const stale = ["Bearer old", "Bearer old", "Bearer old"]
		const fresh = ["Bearer fresh", "Bearer fresh", "Bearer fresh"]
		expect({ async: seen(run, "async"), auth, threads: seen(run, "threads") }, run.stderr).toEqual({
			async: { out: ["refreshes 1", "ok 3"], ran: true },
			auth: [...stale, ...fresh, ...stale, ...fresh],
			threads: { out: ["refreshes 1", "ok 3"], ran: true },
		})
	})

	// v0: c3aaf661a7
	it("refreshes from a plain on_auth_expired on AsyncSDK, the retry carrying its token", async () => {
		const body = `async with aclient(bearer_token="old", on_auth_expired=lambda: "new") as ac:
    note((await ac.users.get("1"))["id"])`
		const { auth, run } = await program("plain-refresh", [{ status: 401 }, USER], body)
		expect({ auth, ...seen(run) }, run.stderr).toEqual({ auth: ["Bearer old", "Bearer new"], out: ["u1"], ran: true })
	})
})

/** Each client built with a hook it never runs, then called: what it raised, or that it was built and answered. */
const REFUSALS = `async def refresh() -> str:
    return "new"

def hook(ctx: object) -> None:
    pass

section("loop")
try:
    c = client(bearer_token="old", on_auth_expired=refresh)
    note("built")
    c.users.get("1")
    note("answered")
except sdk.HoneyError as error:
    note(f"{type(error).__name__}: {error}")

section("sync")
try:
    c = client(on_request=[hook])
    note("built")
    c.users.get("1")
    note("answered")
except sdk.HoneyError as error:
    note(f"{type(error).__name__}: {error}")

section("async")
try:
    ac = aclient(on_request_sync=[hook])
    note("built")
    await ac.users.get("1")
    note("answered")
except sdk.HoneyError as error:
    note(f"{type(error).__name__}: {error}")`

describe.skipIf(!PY)("the hooks a client never runs: refused at construction (Fc1)", SLOW, () => {
	/* ruling change: v0 ran a coroutine on_auth_expired from SDK on a worker thread (_runtime.py:161-188); honey-a8 ruled
	   SDK plain-only, so SDK built inside a running loop (main runs under asyncio.run) with an async def refuses it */
	// v0: 31aba57f46
	it("refuses an async on_auth_expired on SDK inside a running loop, and a hook in the other client's list, nothing sent", async () => {
		const { auth, run } = await program("refusals", [{ status: 401 }, USER], REFUSALS)
		const sync = "ConfigError: SDK runs on_request_sync, on_response_sync and a plain on_auth_expired"
		expect(
			{ async: seen(run, "async"), hops: auth.length, loop: seen(run, "loop"), sync: seen(run, "sync") },
			run.stderr,
		).toEqual({
			async: { out: ["ConfigError: AsyncSDK runs on_request and on_response"], ran: true },
			hops: 0,
			loop: { out: [sync], ran: true },
			sync: { out: [sync], ran: true },
		})
	})

	it("type-checks a plain and an async on_auth_expired on the one ClientConfig: only the runtime refuses", () => {
		const source = `import asyncio

import honey_sdk as sdk


async def refresh() -> str:
    await asyncio.sleep(0)
    return "t"


plain = sdk.ClientConfig(on_auth_expired=lambda: "t")
coroutine = sdk.ClientConfig(on_auth_expired=refresh)
`
		expect(checked("http", source)).toEqual([])
	})
})
