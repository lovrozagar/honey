import { inspect } from "node:util"
import { describe, expect, it } from "vitest"
import { emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, unknown>

/** A member of the SDK as the proxy serves it: a method, a namespace of members, or neither. */
type Member = ((input?: Json) => Promise<unknown>) & { readonly [key: string]: Member }

type Sdk = { readonly [key: string]: Member }

const BASE = "https://api.example.com"

/** An OpenAPI 3.1 document of `paths`. */
const doc = (paths: Json): Json => ({ info: { title: "T", version: "1" }, openapi: "3.1.0", paths })

const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const ID = [{ in: "path", name: "id", required: true, schema: { type: "string" } }]
const JSON_BODY = { content: { "application/json": { schema: { type: "object" } } } }

/** An operation `operationId` answering JSON, with `extra` fields. */
const op = (operationId: string, extra: Json = {}) => ({ operationId, responses: OK, ...extra })

const DOC = doc({
	"/checkout/sessions": { post: op("checkout.sessions.create", { requestBody: JSON_BODY }) },
	"/class/from": { get: op("class.from") },
	"/items": { get: op("items.list") },
	"/status": { get: op("getStatus") },
	"/users": { get: op("users.list"), post: op("users.create", { requestBody: JSON_BODY }) },
	"/users/{id}": {
		delete: op("users.remove", { parameters: ID }),
		get: op("users.get", { parameters: ID }),
		put: op("users.replace", { parameters: ID, requestBody: JSON_BODY }),
	},
	"/users/{id}/profile": { patch: op("users.profile.update", { parameters: ID, requestBody: JSON_BODY }) },
})

/** A fresh `TestSDK` over `document` whose fetch records each request and answers with `answer`. */
async function client(answer?: (request: Request) => Response, config: Json = {}, document = DOC) {
	const { TestSDK } = (await emittedSdk(document)) as unknown as { TestSDK: new (config: Json) => Sdk }
	const { calls, fetch } = recordingFetch(answer)
	return { calls, sdk: new TestSDK({ baseURL: BASE, fetch, ...config }) }
}

/** The member at the dotted `path`. */
const memberAt = (sdk: Sdk, path: string): Member =>
	path.split(".").reduce<Member>((node, key) => node[key] as Member, sdk as unknown as Member)

const USERS = [{ id: "1", name: "Alice" }]

describe("the SDK class: member reads", () => {
	// v0: fbc48ed932
	it("reads resource.action as a function", async () => {
		const { sdk } = await client()
		expect(typeof sdk.users.list).toBe("function")
	})

	// v0: 09cf3dc6e9
	// v0: 3180c3051e
	it("returns the same namespace object on every read", async () => {
		const { sdk } = await client()
		expect([sdk.users === sdk.users, sdk.checkout.sessions === sdk.checkout.sessions]).toEqual([true, true])
	})

	// v0: 2c8db7fc33
	// v0: 17d05410c7
	// v0: b4610e7f97
	it("returns the same function for a member on every read, a distinct one per action", async () => {
		const { sdk } = await client()
		const users = sdk.users as Member
		expect([
			users.list === users.list,
			users.create === users.create,
			users.list === users.create,
			memberAt(sdk, "checkout.sessions.create") === memberAt(sdk, "checkout.sessions.create"),
		]).toEqual([true, true, false, true])
	})

	// v0: 65860cd7af
	it("names each method by its dotted member path, for stack traces", async () => {
		const { sdk } = await client()
		expect(["users.list", "checkout.sessions.create", "getStatus"].map((path) => memberAt(sdk, path).name)).toEqual([
			"users.list",
			"checkout.sessions.create",
			"getStatus",
		])
	})
})

describe("the SDK class: keys that are not operations", () => {
	// v0: 6d397517f4
	// v0: 910422df4f
	// v0: df0bf121a6
	it("reads an unknown resource, action or nested key as undefined, without a request", async () => {
		const { calls, sdk } = await client()
		const users = sdk.users as Member
		expect([sdk.nonexistent, users.nonExistentAction, sdk.checkout.sessions.nope, calls.length]).toEqual([
			undefined,
			undefined,
			undefined,
			0,
		])
	})

	// v0: cb5cea8fec
	it("reads a symbol key on a namespace through to the object, never dispatching it", async () => {
		const { calls, sdk } = await client()
		const users = sdk.users as unknown as Record<symbol, unknown>
		expect([users[Symbol.toPrimitive], users[Symbol.iterator], String(users), typeof inspect(users)]).toEqual([
			undefined,
			undefined,
			"[object Object]",
			"string",
		])
		expect(calls).toEqual([])
	})

	// v0: cd6eaa50f7
	it("keeps state, dispose and String(sdk) when resources are named like them, and is not a thenable", async () => {
		const shadowing = doc({
			"/d": { post: op("dispose") },
			"/s": { get: op("state.get") },
			"/t": { get: op("then.run") },
			"/u": { get: op("toString") },
		})
		const { calls, sdk } = await client(undefined, { state: { a: 1 } }, shadowing)
		expect([sdk.state, typeof sdk.dispose, String(sdk), (sdk as { then?: unknown }).then]).toEqual([
			{ a: 1 },
			"function",
			"[object TestSDK]",
			undefined,
		])
		await memberAt(sdk, "state_.get")()
		expect([calls.map((r) => r.url), String(memberAt(sdk, "then_"))]).toEqual([[`${BASE}/s`], "[object Object]"])
	})

	// v0: a42bc08c59
	it("prints the SDK as [object <SdkName>] and is not a thenable", async () => {
		const { calls, sdk } = await client()
		expect([String(sdk), Object.prototype.toString.call(sdk), (await Promise.resolve(sdk)) === sdk]).toEqual([
			"[object TestSDK]",
			"[object TestSDK]",
			true,
		])
		expect(calls).toEqual([])
	})
})

describe("the SDK class: dispatch by depth", () => {
	// v0: 02dcb366aa
	it("walks a three-segment id through an intermediate namespace object to a POST", async () => {
		const { calls, sdk } = await client()
		expect(typeof sdk.checkout.sessions).toBe("object")
		await memberAt(sdk, "checkout.sessions.create")({ json: { x: 1 } })
		expect(await Promise.all(calls.map(async (r) => [r.method, r.url, await r.text()]))).toEqual([
			["POST", `${BASE}/checkout/sessions`, '{"x":1}'],
		])
	})

	// v0: 5679611da9
	it("dispatches mixed depths under one namespace", async () => {
		const { calls, sdk } = await client()
		await memberAt(sdk, "users.list")()
		await memberAt(sdk, "users.profile.update")({ json: {}, params: { id: "42" } })
		expect(calls.map((r) => [r.method, r.url])).toEqual([
			["GET", `${BASE}/users`],
			["PATCH", `${BASE}/users/42/profile`],
		])
	})

	// v0: 99b4d567dc
	it("dispatches several resources on one instance, each to its own path", async () => {
		const { calls, sdk } = await client()
		await memberAt(sdk, "users.list")()
		await memberAt(sdk, "items.list")()
		expect(calls.map((r) => r.url)).toEqual([`${BASE}/users`, `${BASE}/items`])
	})
})

describe("the SDK class: requests", () => {
	it.each([
		// v0: 75b9a8ea5c
		["users.get", { params: { id: "42" } }, "GET", `${BASE}/users/42`],
		// v0: 4902d4b3e6
		["users.replace", { json: { name: "x" }, params: { id: "5" } }, "PUT", `${BASE}/users/5`],
		// v0: 925913ea83
		["users.remove", { params: { id: "7" } }, "DELETE", `${BASE}/users/7`],
		// v0: 3488271ac5
		["items.list", undefined, "GET", `${BASE}/items`],
		// v0: e2e9f05514
		["getStatus", undefined, "GET", `${BASE}/status`],
		// v0: b92e3bdd01
		["class.from", {}, "GET", `${BASE}/class/from`],
	])("%s sends one request with its method to its path", async (path, input, method, url) => {
		const { calls, sdk } = await client()
		await memberAt(sdk, path)(input)
		expect(calls.map((r) => [r.method, r.url])).toEqual([[method, url]])
	})

	// v0: 2ac01f0fbe
	it("sends a bodiless request to base and path when called with no argument", async () => {
		const { calls, sdk } = await client()
		await memberAt(sdk, "users.list")()
		expect(calls.map((r) => [r.method, r.url, r.body])).toEqual([["GET", `${BASE}/users`, null]])
	})

	// v0: 33e1e5e77f
	it("resolves a safe call to { data, error: null, status, response } after one fetch", async () => {
		const { calls, sdk } = await client(() => Response.json(USERS))
		const { response, ...result } = (await memberAt(sdk, "users.list")()) as Json
		expect([calls.length, result, response instanceof Response]).toEqual([
			1,
			{ data: USERS, error: null, status: 200 },
			true,
		])
	})

	// v0: 3a82494215
	it("resolves a throwOnError call with the response data", async () => {
		const { sdk } = await client(() => Response.json(USERS), { throwOnError: true })
		expect(await memberAt(sdk, "users.list")()).toEqual(USERS)
	})

	// v0: b32bb9e005
	it("sends a json input as a JSON body with its content type, and resolves the parsed answer", async () => {
		const answer = { email: "a@b.com", id: "u1" }
		const { calls, sdk } = await client(() => Response.json(answer), { throwOnError: true })
		const result = await memberAt(sdk, "users.create")({ json: { email: "test@example.com" } })
		expect(
			await Promise.all(
				calls.map(async (r) => [r.url, r.method, await r.text(), r.headers.get("content-type")] as const),
			),
		).toEqual([[`${BASE}/users`, "POST", JSON.stringify({ email: "test@example.com" }), "application/json"]])
		expect(result).toEqual(answer)
	})
})
