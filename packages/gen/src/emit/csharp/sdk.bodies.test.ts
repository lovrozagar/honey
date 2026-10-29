/**
 * The C# method shapes past JSON (contract 47 §5.12, §2.1, §2.2): every kind phase b refused (Fb1) emits, the
 * bodies and bytes since phase c and the streams since phase d (contract 50 §2); each body and answer kind's method
 * on `http`, and the bytes and text twins on its `client.Safe` (bit 21 i5); the multipart `<Op>Body` records with `FilePart` parts;
 * Fc7's `<Op>Headers` holder and its `Read`, typed by each header's scalar, none for a WebSocket or realtime op; what
 * the JSON context lists and never lists; and the names `headersInto` and `Part` push to `…2`. Each is the emitted
 * text.
 */
import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { type SdkOp, sdkModel } from "../../ir/sdk-model.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { csharpCallPlans, generateCSharpSdk } from "./sdk.ts"
import { csTypeContext } from "./types.ts"

type Json = Record<string, unknown>
type Files = Readonly<Record<string, string>>

const OPTIONS = "RequestOptions? options = null, CancellationToken cancellationToken = default"
const CONTEXT = "HoneySdkJsonContext.Default"

const STRING = { type: "string" }
const BINARY = { format: "binary", type: "string" }
const content = (type: string, schema: Json = STRING): Json => ({ content: { [type]: { schema } } })
const OK = content("application/json", { properties: { ok: { type: "boolean" } }, type: "object" })

/** An API of `paths`, with no servers. */
const api = (paths: Json): Json => ({ info: { title: "Kinds", version: "1" }, openapi: "3.1.0", paths })

/** A one-operation document: `operationId` under `method` at `/x`. */
const single = (operationId: string, operation: Json, method = "post"): Json =>
	api({ "/x": { [method]: { operationId, ...operation } } })

const DONE = { responses: { 204: { description: "done" } } }
const body = (type: string, schema?: Json) => ({ ...DONE, requestBody: { ...content(type, schema), required: true } })
const answer = (type: string, schema?: Json) => ({
	responses: { 200: { description: "ok", ...content(type, schema) } },
})
const SOCKET = { responses: { 101: { description: "Switching Protocols" } }, "x-websocket": true }

/** Phase b's refused kinds (Fb1), each its own one-op document. */
const KINDS: readonly (readonly [label: string, document: Json])[] = [
	[
		"a form body",
		single("forms.send", body("application/x-www-form-urlencoded", { properties: { a: STRING }, type: "object" })),
	],
	[
		"a multipart body",
		single("uploads.send", body("multipart/form-data", { properties: { file: BINARY }, type: "object" })),
	],
	["an octet-stream body", single("blobs.put", body("application/octet-stream", BINARY))],
	["a text/plain body", single("texts.send", body("text/plain"))],
	["an octet-stream answer", single("blobs.get", answer("application/octet-stream", BINARY), "get")],
	["an SSE answer", single("events.stream", answer("text/event-stream"), "get")],
	["a WebSocket", single("ws.subscribe", SOCKET, "get")],
	["a realtime channel", single("realtime.connect", { ...SOCKET, "x-realtime": true }, "get")],
]

/** A multipart body whose schema requires its file part. */
const UPLOADS = single(
	"uploads.create",
	body("multipart/form-data", { properties: { file: BINARY, note: STRING }, required: ["file"], type: "object" }),
)

/** One response header of each scalar kind, an object one, and a required one. */
const REPORTS = single(
	"reports.get",
	{
		responses: {
			200: {
				description: "ok",
				headers: {
					"X-Count": { schema: { type: "integer" } },
					"X-Flag": { schema: { type: "boolean" } },
					"X-Meta": { schema: { properties: { a: STRING }, type: "object" } },
					"X-Ratio": { schema: { type: "number" } },
					"X-Trace-Id": { required: true, schema: STRING },
				},
				...OK,
			},
		},
	},
	"get",
)

/** The same 2xx header on a plain op, a WebSocket and a realtime channel. */
const TRACED = { 200: { description: "ok", headers: { "X-Trace": { schema: STRING } } } }
const STREAMED = api({
	"/live": {
		get: {
			operationId: "live.connect",
			responses: { ...SOCKET.responses, ...TRACED },
			"x-realtime": true,
			"x-websocket": true,
		},
	},
	"/plain": { get: { operationId: "plain.get", responses: TRACED } },
	"/ws": { get: { operationId: "ws.subscribe", responses: { ...SOCKET.responses, ...TRACED }, "x-websocket": true } },
})

/** A namespace `part` (the runtime's `Part`) whose op takes a header param `headersInto` and declares a header. */
const NAMES = single(
	"part.get",
	{
		parameters: [{ in: "header", name: "headersInto", schema: STRING }],
		responses: { 200: { description: "ok", headers: { "X-Trace": { schema: STRING } }, ...OK } },
	},
	"get",
)

const filesOf = (document: Json): Files => generateCSharpSdk(document).files
const http = (): Files => generateCSharpSdk(FIXTURES.http.document()).files

/** What generating `document` throws, or null when it emits. */
function refusal(document: Json): string | null {
	try {
		generateCSharpSdk(document)
		return null
	} catch (error) {
		return (error as Error).message
	}
}

/** Client.cs's class whose head is `public sealed class <head>`, through its closing brace. */
function classOf(files: Files, head: string): string[] {
	const lines = (files["Client.cs"] ?? "").split("\n")
	const start = lines.indexOf(`public sealed class ${head}`)
	return start < 0 ? [`no class ${head}`] : lines.slice(start, lines.indexOf("}", start) + 1)
}

/** The line `signature` in `lines` and the call line under it. */
function methodAt(lines: readonly string[], signature: string): string[] {
	const at = lines.indexOf(signature)
	return at < 0 ? [`no method ${signature.trim()}`] : lines.slice(at, at + 2)
}

/** Types.cs's declaration of `name`: its doc lines, its head, through its closing brace. */
function declOf(files: Files, name: string): string[] {
	const lines = (files["Types.cs"] ?? "").split("\n")
	const head = lines.findIndex((line) => new RegExp(`^public sealed (?:class|record) ${name}$`).test(line))
	if (head < 0) return [`no declaration ${name}`]
	let start = head
	while (start > 0 && (lines[start - 1] ?? "").startsWith("///")) start -= 1
	return lines.slice(start, lines.indexOf("}", head) + 1)
}

/** Each type JsonContext.cs lists, as its `typeof` spells it. */
const listed = (files: Files) =>
	[
		...(files["JsonContext.cs"] ?? "").matchAll(
			/^\[JsonSerializable\(typeof\((.+)\), TypeInfoPropertyName = "\w+"\)\]$/gm,
		),
	].map((match) => match[1])

/** §2.2's multipart record of `op`: one `{ get; init; }` property per part, a blank line apart. */
const record = (op: string, name: string, properties: readonly string[]) => [
	`/// <summary>The multipart body of ${op}: one part per property.</summary>`,
	`public sealed record ${name}`,
	"{",
	...properties.flatMap((property, i) => [...(i > 0 ? [""] : []), `    public ${property} { get; init; }`]),
	"}",
]

/** §2.2's response-header holder of `op`: `[property, header, reader, required]` per header, then `Read`. */
const holder = (op: string, name: string, headers: readonly (readonly [string, string, string, boolean?])[]) => [
	`/// <summary>The response headers of ${op}, set when the call answers 2xx.</summary>`,
	`public sealed class ${name}`,
	"{",
	...headers.flatMap(([property], i) => [...(i > 0 ? [""] : []), `    public ${property} { get; private set; }`]),
	"",
	"    internal void Read(IReadOnlyDictionary<string, string> headers)",
	"    {",
	...headers.map(
		([property, header, reader, required]) =>
			`        ${property.split(" ")[1]} = ResponseHeaders.${reader}(headers, "${header}", required: ${required === true});`,
	),
	"    }",
	"}",
]

/** §2.1's methods on `http` (and `files.batch`'s by the same rule): the op, its class, its signature and call lines. */
const METHODS: readonly (readonly [op: string, owner: string, signature: string, call: string])[] = [
	[
		"files.get",
		"FilesResource",
		`    public Task<byte[]> GetAsync(string name, ${OPTIONS}) =>`,
		"        _t.BytesAsync(_get, new([name], [], [], null, null, options), cancellationToken);",
	],
	[
		"files.put",
		"FilesResource",
		`    public Task<FilesPutResponse> PutAsync(string name, BinaryBody body, ${OPTIONS}) =>`,
		`        _t.CallAsync(_put, new([name], [], [], Body.Binary(body, "application/octet-stream"), null, options), ${CONTEXT}.FilesPutResponse, cancellationToken);`,
	],
	[
		"files.upload",
		"FilesResource",
		`    public Task<FilesUploadResponse> UploadAsync(FilesUploadBody body, ${OPTIONS}) =>`,
		`        _t.CallAsync(_upload, new([], [], [], Body.Multipart([Part.File("file", body.File), Part.Text("name", body.Name, ${CONTEXT}.String), Part.Text("tags", body.Tags, ${CONTEXT}.StringList)]), null, options), ${CONTEXT}.FilesUploadResponse, cancellationToken);`,
	],
	[
		"files.batch",
		"FilesResource",
		`    public Task<FilesBatchResponse> BatchAsync(FilesBatchBody body, ${OPTIONS}) =>`,
		`        _t.CallAsync(_batch, new([], [], [], Body.Multipart([Part.Text("count", body.Count, ${CONTEXT}.NullableInt64), Part.Files("files", body.Files), Part.Text("flags", body.Flags, ${CONTEXT}.BooleanList), Part.Text("meta", body.Meta, ${CONTEXT}.FilesBatchBodyMeta)]), null, options), ${CONTEXT}.FilesBatchResponse, cancellationToken);`,
	],
	[
		"notes.create",
		"NotesResource",
		`    public Task<string> CreateAsync(string body, ${OPTIONS}) =>`,
		'        _t.TextAsync(_create, new([], [], [], Body.Text(body, "text/plain"), null, options), cancellationToken);',
	],
	[
		"items.get",
		"ItemsResource",
		`    public Task<Item> GetAsync(string id, ItemsGetHeaders? headersInto = null, ${OPTIONS}) =>`,
		`        _t.CallAsync(_get, new([id], [], [], null, null, options, headersInto is null ? null : headersInto.Read), ${CONTEXT}.Item, cancellationToken);`,
	],
	[
		"forms.submit",
		"FormsResource",
		`    public Task<FormsSubmitResponse> SubmitAsync(FormsSubmitBody body, ${OPTIONS}) =>`,
		`        _t.CallAsync(_submit, new([], [], [], Body.Form(body, ${CONTEXT}.FormsSubmitBody), null, options), ${CONTEXT}.FormsSubmitResponse, cancellationToken);`,
	],
]

describe("generateCSharpSdk: the kinds phase b refused", () => {
	/* phase b's sdk.test.ts:311 refusals: phase c lifts the bodies and bytes, phase d the streams (contract 50 §2) */
	it("emits form, multipart, octet-stream and text/plain bodies, an octet-stream answer, an SSE answer, a WebSocket and a realtime channel", () => {
		expect(Object.fromEntries(KINDS.map(([label, document]) => [label, refusal(document)]))).toEqual({
			"a form body": null,
			"a multipart body": null,
			"an octet-stream body": null,
			"a text/plain body": null,
			"an octet-stream answer": null,
			"an SSE answer": null,
			"a WebSocket": null,
			"a realtime channel": null,
		})
	})
})

describe("generateCSharpSdk: each body and answer kind's method (§2.1)", () => {
	/* ported from python/sdk.bodies.test.ts:106 and :118 */
	it("writes files.get, files.put, files.upload, files.batch, notes.create, items.get and forms.submit byte for byte", () => {
		const files = http()
		expect(
			Object.fromEntries(METHODS.map(([op, owner, signature]) => [op, methodAt(classOf(files, owner), signature)])),
		).toEqual(Object.fromEntries(METHODS.map(([op, , signature, call]) => [op, [signature, call]])))
	})

	it("answers bytes and text as Result<byte[]> and Result<string> on their client.Safe twins, through the methods", () => {
		const files = http()
		const bytes = `    public Task<Result<byte[]>> GetAsync(string name, ${OPTIONS}) =>`
		const text = `    public Task<Result<string>> CreateAsync(string body, ${OPTIONS}) =>`
		expect({
			bytes: methodAt(classOf(files, "SafeFilesResource"), bytes),
			text: methodAt(classOf(files, "SafeNotesResource"), text),
		}).toEqual({
			bytes: [bytes, "        Transport.Safe(options, _o => _n.GetAsync(name, _o, cancellationToken));"],
			text: [text, "        Transport.Safe(options, _o => _n.CreateAsync(body, _o, cancellationToken));"],
		})
	})
})

describe("generateCSharpSdk: multipart <Op>Body records (§2.2)", () => {
	/* ported from python/sdk.bodies.test.ts:133-167 */
	it("declares one property per part in part-name order, a file part FilePart, a file array IReadOnlyList<FilePart>, required where the schema says", () => {
		const files = http()
		expect({
			batch: declOf(files, "FilesBatchBody"),
			required: declOf(filesOf(UPLOADS), "UploadsCreateBody"),
			upload: declOf(files, "FilesUploadBody"),
		}).toEqual({
			batch: record("files.batch", "FilesBatchBody", [
				"long? Count",
				"IReadOnlyList<FilePart>? Files",
				"IReadOnlyList<bool>? Flags",
				"FilesBatchBodyMeta? Meta",
			]),
			required: record("uploads.create", "UploadsCreateBody", ["required FilePart File", "string? Note"]),
			upload: record("files.upload", "FilesUploadBody", [
				"FilePart? File",
				"string? Name",
				"IReadOnlyList<string>? Tags",
			]),
		})
	})
})

describe("generateCSharpSdk: <Op>Headers (Fc7, §2.2)", () => {
	/* ported from python/sdk.bodies.test.ts:184 */
	it("declares items.get's holder byte for byte, and types each header by its scalar: bool?, long?, double?, else string?", () => {
		expect({
			items: declOf(http(), "ItemsGetHeaders"),
			reports: declOf(filesOf(REPORTS), "ReportsGetHeaders"),
		}).toEqual({
			items: holder("items.get", "ItemsGetHeaders", [
				["string? XEtag", "X-Etag", "Text"],
				["long? XItemVersion", "X-Item-Version", "Int64", true],
			]),
			reports: holder("reports.get", "ReportsGetHeaders", [
				["long? XCount", "X-Count", "Int64"],
				["bool? XFlag", "X-Flag", "Bool"],
				["string? XMeta", "X-Meta", "Text"],
				["double? XRatio", "X-Ratio", "Double"],
				["string? XTraceId", "X-Trace-Id", "Text", true],
			]),
		})
	})

	it("declares no holder for a WebSocket or realtime op, whose 2xx no caller receives", async () => {
		const { csResponseHeaders } = await import("./sdk-answer.ts")
		const ir = toIR(STREAMED as OpenApiDocument, { deriveOperationIds: true })
		const model = sdkModel(ir)
		const env = { at: csTypeContext(ir) }
		const plan = (id: string) => csResponseHeaders(model.opsById.get(id) as SdkOp, env)?.plan ?? null
		expect({ plain: plan("plain.get"), realtime: plan("live.connect"), ws: plan("ws.subscribe") }).toEqual({
			plain: { fields: { "X-Trace": "XTrace" }, type: "PlainGetHeaders" },
			realtime: null,
			ws: null,
		})
	})
})

describe("generateCSharpSdk: what the JSON context lists (§2)", () => {
	it("lists a form body, each multipart text part's type and <Key>Data; never FilePart, BinaryBody, <Op>Body or <Op>Headers", () => {
		const types = listed(http())
		const errors = listed(filesOf(FIXTURES.errors.document()))
		const parts = ["string", "IReadOnlyList<string>", "long?", "IReadOnlyList<bool>", "FilesBatchBodyMeta"]
		const never = ["BinaryBody", "FilePart", "IReadOnlyList<FilePart>", "FilesBatchBody", "FilesUploadBody"]
		expect({
			errors: ["ItemLockedData", "Lock"].filter((type) => !errors.includes(type)),
			missing: ["FormsSubmitBody", ...parts].filter((type) => !types.includes(type)),
			unexpected: [...never, "ItemsGetHeaders", "byte[]"].filter((type) => types.includes(type)),
		}).toEqual({ errors: [], missing: [], unexpected: [] })
	})
})

/** One multipart `u.send` of `schema`, its body required or not. */
const multipart = (schema: Json, required: boolean) =>
	single("u.send", { ...DONE, requestBody: { ...content("multipart/form-data", schema), required } })

describe("generateCSharpSdk: multipart bodies at their edges", () => {
	it("guards an optional multipart body: body is null ? null : Body.Multipart(…)", () => {
		const files = filesOf(multipart({ properties: { file: BINARY }, type: "object" }, false))
		const signature = `    public Task SendAsync(USendBody? body = null, ${OPTIONS}) =>`
		expect(methodAt(classOf(files, "UResource"), signature)).toEqual([
			signature,
			'        _t.CallAsync(_send, new([], [], [], body is null ? null : Body.Multipart([Part.File("file", body.File)]), null, options), cancellationToken);',
		])
	})

	it("declares no part for a body schema that is not an object (the IR derives parts from an object alone)", () => {
		const files = filesOf(multipart({ allOf: [{ properties: { file: BINARY }, type: "object" }] }, true))
		expect(declOf(files, "USendBody")).toEqual(record("u.send", "USendBody", []))
	})
})

describe("generateCSharpSdk: an error key's body type (Fc3)", () => {
	it("names no type for a key whose schema refs a component C# declares nothing for", () => {
		const document = {
			...single(
				"x.get",
				{ ...DONE, "x-honey-errors": { "code.taken": { schema: { $ref: "#/components/schemas/Code" }, status: 409 } } },
				"get",
			),
			components: { schemas: { Code: STRING } },
		}
		const types = filesOf(document)["Types.cs"] ?? ""
		expect({
			data: /\bCodeTakenData\b/.test(types),
			remarks: types.includes("<remarks>"),
			tail: types.split("\n").slice(-5),
		}).toEqual({
			data: false,
			remarks: false,
			tail: ["public static class ErrorKey", "{", '    public const string CodeTaken = "code.taken";', "}", ""],
		})
	})
})

describe("generateCSharpSdk: names phase c claims", () => {
	it("claims a header param headersInto as headersInto2, and a namespace part as the property Part2", () => {
		const files = filesOf(NAMES)
		const signature = `    public Task<PartGetResponse> GetAsync(string? headersInto2 = null, PartGetHeaders? headersInto = null, ${OPTIONS}) =>`
		const plan = csharpCallPlans(NAMES)["part.get"]
		expect({
			accessors: plan?.accessors,
			client: classOf(files, "HoneySdkClient : IDisposable").filter((line) => line.includes("Part2")),
			headers: plan?.headers,
			method: methodAt(classOf(files, "PartResource"), signature),
		}).toEqual({
			accessors: ["Part2"],
			client: ["        Part2 = new PartResource(_t);", "    public PartResource Part2 { get; }"],
			headers: { headersInto: "headersInto2" },
			method: [
				signature,
				`        _t.CallAsync(_get, new([], [], [Arg.Of("headersInto", headersInto2, ${CONTEXT}.String)], null, null, options, headersInto is null ? null : headersInto.Read), ${CONTEXT}.PartGetResponse, cancellationToken);`,
			],
		})
	})
})
