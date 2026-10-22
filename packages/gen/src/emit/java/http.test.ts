/**
 * The Java SDK's request build, executed (bit 16 phase c1; the port of C#'s `http.test.ts`): path params escaped as one
 * segment each in path order (`user-id` taken as `userId`) and refused when no segment can hold them, the base URL's
 * path kept, query arrays repeated and bracketed names escaped, an empty map sending nothing, a literal colon after a
 * param, a urlencoded form body, and a JSON body sent as `application/json`. Driven through the `http` registry SDK's
 * driver on the one client. The headers, the idempotency key and X-Request-Id are http.headers.test.ts's legs; the
 * C#-only legs (the requests program and merge.patch) are dropped.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Observed, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { JavaError, Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { javaCallPlans } from "./sdk.ts"

/** Whether Java is here: a missing toolchain fails where it is required and skips these legs elsewhere (java-env). */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

const member = (params: Readonly<Record<string, string>>, extra: Partial<Call> = {}): Call => ({
	operation: "members.get",
	params,
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
	...extra,
})
const AT = { org: "o", "user-id": "u" }
const ORDER: Call = {
	body: { kind: "json", value: { sku: "s" } },
	operation: "orders.create",
	route: { method: "POST", path: "/orders" },
}
const FORM: Call = {
	body: { kind: "json", value: { name: "form value" } },
	operation: "forms.submit",
	route: { method: "POST", path: "/form" },
}

const FOUND: Reply = { json: { id: "u", name: "n" }, status: 200 }
const DATA = { data: { id: "u", name: "n" }, kind: "data", status: 200 } satisfies Observed
const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 } satisfies Observed
const CREATED: Reply = { json: { id: "o1" }, status: 201 }

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex")

/** `search.run` with an empty `q` and the map `tags`. */
const search = (tags: Readonly<Record<string, string>>): Call => ({
	operation: "search.run",
	route: { method: "GET", path: "/search" },
	search: { q: "", tags },
})

/** The `http` registry SDK with the driver aimed at it, which must build (javac's diagnostics say why when not). */
function driven(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("http")
	expect(sdk.javac.diagnostics, sdk.javac.diagnostics.join("\n")).toEqual([])
	return sdk
}

type Options = {
	readonly base?: (url: string) => string
	readonly script?: Script
	readonly setup?: Setup
}

/** `calls` against a server answering `replies`, aimed at `base(server.url)`: the run, its hops and raw bodies. */
function drive(replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const origins = { alt: server.alt, url: (options.base ?? ((url: string) => url))(server.url) }
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, origins, { script: options.script })
		return { bodies: [...server.bodies], hops: [...server.hops], run }
	})
}

/** A Java error as the trace records it: no inner, not canceled, the method's own throw, any display. */
const plain = (entry: Partial<JavaError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})

/** The trace of a `user-id` value refused as a path segment (the C# text, kept for the Java SDK). */
const refused = (value: string) =>
	plain({
		chain: ["PathParamException", "HoneyException"],
		text: `path param user-id: "${value}" is not a path segment`,
		type: "PathParamException",
	})

describe("the call plan: path params in path order, user-id taken as userId", () => {
	/* port: csharp http.test.ts (the plan leg; the emitted signature is the Java SDK's own, not pinned here) */
	it("plans members.get's path params in path order and its query by spec name", () => {
		const plan = javaCallPlans(FIXTURES.http.document())["members.get"]
		expect({ path: plan?.path, query: plan?.query }).toEqual({
			path: [
				{ name: "org", param: "org" },
				{ name: "user-id", param: "userId" },
			],
			query: { ids: "ids", maybe: "maybe", "page[size]": "pageSize" },
		})
	})
})

describe.skipIf(!JAVA)("path params: each value one percent-encoded segment, in path order", SLOW, () => {
	/* port: csharp http.test.ts (a slash, a space, a non-ASCII char and a question mark) */
	it("sends a slash, a space, a non-ASCII char and a question mark escaped", async () => {
		const { hops, run } = await drive([FOUND], [member({ org: "a/b c", "user-id": "ü?1" })])
		expect({ hops: hops.map((h) => `${h.method} ${h.url}`), observed: run.observed }, run.stderr).toEqual({
			hops: ["GET /orgs/a%2Fb%20c/users/%C3%BC%3F1"],
			observed: [DATA],
		})
	})

	/* port: csharp http.test.ts (an empty, a dot and a dot-dot value refused; '../x' escaped) */
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

describe.skipIf(!JAVA)("the base URL: its path is kept, a trailing slash never doubled", SLOW, () => {
	/* port: csharp http.test.ts (the base path, with or without a trailing slash) */
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

describe.skipIf(!JAVA)(
	"query params: arrays repeated, bracketed names escaped, nothing set sends no query",
	SLOW,
	() => {
		/* port: csharp http.test.ts (ids once per item, page[size] escaped, no '?' without a value) */
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

		/* port: csharp http.test.ts (an empty map sends nothing; an empty string stays q=) */
		it("sends nothing for an empty map; an empty string stays q=", async () => {
			const { hops, run } = await drive([OK, OK], [search({}), search({ a: "1" })])
			expect({ hops: hops.map((h) => h.url), observed: run.observed }, run.stderr).toEqual({
				hops: ["/search?q=", "/search?q=&tags=%7B%22a%22%3A%221%22%7D"],
				observed: [OK_DATA, OK_DATA],
			})
		})
	},
)

describe.skipIf(!JAVA)("a path template: a literal colon after a param stays literal", SLOW, () => {
	/* port: csharp http.test.ts (ops.cancel with id 7 as POST /ops/7:cancel) */
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

/** A hop's request body as the grid records it: its media type, its size and digest, and its JSON when it has one. */
const sentBody = (hop: RecordedHop) => ({
	contentType: hop.body.contentType,
	json: hop.body.json,
	sha256: hop.body.sha256,
	size: hop.body.size,
})

describe.skipIf(!JAVA)("request bodies: a JSON body as JSON, form fields urlencoded", SLOW, () => {
	/* port: csharp http.test.ts (orders.create's typed body sent as application/json) */
	it("sends orders.create's JSON body as application/json, answered 201 with its id", async () => {
		const { hops, run } = await drive([CREATED], [ORDER])
		expect(
			{ observed: run.observed, sent: hops.map((h) => [h.method, h.body.contentType, h.body.json]) },
			run.stderr,
		).toEqual({
			observed: [{ data: { id: "o1" }, kind: "data", status: 201 }],
			sent: [["POST", "application/json", { sku: "s" }]],
		})
	})

	/* port: csharp http.test.ts (forms.submit's typed body sent as name=form+value, urlencoded) */
	it("sends forms.submit's typed body as name=form+value, urlencoded", async () => {
		const { bodies, hops, run } = await drive([OK], [FORM])
		expect({ bodies: bodies.map(String), observed: run.observed, sent: hops.map(sentBody) }, run.stderr).toEqual({
			bodies: ["name=form+value"],
			observed: [OK_DATA],
			sent: [
				{
					contentType: "application/x-www-form-urlencoded",
					json: undefined,
					sha256: sha256("name=form+value"),
					size: 15,
				},
			],
		})
	})

	/* port: csharp http.test.ts (a text body is the structured string, sent as text/plain by the declared media type) */
	it("sends notes.create's string value as its raw text/plain body, answered as text", async () => {
		const note: Call = {
			body: { kind: "json", value: "hello" },
			operation: "notes.create",
			route: { method: "POST", path: "/notes" },
		}
		const text: Reply = { headers: { "content-type": "text/plain" }, status: 200, text: "ok" }
		const { bodies, hops, run } = await drive([text], [note])
		expect(
			{
				bodies: bodies.map(String),
				observed: run.observed,
				sent: hops.map((h) => ({ contentType: h.headers["content-type"], sha256: h.body.sha256, size: h.body.size })),
			},
			run.stderr,
		).toEqual({
			bodies: ["hello"],
			observed: [{ data: "ok", kind: "data", status: 200 }],
			sent: [{ contentType: expect.stringMatching(/^text\/plain/), sha256: sha256("hello"), size: 5 }],
		})
	})
})
