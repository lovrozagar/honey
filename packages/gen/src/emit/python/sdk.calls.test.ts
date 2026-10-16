/**
 * The Python SDK's call surface, executed (contract 28 §7.5): one consumer program over the `surface` package
 * calls every shape of method against the recording server, one section per behavior. Each call runs on `SDK`
 * and then on `AsyncSDK`, so every wire line is recorded twice and each note pairs the two clients' answers: the
 * two must send and decode the same (G2's drift check). The method surface (G1: snake_case attributes from
 * IR.tree, path params positional in path order, the typed body, keyword-only params), the resource tree the two
 * clients share, the package root's exports and the R7 construction rules are each proven by a program that runs,
 * or by mypy's findings for one.
 */
import { describe, expect, it } from "vitest"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { compiledPython } from "./__fixtures__/compiled.ts"
import { checked, consume, once, seen } from "./__fixtures__/consumer.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()

/* a cold cache makes the venv and gates the package first */
const GATE = 120_000

/** A hop as one line: method, path and query, the x-trace header when sent, then the JSON body or the raw body's size and type. */
const wire = (hop: RecordedHop) =>
	[
		hop.method,
		hop.url,
		...(hop.headers["x-trace"] === undefined ? [] : [`x-trace=${hop.headers["x-trace"]}`]),
		...(hop.body.json !== undefined
			? [JSON.stringify(hop.body.json)]
			: hop.body.size > 0
				? [`${hop.body.size}B ${hop.body.contentType}`]
				: []),
	].join(" ")

/** `value` as the program's `note` writes it: Python's `json.dumps(value, sort_keys=True)`. */
const dumps = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(dumps).join(", ")}]`
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}: ${dumps(item)}`).join(", ")}}`
}

/** The note of one call made on both clients: the same answer twice. */
const pair = (value: unknown) => dumps([value, value])

const USER = { id: "u1", name: "n" }
const NOTE = { id: "n1", text: "hi" }

/** Every call the program sends, in order: its section, its wire line, its reply (200 `{}` when none). Each is sent by both clients. */
const SENT: readonly (readonly [section: string, wire: string, reply?: Reply])[] = [
	["crud", 'POST /v1/users {"name":"n"}', { json: USER, status: 200 }],
	[
		"order",
		'POST /v1/orgs/a%2Fb%20c/members/m%3F1/notes?tag=x%26y+z x-trace=t-1 {"text":"hi"}',
		{ json: NOTE, status: 200 },
	],
	["nested", 'POST /v1/checkout/sessions {"cart":"c"}', { json: { id: "s1" }, status: 200 }],
	["mixed", "GET /v1/users", { json: [{ id: "u1" }], status: 200 }],
	["mixed", 'PATCH /v1/users/u1/profile {"bio":"b"}', { json: { id: "u1" }, status: 200 }],
	["root", "GET /v1/users/u1", { json: USER, status: 200 }],
	["contacts", "GET /v1/contacts", { json: [], status: 200 }],
	["contacts", "GET /v1/sync/contacts", { json: [], status: 200 }],
	["keywords", "GET /v1/class/from"],
	["keywords", "POST /v1/table-templates/t1/use {}"],
	["keywords", "GET /v1/types/t1"],
	["keywords", "GET /v1/keywords/s/o/u"],
	["derived", "DELETE /v1/nothing/n1"],
	["models", "GET /v1/a", { json: { code: "E1" }, status: 200 }],
	[
		"names",
		"GET /v1/q?body=4&cancel_token=7&cast=11&headers=6&headers_into=2&idempotency_key=3&json=10&options=1&self=12&str=9&timeout=5&uuid=8",
		{ json: ["a"], status: 200 },
	],
	["tree", "POST /v1/blobs 2B application/octet-stream", { status: 204 }],
	["new", "POST /v1/close/run"],
]

/** Every hop in arrival order: each call of SENT, from SDK and then from AsyncSDK. */
const HOPS = SENT.flatMap((sent) => [sent, sent])

/** The program's helpers: `both` makes a call on each client (the async one must be a coroutine), `each` reads both. */
const HELPERS = `import inspect


async def both(call):
    with client() as c:
        a = call(c)
    async with aclient() as ac:
        b = call(ac)
        b = await b if inspect.iscoroutine(b) else f"not a coroutine: {b!r}"
    return [a, b]


async def each(look):
    with client() as c:
        a = look(c)
    async with aclient() as ac:
        b = look(ac)
    return [a, b]


def walk(node, path):
    out = []
    for name in dir(node):
        if name.startswith("_") or (path == "" and name in ("aclose", "close", "is_stale")):
            continue
        value = getattr(node, name)
        if inspect.ismethod(value):
            out.append(path + name)
        elif type(value).__module__ == type(node).__module__:
            out.extend(walk(value, path + name + "."))
    return out


def at(node, path):
    for name in path.split("."):
        node = getattr(node, name)
    return node
`

/** The package root's exports beside the clients (contract 28 §4.4), less the WebSocket and realtime ones. */
const STATUS_ERRORS = [
	"BadRequestError",
	"UnauthorizedError",
	"ForbiddenError",
	"NotFoundError",
	"ConflictError",
	"UnprocessableEntityError",
	"RateLimitError",
	"InternalServerError",
	"BadGatewayError",
	"ServiceUnavailableError",
	"GatewayTimeoutError",
]
const ROW_EXPORTS = [
	"SDK",
	"AsyncSDK",
	"ClientConfig",
	"RequestOptions",
	"RawResponse",
	"SDKResult",
	"HoneyError",
	"APIStatusError",
	...STATUS_ERRORS,
	"APIConnectionError",
	"APITimeoutError",
	"CanceledError",
	"DecodeError",
	"PathParamError",
	"ConfigError",
]
const ROOT_EXPORTS = [
	...ROW_EXPORTS,
	"InvalidationConfig",
	"RequestContext",
	"ResponseContext",
	"LogEntry",
	"HookError",
	"EventStream",
	"SseEvent",
	"FilePart",
	"ErrorEnvelope",
	"FieldError",
]
const IMPORT = `from acme_sdk import (\n${ROW_EXPORTS.map((name) => `    ${name},\n`).join("")})\n`

/** Each section's statements, in the order SENT lists their calls. */
const SECTIONS: Readonly<Record<string, string>> = {
	crud: `note(await both(lambda c: c.users.create({"name": "n"})))`,
	order: `note(await both(lambda c: c.orgs.members.notes.create("a/b c", "m?1", {"text": "hi"}, tag="x&y z", x_trace="t-1")))`,
	nested: `note(await both(lambda c: c.checkout.sessions.create({"cart": "c"})))`,
	mixed: `note(await both(lambda c: c.users.list()))
note(await both(lambda c: c.users.profile.update("u1", {"bio": "b"})))`,
	root: `note(await both(lambda c: c.get_user("u1")))
note(await each(lambda c: hasattr(c, "get_user")))`,
	contacts: `note(await both(lambda c: c.contacts.list()))
note(await both(lambda c: c.sync.contacts.list()))
note(await each(lambda c: type(c.contacts) is not type(c.sync.contacts)))`,
	keywords: `note(await both(lambda c: c.class_.from_()))
note(await both(lambda c: c.table_templates.use("t1", {})))
note(await both(lambda c: c.get_by_type("t1")))
note(await both(lambda c: c.keywords.params("s", "o", "u")))`,
	derived: `note(await both(lambda c: c.delete_nothing_by_id("n1")))`,
	models: `note(await both(lambda c: c.a.get()))
note([n for n in ("AnyModel", "ClientConfigModel", "NotFoundErrorModel", "SDKModel") if not hasattr(sdk, n)])
note(issubclass(sdk.NotFoundError, sdk.APIStatusError))`,
	names: `note(await both(lambda c: c.q.list(options2="1", headers_into2="2", idempotency_key2="3", body2="4", timeout="5", headers="6", cancel_token="7", uuid="8", str="9", json="10", cast="11", self_="12")))`,
	tree: `trees = await each(lambda c: walk(c, ""))
note(trees[0])
note([sorted(set(trees[1]) - set(trees[0])), sorted(set(trees[0]) - set(trees[1]))])
note(await each(lambda c: len([p for p in walk(c, "") if inspect.iscoroutinefunction(at(c, p))])))
note(await both(lambda c: c.blobs.upload(b"\\x00\\x01")))`,
	exports: `${IMPORT}note([e.__name__ for e in (${STATUS_ERRORS.join(", ")}) if not issubclass(e, APIStatusError)])
note(issubclass(APIStatusError, HoneyError))
note([n for n in ${JSON.stringify(ROOT_EXPORTS)} if n not in sdk.__all__])
note([n for n in ("ConnectionState", "ResumableConnection", "TypedWebSocket") if hasattr(sdk, n)])`,
	new: `with sdk.SDK() as c:
    note(type(c).__name__)
async with sdk.AsyncSDK() as ac:
    note(type(ac).__name__)
try:
    sdk.SDK(sdk.ClientConfig(base_url="not a url?api_key=s3cret"))
    note("built")
except Exception as error:
    note(f"{type(error).__name__} {'s3cret' in str(error)}")
note(await both(lambda c: c.close2.run()))`,
}

const indent = (text: string) =>
	text
		.split("\n")
		.map((line) => (line === "" ? "" : `    ${line}`))
		.join("\n")

/** `sections` as one body: the helpers, then each section in a try that notes what it raised, so one failure stays its own. */
const body = (sections: Readonly<Record<string, string>>) =>
	`${HELPERS}\n${Object.entries(sections)
		.map(
			([name, text]) =>
				`section(${JSON.stringify(name)})\ntry:\n${indent(text)}\nexcept Exception as error:\n    note(f"raised {type(error).__name__}: {error}")`,
		)
		.join("\n")}`

/** The `calls` program run once against the recording server at `/v1`, with every hop as a wire line. */
const calls = once(() =>
	served(
		HOPS.map(([, , reply]) => reply ?? { json: {}, status: 200 }),
		async (server) => {
			const run = await consume("surface", "calls", { base: `${server.url}/v1`, body: body(SECTIONS) })
			return { hops: server.hops.map(wire), run }
		},
	),
)

/** Section `name` of the `calls` program: whether it ran, its notes, and the wire lines its calls sent. */
async function section(name: string) {
	const { hops, run } = await calls()
	const own = hops.filter((_, i) => HOPS[i]?.[0] === name)
	return { observed: { ...seen(run, name), wire: own }, stderr: run.stderr }
}

/** The wire lines SENT lists for `name`, each sent by both clients. */
const sent = (name: string) => HOPS.filter(([s]) => s === name).map(([, line]) => line)

/** mypy's findings for `program` against `surface`, each as `<line>: <message>`. */
const findings = (program: string) =>
	checked("surface", program).map((line) => line.replace(/^[^:]+:(\d+): error: /, "$1: "))

describe.skipIf(!PY)("methods: an attribute per namespace, on both clients", () => {
	// v0: b9927ccf6d
	it(
		"calls users.create as client.users.create on SDK and AsyncSDK, both decoding the User",
		async () => {
			const { observed, stderr } = await section("crud")
			expect(observed, stderr).toEqual({ out: [pair(USER)], ran: true, wire: sent("crud") })
		},
		GATE,
	)

	// v0: 432c67972f
	it(
		"reaches a three-level id through one attribute per namespace",
		async () => {
			const { observed, stderr } = await section("nested")
			expect(observed, stderr).toEqual({ out: [pair({ id: "s1" })], ran: true, wire: sent("nested") })
		},
		GATE,
	)

	// v0: 7680e10917
	it(
		"exposes a namespace's own methods beside its child namespace",
		async () => {
			const { observed, stderr } = await section("mixed")
			expect(observed, stderr).toEqual({
				out: [pair([{ id: "u1" }]), pair({ id: "u1" })],
				ran: true,
				wire: sent("mixed"),
			})
		},
		GATE,
	)
})

describe.skipIf(!PY)("arguments: path params positional in path order, then the body", () => {
	// v0: d4d158082e
	it(
		"takes the path params positionally in path order though declared member, org, then the query and header keywords",
		async () => {
			const { observed, stderr } = await section("order")
			expect(observed, stderr).toEqual({ out: [pair(NOTE)], ran: true, wire: sent("order") })
		},
		GATE,
	)

	// v0: b86c78b9b8
	it(
		"takes the body positionally after the path params, typed by its TypedDict",
		async () => {
			const { observed, stderr } = await section("order")
			const typed = findings('import acme_sdk as sdk\n\nsdk.SDK().users.create({"name": 1})\n')
			expect({ ...observed, typed }, stderr).toEqual({
				out: [pair(NOTE)],
				ran: true,
				typed: [
					'3: Incompatible types (expression has type "int", TypedDict item "name" has type "str")  [typeddict-item]',
				],
				wire: sent("order"),
			})
		},
		GATE,
	)
})

describe.skipIf(!PY)("names: the clients' own operations, kept namespaces, keywords", () => {
	// v0: 14faec374e
	it(
		"puts a single-segment id on SDK and AsyncSDK themselves",
		async () => {
			const { observed, stderr } = await section("root")
			expect(observed, stderr).toEqual({ out: [pair(USER), "[true, true]"], ran: true, wire: sent("root") })
		},
		GATE,
	)

	// v0: 2f24d67fc2
	it(
		"keeps contacts and sync.contacts on their own resource classes",
		async () => {
			const { observed, stderr } = await section("contacts")
			expect(observed, stderr).toEqual({ out: [pair([]), pair([]), "[true, true]"], ran: true, wire: sent("contacts") })
		},
		GATE,
	)

	// v0: 72207d1119
	it(
		"calls keyword and camelCase namespaces, methods and path params by their snake_case, keyword-guarded names",
		async () => {
			const { observed, stderr } = await section("keywords")
			expect(observed, stderr).toEqual({ out: Array(4).fill(pair({})), ran: true, wire: sent("keywords") })
		},
		GATE,
	)
})

describe.skipIf(!PY)("names: derived ids, runtime-named components, params named like the method's own", () => {
	// v0: b4d6166ec6
	it(
		"calls an operation without an operationId by its derived id",
		async () => {
			const { observed, stderr } = await section("derived")
			expect(observed, stderr).toEqual({ out: [pair({})], ran: true, wire: sent("derived") })
		},
		GATE,
	)

	// v0: 7a8c9a7740
	// v0: 6e428e7a5a
	it(
		"renames components named like runtime or typing names to <Name>Model, beside the NotFoundError exception",
		async () => {
			const { observed, stderr } = await section("models")
			const typed = findings(
				'import acme_sdk as sdk\n\nm: sdk.NotFoundErrorModel = sdk.SDK().a.get()\nc: sdk.ClientConfigModel = {"id": "c"}\na: sdk.AnyModel = {"id": "a"}\ns: sdk.SDKModel = {"id": "s"}\n',
			)
			expect({ ...observed, typed }, stderr).toEqual({
				out: [pair({ code: "E1" }), "[]", "true"],
				ran: true,
				typed: [],
				wire: sent("models"),
			})
		},
		GATE,
	)

	// v0: 188a443648
	// v0: 0d15be8471
	it(
		"sends params named like the method's own arguments, the runtime's names and builtins under their wire names, and stays mypy-clean",
		async () => {
			const { observed, stderr } = await section("names")
			expect({ ...observed, mypy: compiledPython("surface").mypy() }, stderr).toEqual({
				mypy: [],
				out: [pair(["a"])],
				ran: true,
				wire: sent("names"),
			})
		},
		GATE,
	)
})

/** SDK's resource tree on `surface`: every non-stream op, by attribute path. */
const SYNC_TREE = [
	"a.get",
	"blobs.upload",
	"checkout.sessions.create",
	"class_.from_",
	"close2.run",
	"contacts.list",
	"delete_nothing_by_id",
	"exports.list",
	"get_by_type",
	"get_user",
	"items.list",
	"keywords.params",
	"orgs.members.notes.create",
	"q.list",
	"sync.contacts.list",
	"table_templates.use",
	"users.create",
	"users.list",
	"users.profile.update",
	"x.get",
]

describe.skipIf(!PY)("the two clients: one resource tree, one package root", () => {
	// v0: b4ef22c560
	it(
		"gives SDK AsyncSDK's tree less exactly the stream ops, binary uploads included, every AsyncSDK method a coroutine function and no SDK one",
		async () => {
			/* V0BUG: v0's isSyncCapable (codegen-python.ts:636-638) left binary-request ops off SDK (contract 28 §9.1) */
			const { observed, stderr } = await section("tree")
			expect(observed, stderr).toEqual({
				out: [dumps(SYNC_TREE), dumps([["events.stream", "ticks.stream"], []]), "[0, 22]", pair(null)],
				ran: true,
				wire: sent("tree"),
			})
		},
		GATE,
	)

	// v0: b8309c885d
	it(
		"exports SDK, AsyncSDK, the config and result types and the error hierarchy from the package root",
		async () => {
			const { observed, stderr } = await section("exports")
			expect({ ...observed, typed: findings(IMPORT) }, stderr).toEqual({
				out: ["[]", "true", "[]", "[]"],
				ran: true,
				typed: [],
				wire: [],
			})
		},
		GATE,
	)
})

/** `key`'s package constructing `SDK()` and `AsyncSDK()` with no config: each one's error class, and whether it names base_url. */
const bare = (key: "relative" | "types") =>
	consume(key, `bare-${key}`, {
		body: `for make in (sdk.SDK, sdk.AsyncSDK):
    try:
        make()
        note("built")
    except Exception as error:
        note(f"{type(error).__name__} {'base_url' in str(error)}")
with client() as c:
    note(type(c).__name__)`,
	})

describe.skipIf(!PY)("construction: servers[0] by default, ConfigError without a usable base_url (R7)", () => {
	it(
		"constructs both clients on servers[0], refuses a malformed base_url without echoing it, and reaches close.run as close2",
		async () => {
			const { observed, stderr } = await section("new")
			expect(observed, stderr).toEqual({
				out: ["SDK", "AsyncSDK", "ConfigError False", pair({})],
				ran: true,
				wire: sent("new"),
			})
		},
		GATE,
	)

	it(
		"refuses SDK() and AsyncSDK() for a document with no servers, naming base_url, and builds on an absolute one",
		async () => {
			const run = await bare("types")
			expect(seen(run), run.stderr).toEqual({ out: ["ConfigError True", "ConfigError True", "SDK"], ran: true })
		},
		GATE,
	)

	it(
		"refuses SDK() and AsyncSDK() for a relative first server, and builds on an absolute one",
		async () => {
			const run = await bare("relative")
			expect({ ...seen(run), out: seen(run).out?.map((line) => line.split(" ")[0]) }, run.stderr).toEqual({
				out: ["ConfigError", "ConfigError", "SDK"],
				ran: true,
			})
		},
		GATE,
	)
})
