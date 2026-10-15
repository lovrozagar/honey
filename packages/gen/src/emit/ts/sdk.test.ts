import { describe, expect, expectTypeOf, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"
import { runtimeSource } from "./http.ts"
import { generateSdk, sdkMemberPaths, serviceMapOf } from "./sdk.ts"

type Json = Record<string, unknown>

/** An OpenAPI 3.1 document of `paths`. */
const doc = (paths: Json): Json => ({ info: { title: "T", version: "1" }, openapi: "3.1.0", paths })

/** The IR an SDK reads: an operation without an id gets a derived one, a shared id is refused. */
const ir = (paths: Json) =>
	toIR(doc(paths) as OpenApiDocument, { deriveOperationIds: true, duplicateOperationIds: "throw" })

/** The service map as plain data: a null-prototype node compares as a literal, an undefined flag as present. */
const plain = (map: unknown): unknown => structuredClone(map)

const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }

/** An operation `operationId` answering JSON, with `extra` fields. */
const op = (operationId: string, extra: Json = {}) => ({ operationId, responses: OK, ...extra })

const USERS = {
	"/v1/users": {
		get: op("users.list"),
		post: op("users.create", { "x-invalidate": ["GET /v1/users"] }),
	},
	"/v1/users/{id}": {
		delete: op("users.delete", { "x-invalidate": ["GET /v1/users/{id}", "GET /v1/users"] }),
		get: op("users.get"),
		patch: op("users.update", { "x-invalidate": ["GET /v1/users/{id}", "GET /v1/users"] }),
	},
}

const ERRORS = { 404: { content: { "application/json": { schema: { type: "object" } } }, description: "missing" } }

/* /v1/beta before /v1/alpha: the order a document lists its paths in must not reach the output */
const ORDERED = {
	"/v1/beta": { get: op("beta.list", { responses: { ...OK, ...ERRORS } }) },
	"/v1/alpha": { get: op("alpha.list", { responses: { ...OK, ...ERRORS } }), post: op("alpha.create") },
	"/v1/projects/{project_id}/export": { post: op("project.export", { responses: { 200: { description: "ok" } } }) },
	"/v1/extract": { post: op("extract") },
}

describe("generateSdk: the emitted file set", () => {
	// v0: 3756d467b1
	it("emits the client, map, types, runtime and index files under the stem, none empty, the runtime verbatim", () => {
		const { files, stem } = generateSdk(doc(USERS), { name: "MockSDK", stem: "mock" })
		expect([stem, generateSdk(doc(USERS), { name: "TestSDK" }).stem]).toEqual(["mock", "test-sdk"])
		expect(Object.keys(files).sort()).toEqual([
			"mock.client.gen.ts",
			"mock.index.gen.ts",
			"mock.map.gen.ts",
			"mock.runtime.gen.ts",
			"mock.types.gen.ts",
		])
		expect(Object.values(files).filter((text) => text.length === 0)).toEqual([])
		expect(files["mock.runtime.gen.ts"]).toContain(runtimeSource())
	})

	// v0: 4aff94fcf0
	it("returns each file's text by its name, and the stem", () => {
		const result = generateSdk(doc(USERS), { name: "TestSDK" })
		expectTypeOf(result.files).toMatchTypeOf<Readonly<Record<string, string>>>()
		expectTypeOf(result.stem).toEqualTypeOf<string>()
		expect(Object.values(result.files).map((text) => typeof text)).toEqual(Array(5).fill("string"))
	})

	// v0: 17bd5beace
	it("emits byte-identical files from one document twice", () => {
		expect(generateSdk(doc(ORDERED), { name: "TestSDK" }).files).toEqual(
			generateSdk(doc(ORDERED), { name: "TestSDK" }).files,
		)
	})

	// v0: 9e6f63457d
	it("emits byte-identical files whatever order the document lists its paths in", () => {
		const reordered = Object.fromEntries(Object.entries(ORDERED).toReversed())
		expect(generateSdk(doc(reordered), { name: "TestSDK" }).files).toEqual(
			generateSdk(doc(ORDERED), { name: "TestSDK" }).files,
		)
	})
})

describe("serviceMapOf: each operation's method, path, params and invalidation targets", () => {
	// v0: 4b482616ef
	// v0: 1cf93ccfb0
	it("holds every action of a resource with its own method, path and path params", () => {
		const users = (plain(serviceMapOf(ir(USERS))) as Record<string, Record<string, Json>>).users ?? {}
		expect(Object.keys(users).sort()).toEqual(["create", "delete", "get", "list", "update"])
		expect(
			Object.fromEntries(
				Object.entries(users).map(([action, { method, params, path }]) => [action, { method, params, path }]),
			),
		).toEqual({
			create: { method: "POST", path: "/v1/users" },
			delete: { method: "DELETE", params: ["id"], path: "/v1/users/{id}" },
			get: { method: "GET", params: ["id"], path: "/v1/users/{id}" },
			list: { method: "GET", path: "/v1/users" },
			update: { method: "PATCH", params: ["id"], path: "/v1/users/{id}" },
		})
	})

	// v0: c6a112aebd
	// v0: 9f37daaa06
	// v0: 2b3e2ca251
	it("carries every x-invalidate target in order, and no invalidate key without one", () => {
		const users = (plain(serviceMapOf(ir(USERS))) as Record<string, Record<string, Json>>).users ?? {}
		expect(Object.fromEntries(Object.entries(users).map(([action, entry]) => [action, entry.invalidate]))).toEqual({
			create: ["GET /v1/users"],
			delete: ["GET /v1/users/{id}", "GET /v1/users"],
			get: undefined,
			list: undefined,
			update: ["GET /v1/users/{id}", "GET /v1/users"],
		})
		expect([Object.hasOwn(users.list ?? {}, "invalidate"), Object.hasOwn(users.get ?? {}, "invalidate")]).toEqual([
			false,
			false,
		])
	})
})

describe("serviceMapOf: stream kinds and nesting by dotted id", () => {
	// v0: 3a1c5d25a9
	// v0: c03f1e4abc
	// v0: 31dc6b47c5
	// v0: 03c352c0e8
	it("flags an SSE, WebSocket or realtime operation with its own stream kind only, path params kept", () => {
		const SSE = { 200: { content: { "text/event-stream": { schema: { type: "string" } } }, description: "ok" } }
		const map = serviceMapOf(
			ir({
				"/items": { get: op("items.list") },
				"/rt/feed": { get: { operationId: "rt.feed", responses: {}, "x-realtime": true } },
				"/stream": { get: op("events.stream", { responses: SSE }) },
				"/ws/chat/{channelId}": { get: { operationId: "ws.chat", responses: {}, "x-websocket": true } },
				"/ws/echo": { get: { operationId: "ws.echo", responses: {}, "x-websocket": true } },
			}),
		)
		expect(plain(map)).toStrictEqual({
			events: { stream: { method: "GET", path: "/stream", sse: true } },
			items: { list: { method: "GET", path: "/items" } },
			rt: { feed: { method: "GET", path: "/rt/feed", realtime: true } },
			ws: {
				chat: { method: "GET", params: ["channelId"], path: "/ws/chat/{channelId}", ws: true },
				echo: { method: "GET", path: "/ws/echo", ws: true },
			},
		})
	})

	// v0: 23755479e3
	it("nests a dotted id's segments, mixing depths, with a single-segment id at the root", () => {
		const map = serviceMapOf(
			ir({
				"/checkout/sessions": { post: op("checkout.sessions.create") },
				"/status": { get: op("getStatus") },
				"/users": { get: op("users.list") },
				"/users/{id}/profile": { patch: op("users.profile.update") },
			}),
		)
		expect(plain(map)).toStrictEqual({
			checkout: { sessions: { create: { method: "POST", path: "/checkout/sessions" } } },
			getStatus: { method: "GET", path: "/status" },
			users: {
				list: { method: "GET", path: "/users" },
				profile: { update: { method: "PATCH", params: ["id"], path: "/users/{id}/profile" } },
			},
		})
	})

	// v0: 9891434b40
	it("never drops a WebSocket operation without an operationId: it lands under a derived name", async () => {
		const paths = { "/ws/internal": { get: { responses: {}, "x-websocket": true } } }
		expect(plain(serviceMapOf(ir(paths)))).toStrictEqual({
			getWsInternal: { method: "GET", path: "/ws/internal", ws: true },
		})
		const { TestSDK } = (await emittedSdk(doc(paths))) as unknown as { TestSDK: new (config: Json) => Json }
		const sdk = new TestSDK({ baseURL: "https://api.example.com", fetch: recordingFetch().fetch })
		expect(typeof sdk.getWsInternal).toBe("function")
	})
})

describe("sdkMemberPaths: where each operation sits on the client", () => {
	// v0: 591db32764
	it("feeds the service map and the member paths from one IR, renaming a resource that shadows a client member", () => {
		const tree = ir({ "/state": { get: op("state.get") }, "/users/{id}": { get: { responses: OK } } })
		const paths = sdkMemberPaths(tree)
		expect(Object.fromEntries(paths)).toEqual({ getUsersById: ["getUsersById"], "state.get": ["state_", "get"] })
		/* following an operation's member path through the service map reaches that operation's entry */
		const map = plain(serviceMapOf(tree)) as Json
		const at = (path: string[]) => path.reduce<unknown>((node, key) => (node as Json | undefined)?.[key], map)
		expect(Object.keys(map).sort()).toEqual(["getUsersById", "state_"])
		expect(Object.fromEntries([...paths].map(([id, path]) => [id, at(path)]))).toEqual({
			getUsersById: { method: "GET", params: ["id"], path: "/users/{id}" },
			"state.get": { method: "GET", path: "/state" },
		})
	})
})

describe("generateSdk: names it refuses, and renames that collide", () => {
	it("refuses a class name that is not an identifier and a stem that is not a plain file name", () => {
		expect(() => generateSdk(doc(USERS), { name: "Not-An-Id" })).toThrow(/is not a TypeScript identifier/)
		expect(() => generateSdk(doc(USERS), { name: "TestSDK", stem: "../x" })).toThrow(/must be a plain file name/)
	})

	it("renames a shadowing member past a name the document already uses", () => {
		const tree = ir({ "/a": { get: op("state.get") }, "/b": { get: op("state_.list") } })
		expect(Object.fromEntries(sdkMemberPaths(tree))).toEqual({
			"state.get": ["state__", "get"],
			"state_.list": ["state_", "list"],
		})
	})
})
