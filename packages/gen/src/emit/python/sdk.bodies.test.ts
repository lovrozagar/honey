/**
 * The method shapes the registry documents do not reach (contract 28 §4.3, §4.5, §4.7): a text, form and
 * multipart body (its `<Op>Body` by part, contract 29 Fc6), an optional body, a text, binary and integer answer,
 * `<Op>Headers` and `headers_into`, a nullable optional keyword, a realtime op folding its declared Last-Event-ID,
 * a namespace mixing a stream with a call, a method named like a builtin a later signature spells, an API
 * without a title, and one without operations. Each is the emitted text; the package it belongs to is ruff- and
 * mypy-clean (checked when this file was written; phase c executes these shapes).
 */
import { describe, expect, it } from "vitest"
import { pythonCallPlans, generatePythonSdk } from "./sdk.ts"
import { allOrder, isortMembers } from "./sdk-imports.ts"

type Json = Record<string, unknown>

const STRING = { type: "string" }
const object = (properties: Json, required: string[] = []): Json => ({ properties, required, type: "object" })
const content = (media: string, schema: Json): Json => ({ content: { [media]: { schema } } })
const ok = (media: string, schema: Json, extra: Json = {}): Json => ({
	200: { description: "ok", ...content(media, schema), ...extra },
})
const path = (name: string): Json => ({ in: "path", name, required: true, schema: STRING })
const get = (operationId: string, responses: Json, extra: Json = {}): Json => ({
	get: { operationId, responses, ...extra },
})

/** Every body and answer kind beside JSON, response headers, the stream edges; no title, no servers. */
const BODIES: Json = {
	info: { version: "1" },
	openapi: "3.1.0",
	paths: {
		"/counts": get("counts.get", ok("application/json", { type: "integer" })),
		"/feed": get("feed.list", ok("application/json", { items: STRING, type: "array" })),
		"/feed/search": get("feed.search", ok("application/json", { items: STRING, type: "array" })),
		"/feed/stream": get("feed.stream", ok("text/event-stream", STRING)),
		"/files/{id}": get("files.get", ok("application/pdf", { format: "binary", type: "string" }), {
			parameters: [path("id")],
		}),
		"/forms": {
			post: {
				operationId: "forms.submit",
				requestBody: content("application/x-www-form-urlencoded", object({ name: STRING })),
				responses: { 204: { description: "done" } },
			},
		},
		"/live": get(
			"live.connect",
			{ 101: { description: "switching" } },
			{ parameters: [{ in: "header", name: "Last-Event-ID", schema: STRING }], "x-realtime": true },
		),
		"/notes/{id}": {
			put: {
				operationId: "notes.put",
				parameters: [path("id")],
				requestBody: { ...content("text/plain", STRING), required: true },
				responses: ok("text/plain", STRING),
			},
		},
		"/reports": get(
			"reports.get",
			ok("application/json", object({ total: { type: "integer" } }, ["total"]), {
				headers: {
					"X-Count": { schema: { type: "integer" } },
					"X-Tags": { schema: { items: STRING, type: "array" } },
					"X-Trace-Id": { required: true, schema: STRING },
				},
			}),
			{ parameters: [{ in: "query", name: "since", schema: { type: ["string", "null"] } }] },
		),
		"/uploads": {
			post: {
				operationId: "uploads.create",
				requestBody: {
					...content("multipart/form-data", object({ file: { format: "binary", type: "string" } }, ["file"])),
					required: true,
				},
				responses: { 201: { description: "made", ...content("application/json", object({ id: STRING }, ["id"])) } },
			},
		},
	},
}

const files = (document: Json) => generatePythonSdk(document).files
const client = (document: Json) => (files(document)["src/honey_sdk/client.py"] ?? "").split("\n")

/** The client.py lines that start with `prefix` after their indentation (and `async `, for a `def`). */
const lines = (document: Json, prefix: string) =>
	client(document).filter((line) =>
		line
			.trimStart()
			.replace(/^async (?=def )/, "")
			.startsWith(prefix),
	)

/** The lines of client.py's class `name`, up to the next class. */
function classOf(document: Json, name: string): string[] {
	const text = client(document)
	const start = text.indexOf(`class ${name}:`)
	const end = text.findIndex((line, i) => i > start && line.startsWith("class "))
	return text.slice(start, end)
}

/** `line` on SDK and on AsyncSDK. */
const both = (line: string) => [line, line.replace("    def ", "    async def ")]

describe("bodies and answers beside JSON", () => {
	it("takes text as str, a form and multipart parts by their schema, an optional body with a None default", () => {
		expect(lines(BODIES, "def put(").concat(lines(BODIES, "def submit("), lines(BODIES, "def create("))).toEqual([
			...both("    def put(self, id: str, body: str, *, options: RequestOptions | None = None) -> str:"),
			...both(
				"    def submit(self, body: FormsSubmitBody | None = None, *, options: RequestOptions | None = None) -> None:",
			),
			...both(
				"    def create(self, body: UploadsCreateBody, *, options: RequestOptions | None = None) -> UploadsCreateResponse:",
			),
		])
	})

	it("declares each body's media type, and the media type a text or binary answer asks for", () => {
		expect(lines(BODIES, "_NOTES_PUT").concat(lines(BODIES, "_FILES_GET"), lines(BODIES, "_UPLOADS_CREATE"))).toEqual([
			'_NOTES_PUT: Operation[str] = Operation("PUT", "/notes/{id}", ("id",), body="text", content_type="text/plain", answer="text", accept="text/plain")',
			'_FILES_GET: Operation[bytes] = Operation("GET", "/files/{id}", ("id",), answer="binary", accept="application/pdf")',
			'_UPLOADS_CREATE: Operation[UploadsCreateResponse] = Operation("POST", "/uploads", body="multipart", content_type="multipart/form-data", shape="object")',
		])
	})

	it("holds an integer answer to a JSON number", () => {
		expect(lines(BODIES, "_COUNTS_GET")).toEqual([
			'_COUNTS_GET: Operation[int] = Operation("GET", "/counts", shape="number")',
		])
	})
})

describe("multipart bodies (contract 29 Fc6)", () => {
	const BINARY = { format: "binary", type: "string" }
	const post = (operationId: string, schema: Json): Json => ({
		post: {
			operationId,
			requestBody: { ...content("multipart/form-data", schema), required: true },
			responses: { 204: { description: "done" } },
		},
	})
	const FORMS: Json = {
		info: { version: "1" },
		openapi: "3.1.0",
		paths: {
			"/nulls": post("nulls.send", {
				properties: { file: BINARY, "x-note": STRING },
				required: ["file"],
				type: ["object", "null"],
			}),
			"/texts": post("texts.send", object({ note: STRING }, ["note"])),
		},
	}
	const decl = (document: Json, name: string) => {
		const types = files(document)["src/honey_sdk/types.py"] ?? ""
		const start = types.search(new RegExp(`^(class )?${name}\\b`, "m"))
		return types.slice(start, types.indexOf("\n\n", start))
	}

	it("types a file part FilePart, imported from the runtime, bare when the form requires it", () => {
		expect({
			decl: decl(BODIES, "UploadsCreateBody"),
			imports: (files(BODIES)["src/honey_sdk/types.py"] ?? "").includes("\n\nfrom ._honey.body import FilePart\n"),
		}).toEqual({ decl: "class UploadsCreateBody(TypedDict):\n    file: FilePart", imports: true })
	})

	it("leaves every part NotRequired under a form that is no object, and imports no FilePart for text parts alone", () => {
		expect({
			nulls: decl(FORMS, "NullsSendBody"),
			texts: decl(FORMS, "TextsSendBody"),
			textOnly: files({ ...FORMS, paths: { "/texts": (FORMS.paths as Json)["/texts"] } })[
				"src/honey_sdk/types.py"
			]?.includes("FilePart"),
		}).toEqual({
			nulls:
				'NullsSendBody = TypedDict(\n    "NullsSendBody",\n    {"file": "NotRequired[FilePart]", "x-note": "NotRequired[str]"},\n)',
			texts: "class TextsSendBody(TypedDict):\n    note: str",
			textOnly: false,
		})
	})
})

describe("response headers (G5)", () => {
	it("declares <Op>Headers beside the types, takes headers_into, and reads each header by its kind", () => {
		const types = files(BODIES)["src/honey_sdk/types.py"] ?? ""
		expect({
			constant: lines(BODIES, "_REPORTS_GET"),
			decl: types.slice(types.indexOf("class ReportsGetHeaders"), types.indexOf("\n\n\nclass ReportsGetResponse")),
			plan: pythonCallPlans(BODIES)["reports.get"]?.responseHeaders,
			signature: lines(BODIES, "def get(self, *, since"),
		}).toEqual({
			constant: [
				'_REPORTS_GET: Operation[ReportsGetResponse] = Operation("GET", "/reports", shape="object", headers=(("X-Count", "x_count", "integer", False), ("X-Tags", "x_tags", "string", False), ("X-Trace-Id", "x_trace_id", "string", True)))',
			],
			/* a header that is no scalar is the text that arrives */
			decl: "class ReportsGetHeaders(TypedDict, total=False):\n    x_count: int\n    x_tags: str\n    x_trace_id: str",
			plan: {
				fields: { "X-Count": "x_count", "X-Tags": "x_tags", "X-Trace-Id": "x_trace_id" },
				type: "ReportsGetHeaders",
			},
			/* a nullable optional keyword admits None already: its default needs no second one */
			signature: both(
				"    def get(self, *, since: str | None = None, headers_into: ReportsGetHeaders | None = None, options: RequestOptions | None = None) -> ReportsGetResponse:",
			),
		})
	})
})

describe("streams beside calls", () => {
	it("folds a realtime op's declared Last-Event-ID into its own field (Fd3)", () => {
		expect({
			headers: pythonCallPlans(BODIES)["live.connect"]?.headers,
			signature: lines(BODIES, "def connect("),
		}).toEqual({
			headers: {},
			signature: [
				"    async def connect(self, *, last_event_id: str | None = None, reconnect_token: str | None = None, protocols: Sequence[str] | None = None, max_reconnect_attempts: int | None = None, reconnect_delay_ms: int | None = None, options: RequestOptions | None = None) -> ResumableConnection[Any]:",
			],
		})
	})

	it("keeps a namespace's calls on SDK and its stream on AsyncSDK alone", () => {
		const methods = (name: string) =>
			classOf(BODIES, name).flatMap((line) => /^ {4}(?:async )?def (\w+)\(/.exec(line)?.[1] ?? [])
		expect({ async: methods("AsyncFeedResource"), sync: methods("FeedResource") }).toEqual({
			async: ["__init__", "list", "search", "stream"],
			sync: ["__init__", "list", "search"],
		})
	})
})

describe("a method named like a builtin", () => {
	it("spells the builtin as builtins.<name> in the class's later signatures, and only there", () => {
		expect({
			imported: client(BODIES).includes("import builtins"),
			list: lines(BODIES, "def list("),
			search: lines(BODIES, "def search("),
		}).toEqual({
			imported: true,
			list: both("    def list(self, *, options: RequestOptions | None = None) -> list[str]:"),
			search: both("    def search(self, *, options: RequestOptions | None = None) -> builtins.list[str]:"),
		})
	})
})

describe("an API without a title, and one without operations", () => {
	const EMPTY: Json = { info: { title: "Empty", version: "1" }, openapi: "3.1.0", paths: {} }

	it("titles the client and the types generically, and imports no Operation without operations", () => {
		const empty = files(EMPTY)["src/honey_sdk/client.py"] ?? ""
		expect({
			client: client(BODIES)[1],
			emptyDefaults: empty.includes('_DEFAULTS = Defaults(None, "Authorization", "Bearer ")'),
			emptyOperation: empty.includes("Operation"),
			types: (files(BODIES)["src/honey_sdk/types.py"] ?? "").split("\n")[1],
		}).toEqual({
			client: '"""The API\'s client, generated by honey."""',
			emptyDefaults: true,
			emptyOperation: false,
			types: '"""The API\'s types."""',
		})
	})
})

describe("import members that differ only in case", () => {
	it("orders them as ruff does: upper before lower, natural within", () => {
		expect({ all: allOrder(["ab", "aB"]), imports: isortMembers(["ab", "aB", "Ab", "AB"]) }).toEqual({
			all: ["aB", "ab"],
			imports: ["AB", "Ab", "aB", "ab"],
		})
	})
})
