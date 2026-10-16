/**
 * The Python SDK's request build, executed (contract 29 §5.1; Rust's `http.test.ts` analog): path params escaped
 * as one segment each in path order (`user-id` taken as `user_id`) and refused when no segment can hold them, the
 * base URL's path kept, query arrays repeated and bracketed names escaped, an empty map sending nothing, a literal
 * colon after a param, X-Request-Id, an urlencoded body, the idempotency key across an auth retry and beside path
 * params named `uuid` and `str`, the header layers (a declared `Accept` over the config's), and one value per
 * header with the credential last. Driven through the `http` registry SDK's driver on `AsyncSDK` and `SDK` with
 * one expectation (the G17 drift check); what only a program can hand the SDK (`FilePart`) runs in the
 * `requests` consumer program, on both clients.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Observed, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { PythonError, Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, once, seen } from "./__fixtures__/consumer.ts"
import { type DrivenPythonSdk, drivenPythonSdk } from "./__fixtures__/driven.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { withPython } from "./__fixtures__/python-env.ts"
import { generatePythonSdk, pythonCallPlans } from "./sdk.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }
const CLIENTS = ["async", "sync"] as const
type Client = (typeof CLIENTS)[number]

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
const FILE: Call = { operation: "files.get", params: { name: "x" }, route: { method: "GET", path: "/files/{name}" } }

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

/** The `http` registry SDK with the driver aimed at it, which must import. */
function driven(): DrivenPythonSdk {
	const sdk = drivenPythonSdk("http")
	expect(sdk.imported, sdk.stderr).toBe(true)
	return sdk
}

type Options = {
	readonly base?: (url: string) => string
	readonly script?: Script
	readonly setup?: Setup
}

/** `calls` run on `client` against a server answering `replies`, aimed at `base(server.url)`: the run, its hops, their raw header lines and bodies. */
function drive(client: Client, replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const origins = { alt: server.alt, url: (options.base ?? ((url: string) => url))(server.url) }
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, origins, { client, script: options.script })
		return { bodies: [...server.bodies], hops: [...server.hops], raw: [...server.rawHeaders], run }
	})
}

/** A Python error as the trace records it: no cause and the method's own raise unless given, any repr. */
const plain = (entry: Partial<PythonError>) => ({ cause: null, repr: expect.any(String), via: "return", ...entry })

/** The trace of a `user-id` value refused as a path segment (`path.py`). */
const refused = plain({
	chain: ["PathParamError", "HoneyError"],
	text: "path parameter 'user-id' is missing, empty, '.' or '..'",
	type: "PathParamError",
})

describe("the call plan: path params in path order, user-id taken as user_id", () => {
	// v0: 5770bf39ca
	it("names members.get's path params in path order, and both clients take org then user_id before the keywords", () => {
		const document = FIXTURES.http.document()
		const lines = (generatePythonSdk(document).files["src/honey_sdk/client.py"] ?? "").split("\n")
		const keywords =
			"ids: list[str] | None = None, maybe: str | None = None, page_size: int | None = None, options: RequestOptions | None = None"
		const signature = (prefix: string) =>
			`    ${prefix}def get(self, org: str, user_id: str, *, ${keywords}) -> MembersGetResponse:`
		expect({
			pathParams: pythonCallPlans(document)["members.get"]?.pathParams,
			signatures: [signature(""), signature("async ")].map((line) => lines.includes(line)),
		}).toEqual({ pathParams: ["org", "user-id"], signatures: [true, true] })
	})
})

describe.skipIf(!PY)("path params: each value one percent-encoded segment, in path order", SLOW, () => {
	// v0: 3679186414
	// v0: 5770bf39ca
	it.each(CLIENTS)("%s: sends a slash, a space, a non-ASCII char and a question mark escaped", async (client) => {
		const { hops, run } = await drive(client, [FOUND], [member({ org: "a/b c", "user-id": "ü?1" })])
		expect({ hops: hops.map((h) => `${h.method} ${h.url}`), observed: run.observed }, run.stderr).toEqual({
			hops: ["GET /orgs/a%2Fb%20c/users/%C3%BC%3F1"],
			observed: [DATA],
		})
	})

	// v0: 0f61977223
	it.each(CLIENTS)(
		"%s: refuses an empty, a dot and a dot-dot value, nothing sent; '../x' is escaped",
		async (client) => {
			const calls = ["", ".", "..", "../x"].map((value) => member({ org: "ok", "user-id": value }))
			const { hops, run } = await drive(client, [FOUND], calls, { script: {} })
			expect(
				{ errors: run.trace?.calls.map((c) => c.error), hops: hops.map((h) => h.url), observed: run.observed },
				run.stderr,
			).toEqual({
				errors: [refused, refused, refused, undefined],
				hops: ["/orgs/ok/users/..%2Fx"],
				observed: [null, null, null, DATA],
			})
		},
	)
})

describe.skipIf(!PY)("the base URL: its path is kept, a trailing slash never doubled", SLOW, () => {
	// v0: 31aba57f46
	it.each(CLIENTS)(
		"%s: prefixes every request with the base path, with or without a trailing slash",
		async (client) => {
			const user: Call = {
				operation: "users.get",
				params: { id: "a b/c" },
				route: { method: "GET", path: "/users/{id}" },
			}
			const named: Reply = { json: { id: "a b/c" }, status: 200 }
			const bare = await drive(client, [FOUND, named], [member(AT), user], { base: (url) => `${url}/api` })
			const slashed = await drive(client, [FOUND], [member(AT)], { base: (url) => `${url}/api/` })
			const read = ({ hops, run }: typeof bare) => ({ hops: hops.map((h) => h.url), observed: run.observed })
			expect({ bare: read(bare), slashed: read(slashed) }, bare.run.stderr + slashed.run.stderr).toEqual({
				bare: {
					hops: ["/api/orgs/o/users/u", "/api/users/a%20b%2Fc"],
					observed: [DATA, { data: { id: "a b/c" }, kind: "data", status: 200 }],
				},
				slashed: { hops: ["/api/orgs/o/users/u"], observed: [DATA] },
			})
		},
	)
})

describe.skipIf(!PY)("query params: arrays repeated, bracketed names escaped, nothing set sends no query", SLOW, () => {
	/* v0 drove an SSE op's optional `topic`; a unary op pins the same rule */
	// v0: 34746d3623
	it.each(CLIENTS)(
		"%s: sends ids once per item, page[size] escaped, maybe as given, no '?' without a value",
		async (client) => {
			const calls = [
				member(AT, { search: { ids: ["a", "b"], "page[size]": 5 } }),
				member(AT, { search: { maybe: "foo" } }),
				member(AT),
			]
			const { hops, run } = await drive(client, [FOUND, FOUND, FOUND], calls)
			expect({ hops: hops.map((h) => h.url), observed: run.observed }, run.stderr).toEqual({
				hops: ["/orgs/o/users/u?ids=a&ids=b&page%5Bsize%5D=5", "/orgs/o/users/u?maybe=foo", "/orgs/o/users/u"],
				observed: [DATA, DATA, DATA],
			})
		},
	)

	it.each(CLIENTS)("%s: sends nothing for an empty map (Rust's Fc6); an empty string stays q=", async (client) => {
		const { hops, run } = await drive(client, [OK, OK], [search({}), search({ a: "1" })])
		expect({ hops: hops.map((h) => h.url), observed: run.observed }, run.stderr).toEqual({
			hops: ["/search?q=", "/search?q=&tags=%7B%22a%22%3A%221%22%7D"],
			observed: [OK_DATA, OK_DATA],
		})
	})
})

describe.skipIf(!PY)("a path template: a literal colon after a param stays literal", SLOW, () => {
	// v0: 3caa440441
	it.each(CLIENTS)("%s: sends ops.cancel with id 7 as POST /ops/7:cancel", async (client) => {
		const cancel: Call = {
			operation: "ops.cancel",
			params: { id: "7" },
			route: { method: "POST", path: "/ops/{id}:cancel" },
		}
		const { hops, run } = await drive(client, [OK], [cancel])
		expect({ hops: hops.map((h) => `${h.method} ${h.url}`), observed: run.observed }, run.stderr).toEqual({
			hops: ["POST /ops/7:cancel"],
			observed: [OK_DATA],
		})
	})
})

describe.skipIf(!PY)("an urlencoded body: its fields form-encoded under their content type", SLOW, () => {
	// v0: 2e47a1f63f
	it.each(CLIENTS)("%s: sends forms.submit's typed body as name=form+value, urlencoded", async (client) => {
		const submit: Call = {
			body: { kind: "json", value: { name: "form value" } },
			operation: "forms.submit",
			route: { method: "POST", path: "/form" },
		}
		const { bodies, hops, run } = await drive(client, [OK], [submit])
		expect({ bodies: bodies.map(String), observed: run.observed, sent: hops.map((h) => h.body) }, run.stderr).toEqual({
			bodies: ["name=form+value"],
			observed: [OK_DATA],
			sent: [{ contentType: "application/x-www-form-urlencoded", sha256: sha256("name=form+value"), size: 15 }],
		})
	})
})

describe.skipIf(!PY)(
	"Idempotency-Key: an idempotent operation always sends one, stable across an auth retry",
	SLOW,
	() => {
		/* S3: v0's generated body called uuid.uuid4() beside params named uuid and str (file 26 P7) */
		// v0: acbcf0ef46
		it.each(CLIENTS)("%s: fills path params named uuid and str and still sends a UUIDv4 key", async (client) => {
			const put: Call = {
				operation: "items.put",
				params: { str: "s1", uuid: "u1" },
				route: { method: "PUT", path: "/items/{uuid}/{str}" },
			}
			const { hops, run } = await drive(client, [OK], [put])
			expect(
				{ hops: hops.map((h) => [`${h.method} ${h.url}`, h.headers["idempotency-key"]]), observed: run.observed },
				run.stderr,
			).toEqual({ hops: [["PUT /items/u1/s1", expect.stringMatching(V4)]], observed: [OK_DATA] })
		})

		it.each(CLIENTS)(
			"%s: a fresh UUIDv4, the keyword's key, a per-call header over it, the same on a retry, none on a plain op",
			async (client) => {
				const script: Script = {
					calls: [null, { idempotencyKey: "opt-k" }, { idempotencyKey: "opt-k2" }],
					onAuthExpired: { tokens: ["new"] },
				}
				const created: Reply = { json: { id: "o1" }, status: 201 }
				const calls = [ORDER, ORDER, { ...ORDER, headers: { "Idempotency-Key": "call-k" } }, ORDER, PING]
				const setup: Setup = { auth: { kind: "bearer", token: "old" } }
				const replies = [{ status: 401 }, created, created, created, created, OK]
				const { hops, run } = await drive(client, replies, calls, { script, setup })
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
			},
		)
	},
)

describe.skipIf(!PY)("X-Request-Id: a fresh UUIDv4 per request unless the config or the call sets one", SLOW, () => {
	/* v0 grepped _build_headers for a uuid4 setdefault; the port pins the wire */
	// v0: 4e4b276cb8
	it.each(CLIENTS)(
		"%s: two distinct UUIDv4s then the call's own; the config's, then the call's over it; a fresh one on a retry",
		async (client) => {
			const own = (value: string): Call => ({ ...PING, headers: { "x-request-id": value } })
			const fresh = await drive(client, [OK, OK, OK], [PING, PING, own("call-1")])
			const configured = await drive(client, [OK, OK], [PING, own("call-2")], {
				setup: { headers: { "X-Request-Id": "cfg-1" } },
			})
			const retried = await drive(client, [{ status: 401 }, OK], [ECHO], {
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
		},
	)
})

describe.skipIf(!PY)("headers: the layers in Rust's order, one value per name, the credential last", SLOW, () => {
	it.each(CLIENTS)(
		"%s: sends the declared Accept over the config's, and a per-call Accept over both",
		async (client) => {
			const setup: Setup = { headers: { Accept: "application/json" } }
			const file: Reply = { bytes: 4, headers: { "content-type": "application/octet-stream" }, status: 200 }
			const calls = [FILE, { ...FILE, headers: { Accept: "*/*" } }]
			const { hops, run } = await drive(client, [file, file], calls, { setup })
			const got = { kind: "bytes", sha256: sha256(Buffer.from([0, 1, 2, 3])), size: 4, status: 200 }
			expect({ accept: hops.map((h) => h.headers.accept), observed: run.observed }, run.stderr).toEqual({
				accept: ["application/octet-stream", "*/*"],
				observed: [got, got],
			})
		},
	)

	it.each(CLIENTS)(
		"%s: sends one authorization and one x-both: the call's x-both over the config's, the bearer over both",
		async (client) => {
			const setup: Setup = {
				auth: { kind: "bearer", token: "tok" },
				headers: { authorization: "Bearer cfg", "x-both": "1" },
			}
			const calls: Call[] = [
				{ ...ECHO, headers: { "X-Both": "2" } },
				{ ...ECHO, headers: { Authorization: "Bearer call" } },
			]
			const { hops, raw, run } = await drive(client, [OK, OK], calls, { setup })
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
		},
	)
})

/** The `requests` program's sections, each on `SDK` then `AsyncSDK`, in the order SENT lists their requests. */
const REQUESTS: Readonly<Record<string, string>> = {
	typed: `with client() as c:
    m = c.members.get("o", "u", ids=["a", "b"], maybe="m", page_size=3)
    note(f"{m['id']} {m['name']}")
    m = c.members.get("o", "u")
    note(f"{m['id']} {m['name']}")
async with aclient() as ac:
    m = await ac.members.get("o", "u", ids=["a", "b"], maybe="m", page_size=3)
    note(f"{m['id']} {m['name']}")
    m = await ac.members.get("o", "u")
    note(f"{m['id']} {m['name']}")`,
	multipart: `def upload() -> object:
    return {"file": sdk.FilePart("a.txt", b"hello", "text/plain"), "name": "multipart-value", "tags": ["a", "b"]}
with client() as c:
    note(f"upload {c.files.upload(upload())['ok']}")
async with aclient() as ac:
    body = upload()
    call = ac.files.upload(body)
    del body
    note(f"upload {(await call)['ok']}")`,
}

/** Every request the `requests` program sends, in order: its section and the reply it gets. */
const SENT: readonly (readonly [section: string, reply: Reply])[] = [
	["typed", FOUND],
	["typed", FOUND],
	["typed", FOUND],
	["typed", FOUND],
	["multipart", OK],
	["multipart", OK],
]

const indent = (text: string) =>
	text
		.split("\n")
		.map((line) => (line === "" ? "" : `    ${line}`))
		.join("\n")

/** The sections as one body, each in a try that notes what it raised, so one failure stays its own. */
const body = (sections: Readonly<Record<string, string>>) =>
	Object.entries(sections)
		.map(
			([name, text]) =>
				`section(${JSON.stringify(name)})\ntry:\n${indent(text)}\nexcept Exception as error:\n    note(f"raised {type(error).__name__}: {error}")`,
		)
		.join("\n")

/** The `requests` program run once against the recording server, with every hop and its raw body. */
const requests = once(() =>
	served(
		SENT.map(([, reply]) => reply),
		async (server) => {
			const run = await consume("http", "requests", { base: server.url, body: body(REQUESTS) })
			return { bodies: [...server.bodies], hops: [...server.hops], run }
		},
	),
)

/** Section `name` of the `requests` program: its notes, and the hops and raw bodies its calls sent. */
async function section(name: string) {
	const { bodies, hops, run } = await requests()
	const own = (_: unknown, i: number) => SENT[i]?.[0] === name
	return { bodies: bodies.filter(own), hops: hops.filter(own), observed: seen(run, name), stderr: run.stderr }
}

/** An upload's parts as a server's form parser reads them: the file part, the name and tags parts. */
async function upload(sent: Buffer, hop: RecordedHop | undefined) {
	const headers = { "content-type": hop?.body.contentType ?? "" }
	const form = await new Response(new Uint8Array(sent), { headers }).formData()
	const file = form.get("file")
	return {
		file: file instanceof File ? { name: file.name, text: await file.text(), type: file.type } : file,
		name: form.getAll("name"),
		tags: form.getAll("tags"),
	}
}

describe.skipIf(!PY)("the requests program: keyword query params and a FilePart body on both clients", SLOW, () => {
	it("takes org then user_id positionally and ids, maybe, page_size as keywords, sending each set one", async () => {
		const { hops, observed, stderr } = await section("typed")
		const set = "GET /orgs/o/users/u?ids=a&ids=b&maybe=m&page%5Bsize%5D=3"
		expect({ ...observed, wire: hops.map((h) => `${h.method} ${h.url}`) }, stderr).toEqual({
			out: ["u n", "u n", "u n", "u n"],
			ran: true,
			wire: [set, "GET /orgs/o/users/u", set, "GET /orgs/o/users/u"],
		})
	})

	it("sends a FilePart as a file part beside the text parts, the body dropped before the await on AsyncSDK", async () => {
		const { bodies, hops, observed, stderr } = await section("multipart")
		expect({ ...observed, wire: hops.map((h) => `${h.method} ${h.url}`) }, stderr).toEqual({
			out: ["upload True", "upload True"],
			ran: true,
			wire: ["POST /upload", "POST /upload"],
		})
		expect(hops.map((h) => h.body.contentType)).toEqual(
			hops.map(() => expect.stringMatching(/^multipart\/form-data; boundary=/)),
		)
		const sent = {
			file: { name: "a.txt", text: "hello", type: "text/plain" },
			name: ["multipart-value"],
			tags: ["a", "b"],
		}
		expect(await Promise.all(bodies.map((b, i) => upload(b, hops[i])))).toEqual([sent, sent])
	})
})
