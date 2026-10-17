/**
 * The C# call's emitted parts (contract 47 §5.13, §2): each `Operation` field gains the media type a text or binary
 * answer asks for (`Accept`) and the op's `x-invalidate` targets (`Invalidates`), and a JSON op without targets
 * keeps phase b's text; the `Call` gains the `headersInto` reader only where an op declares response headers; the
 * call plans the driver walks carry each body and answer kind, the `<Op>Headers` holder and a declared
 * `Idempotency-Key` header's own parameter; and a declared JSON media type other than `application/json` is what
 * `Body.Json` sends (Python's `body.py:76` rule). C#-only emitter text: no leg is a port (contract 47 §6).
 */
import { describe, expect, it } from "vitest"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { csharpCallPlans, generateCSharpSdk } from "./sdk.ts"

type Json = Record<string, unknown>
type Files = Readonly<Record<string, string>>

const FIELD = "    private static readonly Operation"
const CONTEXT = "HoneySdkJsonContext.Default"
/* how every public method's signature opens */
const TASK = "    public Task<"

/** A text answer that is also idempotent and invalidates: every named argument of `Operation`, in its order. */
const NOTES: Json = {
	info: { title: "Notes", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/notes/{id}": {
			put: {
				operationId: "notes.put",
				parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
				responses: { 200: { content: { "text/plain": { schema: { type: "string" } } }, description: "ok" } },
				"x-idempotency-key": true,
				"x-invalidate": ["GET /notes"],
			},
		},
	},
}

const http = (): Files => generateCSharpSdk(FIXTURES.http.document()).files
const httpSafe = (): Files => generateCSharpSdk(FIXTURES["http-safe"].document(), FIXTURES["http-safe"].options).files

/** Client.cs's class `public sealed class <name>`, through its closing brace. */
function classOf(files: Files, name: string): string[] {
	const lines = (files["Client.cs"] ?? "").split("\n")
	const start = lines.indexOf(`public sealed class ${name}`)
	return start < 0 ? [`no class ${name}`] : lines.slice(start, lines.indexOf("}", start) + 1)
}

/** The `Operation` field lines of class `name`, in order. */
const fieldsOf = (files: Files, name: string) => classOf(files, name).filter((line) => line.startsWith(FIELD))

/** The call line under the signature of class `name` that starts with `start`. */
function callOf(files: Files, name: string, start: string): string {
	const lines = classOf(files, name)
	const at = lines.findIndex((line) => line.startsWith(start))
	return at < 0 ? `no method ${start.trim()}` : (lines[at + 1] ?? "")
}

describe("generateCSharpSdk: the Operation fields (§2)", () => {
	it("adds Accept for a text or binary answer and Invalidates for x-invalidate targets, and keeps a JSON op's phase-b text", () => {
		const files = http()
		const owners = ["Docs", "Echo", "Files", "Notes", "Pages", "Text", "Users"].map((name) => `${name}Resource`)
		expect(Object.fromEntries(owners.map((name) => [name, fieldsOf(files, name)]))).toEqual({
			DocsResource: [
				`${FIELD} _get = new("GET", "/docs/{name}", ["name"], Idempotent: false, Accept: "application/pdf");`,
			],
			EchoResource: [`${FIELD} _get = new("GET", "/echo", [], Idempotent: false);`],
			FilesResource: [
				`${FIELD} _batch = new("POST", "/batch", [], Idempotent: false);`,
				`${FIELD} _get = new("GET", "/files/{name}", ["name"], Idempotent: false, Accept: "application/octet-stream");`,
				`${FIELD} _put = new("PUT", "/files/{name}", ["name"], Idempotent: false);`,
				`${FIELD} _upload = new("POST", "/upload", [], Idempotent: false);`,
			],
			NotesResource: [`${FIELD} _create = new("POST", "/notes", [], Idempotent: false, Accept: "text/plain");`],
			PagesResource: [
				`${FIELD} _a = new("GET", "/a", [], Idempotent: false);`,
				`${FIELD} _b = new("GET", "/b", [], Idempotent: false);`,
				`${FIELD} _c = new("GET", "/c", [], Idempotent: false);`,
				`${FIELD} _touch = new("POST", "/touch", [], Idempotent: false, Invalidates: ["GET /a", "GET /b", "GET /c"]);`,
			],
			TextResource: [`${FIELD} _get = new("GET", "/text", [], Idempotent: false, Accept: "text/plain");`],
			UsersResource: [
				`${FIELD} _create = new("POST", "/users", [], Idempotent: false, Invalidates: ["GET /users", "GET /users/{id}"]);`,
				`${FIELD} _delete = new("DELETE", "/users/{id}", ["id"], Idempotent: false, Invalidates: ["GET /users", "GET /users/{id}"]);`,
				`${FIELD} _get = new("GET", "/users/{id}", ["id"], Idempotent: false);`,
				`${FIELD} _list = new("GET", "/users", [], Idempotent: false);`,
			],
		})
	})

	it("writes Accept before Invalidates, after Idempotent, as Operation declares them", () => {
		expect(fieldsOf(generateCSharpSdk(NOTES).files, "NotesResource")).toEqual([
			`${FIELD} _put = new("PUT", "/notes/{id}", ["id"], Idempotent: true, Accept: "text/plain", Invalidates: ["GET /notes"]);`,
		])
	})
})

describe("generateCSharpSdk: the Call (§2)", () => {
	it("passes headersInto's Read as the seventh member where the op declares headers, in both modes, and six members elsewhere", () => {
		const files = http()
		expect({
			items: callOf(files, "ItemsResource", `${TASK}Item> GetAsync(`),
			itemsPut: callOf(files, "ItemsResource", `${TASK}ItemsPutResponse> PutAsync(`),
			itemsSafe: callOf(httpSafe(), "ItemsResource", `${TASK}SdkResult<Item>> GetAsync(`),
			users: callOf(files, "UsersResource", `${TASK}UsersGetResponse> GetAsync(`),
		}).toEqual({
			items: `        _t.CallAsync(_get, new([id], [], [], null, null, options, headersInto is null ? null : headersInto.Read), ${CONTEXT}.Item, cancellationToken);`,
			itemsPut: `        _t.CallAsync(_put, new([uuid, str], [], [], null, idempotencyKey, options), ${CONTEXT}.ItemsPutResponse, cancellationToken);`,
			itemsSafe: `        _t.ResultAsync(_get, new([id], [], [], null, null, options, headersInto is null ? null : headersInto.Read), ${CONTEXT}.Item, cancellationToken);`,
			users: `        _t.CallAsync(_get, new([id], [], [], null, null, options), ${CONTEXT}.UsersGetResponse, cancellationToken);`,
		})
	})
})

describe("csharpCallPlans: the phase-c members (§2)", () => {
	it("carries each body and answer kind, the <Op>Headers holder (null without one) and a declared Idempotency-Key header's parameter", () => {
		const plans = csharpCallPlans(FIXTURES.http.document())
		const pick = (id: string) => {
			const plan = plans[id]
			return plan === undefined
				? null
				: { body: plan.body, response: plan.response, responseHeaders: plan.responseHeaders }
		}
		expect({
			echo: pick("echo.get"),
			filesGet: pick("files.get"),
			filesPut: pick("files.put"),
			filesUpload: pick("files.upload"),
			formsSubmit: pick("forms.submit"),
			itemsGet: pick("items.get"),
			keyed: [plans["keyed.send"]?.headers, plans["keyed.send"]?.idempotencyKey],
			notesCreate: pick("notes.create"),
		}).toEqual({
			echo: { body: null, response: "json", responseHeaders: null },
			filesGet: { body: null, response: "binary", responseHeaders: null },
			filesPut: { body: { kind: "binary", param: "body" }, response: "json", responseHeaders: null },
			filesUpload: { body: { kind: "multipart", param: "body" }, response: "json", responseHeaders: null },
			formsSubmit: { body: { kind: "form", param: "body" }, response: "json", responseHeaders: null },
			itemsGet: {
				body: null,
				response: "json",
				responseHeaders: { fields: { "X-Etag": "XEtag", "X-Item-Version": "XItemVersion" }, type: "ItemsGetHeaders" },
			},
			keyed: [{ "Idempotency-Key": "idempotencyKey2", "X-Meta": "xMeta" }, "idempotencyKey"],
			notesCreate: { body: { kind: "text", param: "body" }, response: "text", responseHeaders: null },
		})
	})
})

describe("generateCSharpSdk: the declared request media type (§1 rules)", () => {
	it("passes merge.patch's application/merge-patch+json to Body.Json, and leaves application/json the default", () => {
		const files = http()
		expect({
			merge: callOf(files, "MergeResource", `${TASK}MergePatchResponse> PatchAsync(`),
			users: callOf(files, "UsersResource", `${TASK}UsersCreateResponse> CreateAsync(`),
		}).toEqual({
			merge: `        _t.CallAsync(_patch, new([], [], [], Body.Json(body, ${CONTEXT}.MergePatchBody, "application/merge-patch+json"), null, options), ${CONTEXT}.MergePatchResponse, cancellationToken);`,
			users: `        _t.CallAsync(_create, new([], [], [], Body.Json(body, ${CONTEXT}.UsersCreateBody), null, options), ${CONTEXT}.UsersCreateResponse, cancellationToken);`,
		})
	})
})
