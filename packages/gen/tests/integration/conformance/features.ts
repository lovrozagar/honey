/**
 * The conformance grid's data: the targets and every row with its scenarios, plain JSON so a
 * non-TS runner reads a cell from stdin. Each row is one feature of blueprint/dx/conformance.md;
 * the shared rows run on every target. Bits 12–18 add their CLI-only rows here and their MCP-only
 * rows in features-mcp.ts, nowhere else. Every expectation is what the reference app (core `conformance/app.ts`) answers.
 */
import { ABSENT, ANY, call, data, error, events, hop, JSON_TYPE, OCTET, SHA_256B, SHA_64K } from "./cells.ts"
import { MCP_ROWS } from "./features-mcp.ts"
import { SDK_ROWS } from "./features-sdk.ts"
import type { Call, Expected, Feature, Scenario } from "./matrix.ts"

export const TARGETS = ["ts", "go", "rust", "python", "csharp", "java", "cli", "mcp"] as const
export { SDKS } from "./features-sdk.ts"

const getItem = (id: string, more: Partial<Call> = {}) =>
	call("items.get", "GET", "/v1/items/:id", { params: { id }, ...more })
const echo = (more: Partial<Call> = {}) => call("echo.get", "GET", "/v1/echo", more)
const echoed = data({ method: "GET", requestId: ANY })
/** non-ASCII beside the characters encoders escape (Go `<>&`, .NET `'+\``): every target must round-trip its value */
const ESCAPED = "é 中 🙂 <&> ' \" + `"

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
	/* sweep 15: the wire compares the parsed body, so any valid escaping passes; the echoed name must be the same text */
	{
		calls: [call("items.create", "POST", "/v1/items", { body: { kind: "json", value: { name: ESCAPED } } })],
		expect: [data({ id: "item-new", name: ESCAPED }, 201)],
		id: "post-non-ascii",
		wire: [hop("POST", "/v1/items", { body: { contentType: JSON_TYPE, json: { name: ESCAPED } } })],
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
	/* sweep 30: the same value through a realtime send, echoed back: the frame must parse to what was sent */
	{
		calls: [call("realtime.echo", "GET", "/v1/realtime/echo", { send: [JSON.stringify({ name: ESCAPED })], take: 1 })],
		expect: [{ frames: [{ name: ESCAPED }], kind: "frames" }],
		id: "realtime-send-non-ascii",
	},
	/* a send that is no JSON goes as raw text on every SDK (sweep 14): the echo wraps non-JSON text as { got } */
	{
		calls: [call("realtime.echo", "GET", "/v1/realtime/echo", { send: ["hello"], take: 1 })],
		expect: [{ frames: [{ got: "hello" }], kind: "frames" }],
		id: "realtime-send-raw-text",
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
	/* every transport refused 403: the feed ends, each transport dialed once at most, never a redial (bit 19 e, #6) */
	{
		calls: [call("realtime.refused", "GET", "/v1/realtime/refused", { take: 1 })],
		dials: { atMost: 3, hop: hop("GET", "/v1/realtime/refused") },
		expect: [error(403, "limit_reached")],
		id: "refusal-terminal",
	},
	/* the upgrade 404s, the first event stream and every poll 503: one transient failure backs off and retries */
	{
		calls: [call("realtime.mixed", "GET", "/v1/realtime/mixed", { take: 1 })],
		expect: [{ frames: [{ n: 1 }], kind: "frames" }],
		id: "refusal-mixed-retries",
	},
]

const overrides: Scenario[] = [
	/*
	 * Warmed (bit 15 e, Fe2): the timed call is not the client's first, and its deadline is 300 ms. A cold first
	 * request under a 50 ms deadline lost its hop under load (red in 20 runs: C# 20, Python floor 11, Rust 6,
	 * Python async 5, Python sync 1). TS and Go never lost it (0 of 20) and run this shape because the cell is shared.
	 */
	{
		calls: [echo(), call("timing.slow", "GET", "/v1/slow", { search: { ms: 2000 }, timeoutMs: 300 })],
		expect: [echoed, { kind: "timeout" }],
		id: "timeout",
		setup: { timeoutMs: 10_000 },
		wire: [hop("GET", "/v1/echo"), hop("GET", "/v1/slow?ms=2000")],
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

/** A CLI-only call: `argv` as the CLI runs it, reaching `operation` (none for a local command). */
const argv = (operation: string, args: readonly string[]): Call => ({
	argv: args,
	operation,
	route: { method: "", path: "" },
})

/** The CLI's own observation: its exit code, stdout's lines, each stderr line as JSON. */
const cli = (exit: number, stdout: readonly string[] = [], stderr: readonly Expected[] = []): Expected => ({
	exit,
	kind: "cli",
	stderr,
	stdout,
})

/** A usage or API error as the CLI's stderr carries it under JSON. */
const failed = (fields: Record<string, Expected>): Expected => ({ error: fields })

/* the echo with a fixed request id: one deterministic line */
const ECHO_ARGS = ["echo", "get", "--header", "x-request-id: cli-1"]
const ECHO_LINE = '{"method":"GET","requestId":"cli-1"}'

/** The declared 404 as the CLI's stderr carries it. */
const NOT_FOUND = failed({ errorKey: "not_found", kind: "api", message: "Not found", status: 404 })
/* `config --json` under a fixed base URL and no other setting */
const CONFIG_LINE =
	'{"api_key":{"source":"default","value":""},"base_url":{"source":"flag","value":"http://127.0.0.1:9"},"headers":{"source":"default","value":{}},"quiet":{"source":"default","value":false},"redirect":{"source":"default","value":"same-origin"},"target":{"host":"127.0.0.1:9","kind":"local"},"timeout":{"source":"default","value":"30s"},"verbose":{"source":"default","value":false}}'
/** The reference app's index as `conformance commands` prints it: an operation added reds this until it is listed. */
const REFERENCE_INDEX = [
	"local: commands completion config schema skill",
	"boundary custom",
	"boundary default",
	"echo get",
	"errors declared <status>",
	"errors status <status>",
	"events append",
	"events socket (ws)",
	"events stream (sse)",
	"faults undecodable",
	"files get <name>",
	"files put <name> --data binary",
	"health",
	"idempotent create",
	"items create --data json",
	"items delete <id>",
	"items get <id>",
	"items list [--limit integer] [--q string]",
	"items patch <id> --data json",
	"items update <id> [--flag] [--limit integer] [--q string] [--ratio number] [--tags string...] [--x-trace string] --data json",
	"ping",
	"realtime capped (realtime)",
	"realtime echo (realtime)",
	"realtime mixed (realtime)",
	"realtime refused (realtime)",
	"redirect cross-origin",
	"ticks refused (sse)",
	"ticks stream (sse)",
	"timing slow --ms integer",
	"uploads blob --data binary",
	"uploads form [--file path]",
	"users create --data json",
	"users delete <id>",
	"users get <id>",
	"users list",
	"users update <id> --data json",
	"validated create --data json",
	"ws echo [--token string] (ws)",
]
/** `conformance __complete ""`: the top-level commands, then cobra's directive. */
const REFERENCE_COMPLETION = [
	"boundary",
	"commands\tlist every command, one usage line each (text even when piped; --json: one object per line)",
	"completion\tGenerate the autocompletion script for the specified shell",
	"config\tthe settings this run resolves, each with its source, and where calls go",
	"echo",
	"errors",
	"events",
	"faults",
	"files",
	"health",
	"help\tHelp about any command",
	"idempotent",
	"items",
	"ping",
	"realtime",
	"redirect",
	"schema\ta command's request and answer: usage, method and path, body, result or events, errors",
	"skill\tprint the agent skill (SKILL.md) this CLI ships",
	"ticks",
	"timing",
	"uploads",
	"users",
	"validated",
	"ws",
	":4",
]

const exitCodes: Scenario[] = [
	{
		calls: [
			argv("echo.get", ECHO_ARGS),
			argv("errors.declared", ["errors", "declared", "404"]),
			argv("errors.status", ["errors", "status", "500"]),
			argv("echo.get", ["echo", "get", "--base-url", "http://127.0.0.1:1"]),
			argv("echo.get", ["echo", "get", "--nope"]),
			argv("redirect.crossOrigin", ["redirect", "cross-origin"]),
		],
		expect: [
			cli(0, [ECHO_LINE]),
			cli(1, [], [NOT_FOUND]),
			cli(2, [], [failed({ kind: "api", message: "status 500", status: 500 })]),
			cli(3, [], [failed({ kind: "transport", message: ANY })]),
			cli(4, [], [failed({ kind: "usage", message: "unknown flag: --nope" })]),
			cli(
				5,
				[],
				[
					failed({
						kind: "api",
						message: "the API answered 307, a redirect not followed: rerun with --redirect follow to follow it",
						status: 307,
					}),
				],
			),
		],
		id: "by-outcome",
	},
]

const jsonUniform: Scenario[] = [
	{
		calls: [
			argv("echo.get", ECHO_ARGS),
			argv("errors.declared", ["errors", "declared", "404"]),
			argv("", ["config", "--json", "--base-url", "http://127.0.0.1:9"]),
		],
		expect: [cli(0, [ECHO_LINE]), cli(1, [], [NOT_FOUND]), cli(0, [CONFIG_LINE])],
		id: "one-line",
	},
]

/** Rows only the CLI runs (dx/conformance:32). */
const cliOnly = (id: string, asserted: string, scenarios: Scenario[]): Feature => ({
	asserted,
	id,
	scenarios,
	targets: ["cli"],
})

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
	shared(
		"reconnect",
		"SSE Last-Event-ID and WS reconnect_token resume the bit-06 reference log; a realtime refusal is terminal",
		reconnect,
	),
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
	...SDK_ROWS,
	cliOnly(
		"exit-codes",
		"the exit code by outcome: 0 ok, 1 a 4xx, 2 a 5xx, 3 no answer, 4 usage, 5 a redirect not followed",
		exitCodes,
	),
	cliOnly("json-uniform", "every answer, error and local command under --json is one compact JSON line", jsonUniform),
	cliOnly("output-file", "-o writes the answer's bytes to the file, stdout empty", [
		{
			calls: [argv("files.get", ["files", "get", "blob.bin", "-o", "$FILE"])],
			expect: [{ exit: 0, file: { sha256: SHA_256B, size: 256 }, kind: "cli", stderr: [], stdout: [] }],
			id: "bytes",
			wire: [hop("GET", "/v1/files/blob.bin", { headers: { accept: OCTET } })],
		},
	]),
	cliOnly("discovery", "commands lists the app's every operation, one usage line each", [
		{ calls: [argv("", ["commands"])], expect: [cli(0, REFERENCE_INDEX)], id: "index" },
	]),
	...MCP_ROWS,
	cliOnly("completion", "shell completion offers the app's commands", [
		{
			calls: [argv("", ["__complete", ""])],
			expect: [cli(0, REFERENCE_COMPLETION, ["Completion ended with directive: ShellCompDirectiveNoFileComp"])],
			id: "commands",
		},
	]),
]
