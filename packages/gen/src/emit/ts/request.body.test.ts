import { afterEach, describe, expect, it, vi } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, unknown>
type Answer = (request: Request) => Response | Promise<Response>
type Send = (path: string, input?: Json) => Promise<unknown>
type App = { get: Send; patch: Send; post: Send; put: Send }
type Op = (input?: Json) => Promise<{ data: unknown; error: { message: string } | null; status: number }>
type Sdk = Record<"createUser" | "listUsers" | "submitForm" | "updateUser" | "upload" | "uploadFiles", Op>

const ORIGIN = "https://api.example.com"
const OK = { 200: { content: { "application/json": { schema: {} } }, description: "ok" } }
const MULTIPART = /^multipart\/form-data; boundary=/

/** Answer with the request's JSON body. */
const echoJson: Answer = async (request) => Response.json(await request.json())

/** A stand-in for the DOM's FileList, which Node lacks: indexed files and a length. */
class FakeFileList {
	readonly length: number;
	[at: number]: File
	constructor(files: readonly File[]) {
		files.forEach((file, at) => (this[at] = file))
		this.length = files.length
	}
	*[Symbol.iterator](): Iterator<File> {
		for (let at = 0; at < this.length; at++) yield this[at] as File
	}
}

/** A request body of `type` with `schema`. */
const body = (type: string, schema: Json = { type: "object" }): Json => ({ content: { [type]: { schema } } })

/** The app-front client on `ORIGIN` over a recording fetch answering `answer`, and what it sent. */
async function app(config: Json = {}, answer?: Answer): Promise<{ api: App; calls: Request[] }> {
	const { createClient } = await emittedApp()
	const { calls, fetch } = recordingFetch(answer)
	return { api: (createClient as (config: Json) => App)({ baseURL: ORIGIN, fetch, ...config }), calls }
}

/** The SDK emitted for one operation per body kind, on `ORIGIN` over a recording fetch; its module and what it sent. */
async function sdkOf(config: Json = {}): Promise<{ calls: Request[]; mod: Json; sdk: Sdk }> {
	const id = { in: "path", name: "id", required: true, schema: { type: "string" } }
	const files = {
		properties: { documents: { items: { format: "binary", type: "string" }, type: "array" } },
		type: "object",
	}
	const mod = await emittedSdk({
		info: { title: "T", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/files": {
				post: { operationId: "uploadFiles", requestBody: body("multipart/form-data", files), responses: OK },
			},
			"/forms": {
				post: { operationId: "submitForm", requestBody: body("application/x-www-form-urlencoded"), responses: OK },
			},
			"/upload": {
				post: {
					operationId: "upload",
					requestBody: body("application/octet-stream", { format: "binary", type: "string" }),
					responses: OK,
				},
			},
			"/users": {
				get: { operationId: "listUsers", responses: OK },
				post: { operationId: "createUser", requestBody: body("application/json"), responses: OK },
			},
			"/users/{id}": {
				put: { operationId: "updateUser", parameters: [id], requestBody: body("application/json"), responses: OK },
			},
		},
	})
	const { calls, fetch } = recordingFetch()
	return { calls, mod, sdk: new (mod.TestSDK as new (config: Json) => Sdk)({ baseURL: ORIGIN, fetch, ...config }) }
}

/** What a recorded request carried: method, URL, content type and body text. */
async function sent(call: Request | undefined): Promise<[string?, string?, (string | null)?, string?]> {
	return [call?.method, call?.url, call?.headers.get("content-type"), await call?.text()]
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("app front: JSON bodies", () => {
	// v0: 89e4c227ff
	// v0: b726e4d0b6
	// v0: ebc8f5482f
	// v0: 3c9897d033
	it("sends JSON as application/json on POST, PUT and PATCH, resolving the parsed answer in throw mode", async () => {
		const { api, calls } = await app({ throwOnError: true }, () => Response.json({ id: "new-1" }, { status: 201 }))
		const created = await api.post("/users", { json: { email: "a@b.com", name: "Alice" } })
		await api.put("/users/:userId", { json: { name: "Updated" }, params: { userId: "42" } })
		await api.patch("/users/:userId/settings", { json: { theme: "dark" }, params: { userId: "42" } })
		expect([created, ...(await Promise.all(calls.map(sent)))]).toEqual([
			{ id: "new-1" },
			["POST", `${ORIGIN}/users`, "application/json", '{"email":"a@b.com","name":"Alice"}'],
			["PUT", `${ORIGIN}/users/42`, "application/json", '{"name":"Updated"}'],
			["PATCH", `${ORIGIN}/users/42/settings`, "application/json", '{"theme":"dark"}'],
		])
	})

	// v0: 00ca8471e5
	// v0: b693b80aa6
	// v0: f2fdec74e4
	// v0: 95ade7fa48
	it("sends any JSON value as is: an array, null, and deeply nested objects", async () => {
		const { api, calls } = await app({ headers: { authorization: "Bearer test" } }, echoJson)
		const deep = { a: { b: { c: { d: [1, { e: "f" }] } } } }
		await api.post("/api/echo", { json: [1, 2, 3] })
		await api.post("/api/echo", { json: null })
		const echoed = await api.post("/api/v1/organizations", { json: deep })
		const texts = await Promise.all(calls.map((call) => call.text()))
		expect([texts, echoed]).toEqual([
			["[1,2,3]", "null", JSON.stringify(deep)],
			expect.objectContaining({ data: deep, error: null }),
		])
	})
})

describe("app front: form bodies", () => {
	// v0: 6524aae611
	// v0: 6ee791c145
	// v0: dbe5edc856
	// v0: 66ec3670d2
	it("url-encodes a form without files, escaping text and writing numbers and booleans as text", async () => {
		const { api, calls } = await app()
		await api.post("/login", { form: { password: "secret", username: "alice" } })
		await api.post("/api/echo", { form: { message: "hello world & goodbye", name: "O'Brien" } })
		await api.post("/api/echo", { form: { active: true, count: 42 } })
		expect(await Promise.all(calls.map(sent))).toEqual([
			["POST", `${ORIGIN}/login`, "application/x-www-form-urlencoded", "password=secret&username=alice"],
			[
				"POST",
				`${ORIGIN}/api/echo`,
				"application/x-www-form-urlencoded",
				"message=hello+world+%26+goodbye&name=O%27Brien",
			],
			["POST", `${ORIGIN}/api/echo`, "application/x-www-form-urlencoded", "active=true&count=42"],
		])
	})

	// v0: aa7ffd31ef
	it("repeats an array's key in both encodings, and rejects a nested object", async () => {
		const { api, calls } = await app()
		await api.post("/f", { form: { tags: ["a", "b"] } })
		await api.post("/f", { form: { file: new Blob(["x"]), tags: ["a", "b"] } })
		await expect(api.post("/f", { form: { nested: { a: 1 } } })).rejects.toThrow(/nested objects/)
		const [encoded, multipart] = calls
		expect([calls.length, await encoded?.text(), (await multipart?.formData())?.getAll("tags")]).toEqual([
			2,
			"tags=a&tags=b",
			["a", "b"],
		])
	})
})

describe("app front: multipart bodies", () => {
	// v0: da0703c65c
	// v0: b676fead83
	// v0: 7314ffaf02
	it("switches to multipart for a File, a Blob or a FileList, leaving the boundary to fetch", async () => {
		vi.stubGlobal("FileList", FakeFileList)
		const { api, calls } = await app({ throwOnError: true })
		await api.post("/upload", {
			form: { avatar: new File(["hello"], "test.txt", { type: "text/plain" }), name: "Alice" },
		})
		await api.post("/upload", { form: { data: new Blob(["data"], { type: "application/octet-stream" }) } })
		await api.post("/upload", {
			form: { documents: new FakeFileList([new File(["a"], "a.txt"), new File(["b"], "b.txt")]) },
		})
		const forms = await Promise.all(calls.map((call) => call.formData()))
		expect([
			calls.map((call) => MULTIPART.test(call.headers.get("content-type") ?? "")),
			[forms[0]?.get("name"), (forms[0]?.get("avatar") as File | null)?.name, forms[1]?.get("data") instanceof Blob],
			forms[2]?.getAll("documents").map((file) => (file as File).name),
		]).toEqual([
			[true, true, true],
			["Alice", "test.txt", true],
			["a.txt", "b.txt"],
		])
	})
})

describe("SDK front: empty and JSON bodies", () => {
	// v0: 03cf85ae0d
	// v0: 0410c4b18b
	it("sends no body, no content-type and no query without json or form", async () => {
		const { calls, sdk } = await sdkOf()
		await sdk.listUsers()
		expect(await sent(calls[0])).toEqual(["GET", `${ORIGIN}/users`, null, ""])
	})

	// v0: 74f3a1722d
	// v0: acac67ddaf
	// v0: 5313beeab1
	it("sends JSON as application/json on POST and PUT", async () => {
		const { calls, sdk } = await sdkOf()
		await sdk.createUser({ json: { email: "a@b.com", name: "Alice" } })
		await sdk.updateUser({ json: { name: "Updated" }, params: { id: "42" } })
		expect(await Promise.all(calls.map(sent))).toEqual([
			["POST", `${ORIGIN}/users`, "application/json", '{"email":"a@b.com","name":"Alice"}'],
			["PUT", `${ORIGIN}/users/42`, "application/json", '{"name":"Updated"}'],
		])
	})

	// v0: 4f7d2e0f61
	it("resolves an unserializable JSON body as a status-0 ClientError naming the failure, sending nothing", async () => {
		const { calls, mod, sdk } = await sdkOf()
		const result = await sdk.createUser({ json: { n: 1n } })
		expect([
			calls.length,
			result.status,
			result.error instanceof (mod.ClientError as abstract new (...args: never[]) => unknown),
			result.error?.message,
		]).toEqual([0, 0, true, expect.stringMatching(/^JSON serialization failed: /)])
	})
})

describe("SDK front: form and stream bodies", () => {
	// v0: fbb83ba637
	// v0: 2f5ceee2c0
	// v0: ce63b62f23
	it("url-encodes a form without files, skipping null and undefined and writing a Date as ISO 8601", async () => {
		const { calls, sdk } = await sdkOf()
		await sdk.submitForm({ form: { age: "30", name: "Alice" } })
		await sdk.submitForm({ form: { keep: "yes", remove1: null, remove2: undefined } })
		await sdk.submitForm({ form: { since: new Date("2026-01-01T00:00:00.000Z") } })
		expect(await Promise.all(calls.map(sent))).toEqual([
			["POST", `${ORIGIN}/forms`, "application/x-www-form-urlencoded", "age=30&name=Alice"],
			["POST", `${ORIGIN}/forms`, "application/x-www-form-urlencoded", "keep=yes"],
			["POST", `${ORIGIN}/forms`, "application/x-www-form-urlencoded", "since=2026-01-01T00%3A00%3A00.000Z"],
		])
	})

	// v0: 29f42f14b0
	it("sends a FileList as multipart, one part per file under the field's key", async () => {
		vi.stubGlobal("FileList", FakeFileList)
		const { calls, sdk } = await sdkOf()
		await sdk.uploadFiles({
			form: { documents: new FakeFileList([new File(["a"], "a.txt"), new File(["b"], "b.txt")]) },
		})
		const form = await calls[0]?.formData()
		expect([
			MULTIPART.test(calls[0]?.headers.get("content-type") ?? ""),
			form?.getAll("documents").map((file) => (file as File).name),
		]).toEqual([true, ["a.txt", "b.txt"]])
	})

	// v0: 638cf68786
	it("sends a stream body half-duplex as application/octet-stream, and an onResponse hook still gets a Request", async () => {
		let hooked: unknown
		const { calls, sdk } = await sdkOf({
			onResponse: [(ctx: { request: Request }) => void (hooked = ctx.request)],
			throwOnError: true,
		})
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]))
				controller.close()
			},
		})
		await sdk.upload({ body: stream })
		expect([
			calls[0]?.headers.get("content-type"),
			[...new Uint8Array((await calls[0]?.arrayBuffer()) ?? new ArrayBuffer(0))],
			hooked instanceof Request,
		]).toEqual(["application/octet-stream", [1, 2, 3], true])
	})
})
