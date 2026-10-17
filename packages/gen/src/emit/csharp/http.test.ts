/**
 * The C# SDK's request build, executed (contract 47 §5.1; Python's and Rust's `http.test.ts` analog): path params
 * escaped as one segment each in path order (`user-id` taken as `userId`) and refused when no segment can hold them,
 * the base URL's path kept, query arrays repeated and bracketed names escaped, an empty map sending nothing, a
 * literal colon after a param, an urlencoded body, the idempotency key across an auth retry and beside path params
 * named `uuid` and `str` (a declared `Idempotency-Key` param over it), X-Request-Id, the declared `Accept` over the
 * config's, one value per header with the credential last, and the declared request media type sent. Driven
 * through the `http` registry SDK's driver on C#'s one async client; the typed call itself runs in the `requests`
 * consumer program.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Observed, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { CsError, Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, seen } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { type DrivenCSharpSdk, drivenCSharpSdk } from "./__fixtures__/driven.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { csharpCallPlans, generateCSharpSdk } from "./sdk.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

const member = (params: Readonly<Record<string, string>>, extra: Partial<Call> = {}): Call => ({
	operation: "members.get",
	params,
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
	...extra,
})
const AT = { org: "o", "user-id": "u" }
const PING: Call = { operation: "health.ping", route: { method: "GET", path: "/ping" } }
const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const ORDER: Call = {
	body: { kind: "json", value: { sku: "s" } },
	operation: "orders.create",
	route: { method: "POST", path: "/orders" },
}
const KEYED: Call = { operation: "keyed.send", route: { method: "POST", path: "/keyed" } }
const FILE: Call = { operation: "files.get", params: { name: "x" }, route: { method: "GET", path: "/files/{name}" } }
const TEXT: Call = { operation: "text.get", route: { method: "GET", path: "/text" } }

const FOUND: Reply = { json: { id: "u", name: "n" }, status: 200 }
const DATA = { data: { id: "u", name: "n" }, kind: "data", status: 200 } satisfies Observed
const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 } satisfies Observed
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex")

/** `search.run` with an empty `q` and the map `tags`. */
const search = (tags: Readonly<Record<string, string>>): Call => ({
	operation: "search.run",
	route: { method: "GET", path: "/search" },
	search: { q: "", tags },
})

/** Each hop's X-Request-Id. */
const ids = (hops: readonly RecordedHop[]) => hops.map((h) => h.headers["x-request-id"])

/** The `http` registry SDK with the driver aimed at it, which must build. */
function driven(): DrivenCSharpSdk {
	const sdk = drivenCSharpSdk("http")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

type Options = {
	readonly base?: (url: string) => string
	readonly script?: Script
	readonly setup?: Setup
}

/** `calls` against a server answering `replies`, aimed at `base(server.url)`: the run, its hops, raw header lines and bodies. */
function drive(replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const origins = { alt: server.alt, url: (options.base ?? ((url: string) => url))(server.url) }
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, origins, { script: options.script })
		return { bodies: [...server.bodies], hops: [...server.hops], raw: [...server.rawHeaders], run }
	})
}

/** A C# error as the trace records it: no inner, not canceled, the method's own throw unless given, any display. */
const plain = (entry: Partial<CsError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})

/** The trace of a `user-id` value refused as a path segment (phase b's `Path.cs` text). */
const refused = (value: string) =>
	plain({
		chain: ["PathParamException", "HoneyException"],
		text: `path param user-id: "${value}" is not a path segment`,
		type: "PathParamException",
	})

describe("the call plan: path params in path order, user-id taken as userId", () => {
	/* port: python http.test.ts:99 */
	it("plans members.get's path params in path order and its query by spec name, and emits its signature", () => {
		const document = FIXTURES.http.document()
		const plan = csharpCallPlans(document)["members.get"]
		const lines = (generateCSharpSdk(document).files["Client.cs"] ?? "").split("\n")
		const signature =
			"    public Task<MembersGetResponse> GetAsync(string org, string userId, IReadOnlyList<string>? ids = null, string? maybe = null, long? pageSize = null, RequestOptions? options = null, CancellationToken cancellationToken = default) =>"
		expect({ path: plan?.path, query: plan?.query, signature: lines.includes(signature) }).toEqual({
			path: [
				{ name: "org", param: "org" },
				{ name: "user-id", param: "userId" },
			],
			query: { ids: "ids", maybe: "maybe", "page[size]": "pageSize" },
			signature: true,
		})
	})
})

describe.skipIf(!DOTNET)("path params: each value one percent-encoded segment, in path order", SLOW, () => {
	/* port: python http.test.ts:116 */
	it("sends a slash, a space, a non-ASCII char and a question mark escaped", async () => {
		const { hops, run } = await drive([FOUND], [member({ org: "a/b c", "user-id": "ü?1" })])
		expect({ hops: hops.map((h) => `${h.method} ${h.url}`), observed: run.observed }, run.stderr).toEqual({
			hops: ["GET /orgs/a%2Fb%20c/users/%C3%BC%3F1"],
			observed: [DATA],
		})
	})

	/* port: python http.test.ts:125 */
	it("refuses an empty, a dot and a dot-dot value, nothing sent; '../x' is escaped", async () => {
		const calls = ["", ".", "..", "../x"].map((value) => member({ org: "ok", "user-id": value }))
		const { hops, run } = await drive([FOUND], calls, { script: {} })
		expect(
			{ errors: run.trace?.calls.map((c) => c.error), hops: hops.map((h) => h.url), observed: run.observed },
			run.stderr,
		).toEqual({
			errors: [refused(""), refused("."), refused(".."), undefined],
			hops: ["/orgs/ok/users/..%2Fx"],
			observed: [null, null, null, DATA],
		})
	})
})

describe.skipIf(!DOTNET)("the base URL: its path is kept, a trailing slash never doubled", SLOW, () => {
	/* port: python http.test.ts:144 */
	it("prefixes every request with the base path, with or without a trailing slash", async () => {
		const user: Call = {
			operation: "users.get",
			params: { id: "a b/c" },
			route: { method: "GET", path: "/users/{id}" },
		}
		const named: Reply = { json: { id: "a b/c" }, status: 200 }
		const bare = await drive([FOUND, named], [member(AT), user], { base: (url) => `${url}/api` })
		const slashed = await drive([FOUND], [member(AT)], { base: (url) => `${url}/api/` })
		const read = ({ hops, run }: typeof bare) => ({ hops: hops.map((h) => h.url), observed: run.observed })
		expect({ bare: read(bare), slashed: read(slashed) }, bare.run.stderr + slashed.run.stderr).toEqual({
			bare: {
				hops: ["/api/orgs/o/users/u", "/api/users/a%20b%2Fc"],
				observed: [DATA, { data: { id: "a b/c" }, kind: "data", status: 200 }],
			},
			slashed: { hops: ["/api/orgs/o/users/u"], observed: [DATA] },
		})
	})
})

describe.skipIf(!DOTNET)(
	"query params: arrays repeated, bracketed names escaped, nothing set sends no query",
	SLOW,
	() => {
		/* port: python http.test.ts:170 */
		it("sends ids once per item, page[size] escaped, maybe as given, no '?' without a value", async () => {
			const calls = [
				member(AT, { search: { ids: ["a", "b"], "page[size]": 5 } }),
				member(AT, { search: { maybe: "foo" } }),
				member(AT),
			]
			const { hops, run } = await drive([FOUND, FOUND, FOUND], calls)
			expect({ hops: hops.map((h) => h.url), observed: run.observed }, run.stderr).toEqual({
				hops: ["/orgs/o/users/u?ids=a&ids=b&page%5Bsize%5D=5", "/orgs/o/users/u?maybe=foo", "/orgs/o/users/u"],
				observed: [DATA, DATA, DATA],
			})
		})

		/* port: python http.test.ts:186 */
		it("sends nothing for an empty map; an empty string stays q=", async () => {
			const { hops, run } = await drive([OK, OK], [search({}), search({ a: "1" })])
			expect({ hops: hops.map((h) => h.url), observed: run.observed }, run.stderr).toEqual({
				hops: ["/search?q=", "/search?q=&tags=%7B%22a%22%3A%221%22%7D"],
				observed: [OK_DATA, OK_DATA],
			})
		})
	},
)

describe.skipIf(!DOTNET)("a path template: a literal colon after a param stays literal", SLOW, () => {
	/* port: python http.test.ts:197 */
	it("sends ops.cancel with id 7 as POST /ops/7:cancel", async () => {
		const cancel: Call = {
			operation: "ops.cancel",
			params: { id: "7" },
			route: { method: "POST", path: "/ops/{id}:cancel" },
		}
		const { hops, run } = await drive([OK], [cancel])
		expect({ hops: hops.map((h) => `${h.method} ${h.url}`), observed: run.observed }, run.stderr).toEqual({
			hops: ["POST /ops/7:cancel"],
			observed: [OK_DATA],
		})
	})
})

describe.skipIf(!DOTNET)("request bodies: form-encoded fields, and the declared media type sent", SLOW, () => {
	/* port: python http.test.ts:213 */
	it("sends forms.submit's typed body as name=form+value, urlencoded", async () => {
		const submit: Call = {
			body: { kind: "json", value: { name: "form value" } },
			operation: "forms.submit",
			route: { method: "POST", path: "/form" },
		}
		const { bodies, hops, run } = await drive([OK], [submit])
		expect({ bodies: bodies.map(String), observed: run.observed, sent: hops.map((h) => h.body) }, run.stderr).toEqual({
			bodies: ["name=form+value"],
			observed: [OK_DATA],
			sent: [{ contentType: "application/x-www-form-urlencoded", sha256: sha256("name=form+value"), size: 15 }],
		})
	})

	/* port: python body.py:76 (the declared request media type) */
	it("sends merge.patch's JSON body under its declared application/merge-patch+json", async () => {
		const patch: Call = {
			body: { kind: "json", value: { name: "n" } },
			operation: "merge.patch",
			route: { method: "PATCH", path: "/merge" },
		}
		const { hops, run } = await drive([OK], [patch])
		expect(
			{ observed: run.observed, sent: hops.map((h) => [h.method, h.body.contentType, h.body.json]) },
			run.stderr,
		).toEqual({ observed: [OK_DATA], sent: [["PATCH", "application/merge-patch+json", { name: "n" }]] })
	})
})

describe.skipIf(!DOTNET)(
	"Idempotency-Key: an idempotent operation always sends one, stable across an auth retry",
	SLOW,
	() => {
		/* port: python http.test.ts:234 */
		it("fills path params named uuid and str and still sends a UUIDv4 key", async () => {
			const put: Call = {
				operation: "items.put",
				params: { str: "s1", uuid: "u1" },
				route: { method: "PUT", path: "/items/{uuid}/{str}" },
			}
			const { hops, run } = await drive([OK], [put])
			expect(
				{ hops: hops.map((h) => [`${h.method} ${h.url}`, h.headers["idempotency-key"]]), observed: run.observed },
				run.stderr,
			).toEqual({ hops: [["PUT /items/u1/s1", expect.stringMatching(V4)]], observed: [OK_DATA] })
		})

		/* port: python http.test.ts:247; rust http.test.ts's idempotency leg */
		it("a fresh UUIDv4, the parameter's key, a per-call header over it, the same on a retry, none on a plain op", async () => {
			const script: Script = {
				calls: [null, { idempotencyKey: "opt-k" }, { idempotencyKey: "opt-k2" }],
				onAuthExpired: { tokens: ["new"] },
			}
			const created: Reply = { json: { id: "o1" }, status: 201 }
			const calls = [ORDER, ORDER, { ...ORDER, headers: { "Idempotency-Key": "call-k" } }, ORDER, PING]
			const setup: Setup = { auth: { kind: "bearer", token: "old" } }
			const replies = [{ status: 401 }, created, created, created, created, OK]
			const { hops, run } = await drive(replies, calls, { script, setup })
			const keys = hops.map((h) => h.headers["idempotency-key"])
			const order = { data: { id: "o1" }, kind: "data", status: 201 }
			expect(
				{
					auth: hops.map((h) => h.headers.authorization),
					expired: run.trace?.authExpired,
					keys,
					observed: run.observed,
				},
				run.stderr,
			).toEqual({
				auth: ["Bearer old", "Bearer new", "Bearer new", "Bearer new", "Bearer new", "Bearer new"],
				expired: 1,
				keys: [expect.stringMatching(V4), keys[0], "opt-k", "call-k", expect.stringMatching(V4), undefined],
				observed: [order, order, order, order, OK_DATA],
			})
			expect(keys[4]).not.toBe(keys[0])
		})

		/* port: python http.headers.test.ts (the declared key); bits/19:31 */
		it("sends keyed.send's declared Idempotency-Key param (idempotencyKey2) over the generated and the parameter's key", async () => {
			const declared: Call = { ...KEYED, headers: { "Idempotency-Key": "decl" } }
			const script: Script = { calls: [null, { idempotencyKey: "opt-k" }, null] }
			const { hops, run } = await drive([OK, OK, OK], [declared, declared, KEYED], { script })
			expect({ keys: hops.map((h) => h.headers["idempotency-key"]), observed: run.observed }, run.stderr).toEqual({
				keys: ["decl", "decl", expect.stringMatching(V4)],
				observed: [OK_DATA, OK_DATA, OK_DATA],
			})
		})
	},
)

describe.skipIf(!DOTNET)(
	"X-Request-Id: a fresh UUIDv4 per request unless the config or the call sets one",
	SLOW,
	() => {
		/* port: python http.test.ts:284 */
		it("two distinct UUIDv4s then the call's own; the config's, then the call's over it; a fresh one on a retry", async () => {
			const own = (value: string): Call => ({ ...PING, headers: { "x-request-id": value } })
			const fresh = await drive([OK, OK, OK], [PING, PING, own("call-1")])
			const configured = await drive([OK, OK], [PING, own("call-2")], {
				setup: { headers: { "X-Request-Id": "cfg-1" } },
			})
			const retried = await drive([{ status: 401 }, OK], [ECHO], {
				script: { onAuthExpired: { tokens: ["new"] } },
				setup: { auth: { kind: "bearer", token: "old" } },
			})
			const [first, second] = ids(fresh.hops)
			const [sent, resent] = ids(retried.hops)
			expect(
				{
					configured: ids(configured.hops),
					fresh: ids(fresh.hops),
					observed: [fresh.run.observed, configured.run.observed, retried.run.observed],
					retried: ids(retried.hops),
				},
				fresh.run.stderr + configured.run.stderr + retried.run.stderr,
			).toEqual({
				configured: ["cfg-1", "call-2"],
				fresh: [expect.stringMatching(V4), expect.stringMatching(V4), "call-1"],
				observed: [[OK_DATA, OK_DATA, OK_DATA], [OK_DATA, OK_DATA], [OK_DATA]],
				retried: [expect.stringMatching(V4), expect.stringMatching(V4)],
			})
			expect([first === second, sent === resent]).toEqual([false, false])
		})
	},
)

describe.skipIf(!DOTNET)("headers: the layers in order, one value per name, the credential last", SLOW, () => {
	/* port: python http.test.ts:318 */
	it("sends the declared Accept over the config's, a per-call Accept over both, and text/plain for a text answer", async () => {
		const setup: Setup = { headers: { Accept: "application/json" } }
		const file: Reply = { bytes: 4, headers: { "content-type": "application/octet-stream" }, status: 200 }
		const text: Reply = { headers: { "content-type": "text/plain" }, status: 200, text: "hi" }
		const calls = [FILE, { ...FILE, headers: { Accept: "*/*" } }, TEXT]
		const { hops, run } = await drive([file, file, text], calls, { setup })
		const got = { kind: "bytes", sha256: sha256(Buffer.from([0, 1, 2, 3])), size: 4, status: 200 }
		expect({ accept: hops.map((h) => h.headers.accept), observed: run.observed }, run.stderr).toEqual({
			accept: ["application/octet-stream", "*/*", "text/plain"],
			observed: [got, got, { data: "hi", kind: "data", status: 200 }],
		})
	})

	/* port: python http.test.ts:333; rust bca1100ff2 */
	it("sends one authorization and one x-both: the call's x-both over the config's, the bearer over both", async () => {
		const setup: Setup = {
			auth: { kind: "bearer", token: "tok" },
			headers: { authorization: "Bearer cfg", "x-both": "1" },
		}
		const calls: Call[] = [
			{ ...ECHO, headers: { "X-Both": "2" } },
			{ ...ECHO, headers: { Authorization: "Bearer call" } },
		]
		const { hops, raw, run } = await drive([OK, OK], calls, { setup })
		/* req.headers keeps one of a repeated authorization: the raw lines show a duplicate credential */
		const lines = raw.map((pairs) =>
			["authorization", "x-both"].map((n) => pairs.filter(([name]) => name === n).length),
		)
		expect(
			{ lines, observed: run.observed, sent: hops.map((h) => [h.headers.authorization, h.headers["x-both"]]) },
			run.stderr,
		).toEqual({
			lines: [
				[1, 1],
				[1, 1],
			],
			observed: [OK_DATA, OK_DATA],
			sent: [
				["Bearer tok", "2"],
				["Bearer tok", "1"],
			],
		})
	})
})

/** The `requests` program: members.get with every optional param by name, then bare. */
const REQUESTS = `using var c = Client();
var m = await c.Members.GetAsync("o", "u", ids: ["a", "b"], maybe: "m", pageSize: 3);
Note($"{m.Id} {m.Name}");
m = await c.Members.GetAsync("o", "u");
Note($"{m.Id} {m.Name}");`

describe.skipIf(!DOTNET)("the requests program: path params by position, query params by name", SLOW, () => {
	/* port: python http.test.ts:446 */
	it("takes org then userId positionally and ids, maybe, pageSize by name, sending each set one", async () => {
		const { hops, run } = await served([FOUND, FOUND], async (server) => {
			const ran = await consume("http", "requests", { base: server.url, body: REQUESTS })
			return { hops: [...server.hops], run: ran }
		})
		expect({ ...seen(run), wire: hops.map((h) => `${h.method} ${h.url}`) }, run.stderr).toEqual({
			out: ["u n", "u n"],
			ran: true,
			wire: ["GET /orgs/o/users/u?ids=a&ids=b&maybe=m&page%5Bsize%5D=3", "GET /orgs/o/users/u"],
		})
	})
})
