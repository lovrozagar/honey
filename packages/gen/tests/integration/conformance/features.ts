/**
 * The conformance grid's data: the targets and every row with its scenarios, plain JSON so a
 * non-TS runner reads a cell from stdin. Each row is one feature of blueprint/dx/conformance.md;
 * the shared rows run on every target. Bits 12–18 add their CLI-only and MCP-only rows here and
 * nowhere else. Every expectation is what the reference app (core `conformance/app.ts`) answers.
 */
import type { Call, Expected, Feature, Hop, Scenario } from "./matrix.ts"

export const TARGETS = ["ts", "go", "rust", "python", "csharp", "java", "cli", "mcp"] as const

const ANY = { $any: true } as const
const ABSENT = { $absent: true } as const
const JSON_TYPE = "application/json"
const OCTET = "application/octet-stream"
/** sha256 of the bytes `i & 0xff` for i < 256 and for i < 65 536 */
const SHA_256B = "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880"
const SHA_64K = "7daca2095d0438260fa849183dfc67faa459fdf4936e1bc91eec6b281b27e4c2"

/** A call to `operation` at `method path`, with the rest of `more`. */
const call = (operation: string, method: string, path: string, more: Partial<Call> = {}): Call => ({
	operation,
	route: { method, path },
	...more,
})

/** An expected hop on the primary origin, with the rest of `more`. */
const hop = (method: string, url: string, more: Partial<Hop> = {}): Hop => ({ method, origin: "primary", url, ...more })

/** A data answer. */
const data = (value: Expected, status = 200) => ({ data: value, kind: "data", status })

/** An error answer by status and key. */
const error = (status: number, errorKey: string): Expected => ({ errorKey, kind: "error", status })

/** Events `from`..`to` named `event`, data `{ n }` and id `n`: the reference log's (`message`) or the ticks. */
const events = (from: number, to: number, event = "message"): Expected[] =>
	Array.from({ length: to - from + 1 }, (_, i) => ({ data: { n: from + i }, event, id: String(from + i) }))

const getItem = (id: string, more: Partial<Call> = {}) =>
	call("items.get", "GET", "/v1/items/:id", { params: { id }, ...more })
const echo = (more: Partial<Call> = {}) => call("echo.get", "GET", "/v1/echo", more)
const echoed = data({ method: "GET", requestId: ANY })

const verbs: Scenario[] = [
	{
		calls: [
			call("items.update", "PUT", "/v1/items/:id", {
				body: { kind: "json", value: { n: 2, name: "n" } },
				headers: { "x-trace": "t1" },
				params: { id: "a b/ü" },
				search: { flag: true, limit: 3, q: "hé&llo", ratio: 0.5, tags: ["x", "y z"] },
			}),
		],
		expect: [data({ id: "a b/ü", n: 2, name: "n" })],
		id: "reference-request",
		setup: { auth: { kind: "bearer", token: "tok" } },
		wire: [
			hop("PUT", "/v1/items/a%20b%2F%C3%BC?flag=true&limit=3&q=h%C3%A9%26llo&ratio=0.5&tags=x&tags=y+z", {
				body: { contentType: JSON_TYPE, json: { n: 2, name: "n" } },
				headers: { authorization: "Bearer tok", "x-trace": "t1" },
			}),
		],
	},
	{
		calls: [getItem("i1")],
		expect: [data({ id: "i1", name: "item i1" })],
		id: "get",
		wire: [hop("GET", "/v1/items/i1")],
	},
	{
		calls: [call("items.list", "GET", "/v1/items", { search: { limit: 1, q: "e" } })],
		expect: [data([{ id: "a1", name: "apple" }])],
		id: "list-query",
		wire: [hop("GET", "/v1/items?limit=1&q=e")],
	},
	{
		calls: [call("items.create", "POST", "/v1/items", { body: { kind: "json", value: { n: 1, name: "widget" } } })],
		expect: [data({ id: "item-new", name: "widget" }, 201)],
		id: "post",
		wire: [hop("POST", "/v1/items", { body: { contentType: JSON_TYPE, json: { n: 1, name: "widget" } } })],
	},
	{
		calls: [
			call("items.patch", "PATCH", "/v1/items/:id", {
				body: { kind: "json", value: { name: "renamed" } },
				params: { id: "i1" },
			}),
		],
		expect: [data({ id: "i1", name: "renamed" })],
		id: "patch",
		wire: [hop("PATCH", "/v1/items/i1", { body: { contentType: JSON_TYPE, json: { name: "renamed" } } })],
	},
	{
		calls: [call("items.delete", "DELETE", "/v1/items/:id", { params: { id: "i1" } })],
		expect: [data(null, 204)],
		id: "delete",
		wire: [hop("DELETE", "/v1/items/i1")],
	},
]

const jsonStatus: Scenario[] = [
	{
		calls: [call("items.create", "POST", "/v1/items", { body: { kind: "json", value: { name: "gadget" } } })],
		expect: [data({ id: "item-new", name: "gadget" }, 201)],
		id: "created-201",
	},
	{ calls: [getItem("i2")], expect: [data({ id: "i2", name: "item i2" })], id: "ok-200" },
	{
		calls: [call("items.delete", "DELETE", "/v1/items/:id", { params: { id: "i2" } })],
		expect: [data(null, 204)],
		id: "no-content-204",
	},
]

const typedErrors: Scenario[] = [
	{ calls: [getItem("missing")], expect: [error(404, "item_not_found")], id: "declared-404" },
	{
		calls: [call("items.create", "POST", "/v1/items", { body: { kind: "json", value: { name: "ab" } } })],
		expect: [error(400, "validation_failed")],
		id: "validation-400",
	},
	{
		calls: [call("items.create", "POST", "/v1/items", { body: { kind: "json", value: { name: "taken" } } })],
		expect: [error(409, "item_exists")],
		id: "conflict-409",
	},
]

const reconnect: Scenario[] = [
	{
		calls: [call("events.stream", "GET", "/v1/resume/events", { lastEventId: "2", take: 3 })],
		expect: [{ events: events(3, 5), kind: "events" }],
		id: "sse-last-event-id",
		wire: [hop("GET", "/v1/resume/events", { headers: { "last-event-id": "2" } })],
	},
	{
		calls: [call("events.socket", "GET", "/v1/resume/events/ws", { reconnectToken: "3", take: 2 })],
		expect: [{ frames: [4, 5].map((n) => ({ data: { n }, id: n })), kind: "frames" }],
		id: "ws-reconnect-token",
		wire: [hop("GET", "/v1/resume/events/ws?reconnect_token=3")],
	},
	{
		calls: [call("events.stream", "GET", "/v1/resume/events", { take: 5 })],
		expect: [{ events: events(1, 5), kind: "events" }],
		id: "sse-from-start",
		wire: [hop("GET", "/v1/resume/events", { headers: { "last-event-id": ABSENT } })],
	},
]

const overrides: Scenario[] = [
	{
		calls: [call("timing.slow", "GET", "/v1/slow", { search: { ms: 2000 }, timeoutMs: 50 })],
		expect: [{ kind: "timeout" }],
		id: "timeout",
		setup: { timeoutMs: 10_000 },
		wire: [hop("GET", "/v1/slow?ms=2000")],
	},
	{
		calls: [echo({ headers: { "x-trace": "a" } }), echo()],
		expect: [echoed, echoed],
		id: "headers",
		setup: { headers: { "x-trace": "d" } },
		wire: [
			hop("GET", "/v1/echo", { headers: { "x-trace": "a" } }),
			hop("GET", "/v1/echo", { headers: { "x-trace": "d" } }),
		],
	},
	{
		calls: [echo({ origin: "alt" }), echo()],
		expect: [echoed, echoed],
		id: "base-url",
		wire: [hop("GET", "/v1/echo", { origin: "alt" }), hop("GET", "/v1/echo")],
	},
]

const auth: Scenario[] = [
	{
		calls: [echo()],
		expect: [echoed],
		id: "bearer-on-origin",
		setup: { auth: { kind: "bearer", token: "tok-b" } },
		wire: [hop("GET", "/v1/echo", { headers: { authorization: "Bearer tok-b" } })],
	},
	{
		calls: [echo()],
		expect: [echoed],
		id: "api-key-on-origin",
		setup: { auth: { kind: "header", name: "x-api-key", value: "key-1" } },
		wire: [hop("GET", "/v1/echo", { headers: { "x-api-key": "key-1" } })],
	},
	{
		calls: [call("redirect.crossOrigin", "GET", "/v1/redirect/cross-origin")],
		expect: [echoed],
		id: "cross-origin-redirect-drops",
		setup: { auth: { kind: "bearer", token: "tok-r" }, headers: { "x-api-key": "key-r" }, redirect: "follow" },
		wire: [
			hop("GET", "/v1/redirect/cross-origin", { headers: { authorization: "Bearer tok-r", "x-api-key": "key-r" } }),
			hop("GET", "/v1/echo", { headers: { authorization: ABSENT, "x-api-key": ABSENT }, origin: "alt" }),
		],
	},
]

const requestId: Scenario[] = [
	{
		calls: [echo({ headers: { "x-request-id": "conf-req-1" } })],
		expect: [{ ...data({ method: "GET", requestId: "conf-req-1" }), headers: { "x-request-id": "conf-req-1" } }],
		id: "explicit",
		wire: [hop("GET", "/v1/echo", { headers: { "x-request-id": "conf-req-1" } })],
	},
	{
		calls: [echo()],
		expect: [
			{
				...data({ method: "GET", requestId: { $hop: "x-request-id" } }),
				headers: { "x-request-id": { $hop: "x-request-id" } },
			},
		],
		id: "generated",
		wire: [hop("GET", "/v1/echo", { headers: { "x-request-id": ANY } })],
	},
]

/** Rows every target runs. */
const shared = (id: string, asserted: string, scenarios: Scenario[]): Feature => ({
	asserted,
	id,
	scenarios,
	targets: TARGETS,
})

export const FEATURES: readonly Feature[] = [
	shared("verbs", "each verb + path/query/header params: the request wire matches; the typed result decodes", verbs),
	shared("json-status", "JSON request + response: the right status variant comes back", jsonStatus),
	shared("typed-errors", "a honey error surfaces as the target's typed error, its key kept", typedErrors),
	shared("binary-response", "bytes come back as bytes; Accept names the declared media type", [
		{
			calls: [call("files.get", "GET", "/v1/files/:name", { params: { name: "blob.bin" } })],
			expect: [{ kind: "bytes", sha256: SHA_256B, size: 256, status: 200 }],
			id: "bytes",
			wire: [hop("GET", "/v1/files/blob.bin", { headers: { accept: OCTET } })],
		},
	]),
	shared("binary-request", "a raw body goes as is, with the declared content-type", [
		{
			calls: [
				call("files.put", "PUT", "/v1/files/:name", {
					body: { contentType: OCTET, kind: "binary", size: 65_536 },
					params: { name: "up.bin" },
				}),
			],
			expect: [data({ contentType: OCTET, sha256: SHA_64K, size: 65_536 })],
			id: "octet-stream",
			wire: [
				hop("PUT", "/v1/files/up.bin", {
					body: { contentType: OCTET, sha256: SHA_64K, size: 65_536 },
					headers: { "content-type": OCTET },
				}),
			],
		},
	]),
	shared("response-headers", "declared response headers are readable on the result, undeclared ones are not", [
		{
			calls: [getItem("h1")],
			expect: [{ ...data({ id: "h1", name: "item h1" }), headers: { "x-item-version": "3" } }],
			id: "declared-only",
		},
	]),
	shared("sse", "events typed from the declared schema, in order", [
		{
			calls: [call("ticks.stream", "GET", "/v1/ticks", { take: 3 })],
			expect: [{ events: events(1, 3, "tick"), kind: "events" }],
			id: "typed-events",
			wire: [hop("GET", "/v1/ticks")],
		},
	]),
	shared("reconnect", "SSE Last-Event-ID and WS reconnect_token resume the bit-06 reference log", reconnect),
	shared("overrides", "a per-call base URL, timeout or header applies to that call alone", overrides),
	shared("raw-response", "status, headers and body reachable through the raw accessor", [
		{
			calls: [getItem("r1", { raw: true })],
			expect: [
				{
					body: '{"id":"r1","name":"item r1"}',
					headers: { "content-type": JSON_TYPE, "x-item-version": "3" },
					kind: "raw",
					status: 200,
				},
			],
			id: "status-headers-body",
		},
	]),
	shared("auth", "a credential goes on-origin and is dropped on a cross-origin redirect (H18.10)", auth),
	shared("request-id", "x-request-id round-trips: the hop's id is the one the app answers with", requestId),
]
