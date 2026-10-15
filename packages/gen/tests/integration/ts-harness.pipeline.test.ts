import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { emittedSdk } from "../../src/emit/ts/__fixtures__/emitted.ts"
import { type ReferenceApp, startReferenceApp } from "./conformance/harness.ts"

type Json = Record<string, unknown>
/** A safe-mode answer: `error` is the server's envelope on a non-2xx. */
type Result = { data: unknown; error: Json | null; response: Response; status: number }
type Call = (input?: Json) => Promise<Result>
/** A member of the SDK: an operation, a namespace of members, or both. */
type Member = Call & { readonly [key: string]: Member }
type Sdk = Readonly<Record<string, Member>>

const VALID = { Authorization: "Bearer valid-token" }
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"]

let app: ReferenceApp | undefined
let emitted: Record<string, unknown> = {}

beforeAll(async () => {
	app = await startReferenceApp()
	emitted = await emittedSdk(app.document, { name: "HarnessSDK" })
}, 60_000)

afterAll(async () => {
	await app?.stop()
})

/** The running reference app. */
function live(): ReferenceApp {
	if (!app) throw new Error("the reference app did not start")
	return app
}

/** A safe-mode HarnessSDK on the app's primary origin. */
const client = (config: Json = {}): Sdk =>
	new (emitted.HarnessSDK as new (config: Json) => Sdk)({ baseURL: live().url, ...config })

/** Every operationId the app's served document declares. */
function operationIds(document: Json): string[] {
	const paths = Object.values((document.paths ?? {}) as Record<string, Json>)
	return paths.flatMap((item) =>
		METHODS.map((method) => (item[method] as Json | undefined)?.operationId).filter((id) => typeof id === "string"),
	) as string[]
}

/** The member of `sdk` at the dotted `path`. */
const memberAt = (sdk: Sdk, path: string): unknown =>
	path.split(".").reduce<Member | undefined>((node, key) => node?.[key], sdk as Member)

/** A result's status, data and error key, the shape most cases compare. */
const outcome = (result: Result) => ({
	data: result.data,
	errorKey: result.error?.error_key ?? null,
	status: result.status,
})

describe("document → SDK", () => {
	// v0: 7765198c03
	it("exposes every operationId of the served document as a function at its dotted path", () => {
		const sdk = client()
		const ids = operationIds(live().document)
		expect(ids).toEqual(
			expect.arrayContaining(["users.list", "users.get", "users.create", "users.update", "users.delete"]),
		)
		expect(ids.filter((id) => typeof memberAt(sdk, id) !== "function")).toEqual([])
	})

	// v0: 5155f73584
	// v0: 609a6a675a
	it("lists, gets, creates, updates and deletes users, each answering parsed data; delete gives null data and error", async () => {
		const { users } = client({ headers: VALID })
		const list = await users.list()
		const created = await users.create({ json: { email: "bob@test.com", name: "Bob" } })
		const user = created.data as Json
		const got = await users.get({ params: { id: user.id } })
		const updated = await users.update({ json: { name: "Bob Updated" }, params: { id: user.id } })
		const deleted = await users.delete({ params: { id: user.id } })
		expect(list.data).toEqual(expect.arrayContaining([expect.objectContaining({ email: "taken@example.com" })]))
		expect([created, got, updated, deleted].map(outcome)).toEqual([
			{
				data: { email: "bob@test.com", id: expect.stringMatching(/^user-/), name: "Bob" },
				errorKey: null,
				status: 201,
			},
			{ data: user, errorKey: null, status: 200 },
			{ data: { ...user, name: "Bob Updated" }, errorKey: null, status: 200 },
			{ data: null, errorKey: null, status: 204 },
		])
		expect([list.error, deleted.error]).toEqual([null, null])
	})

	// v0: 7a9e017143
	it("creates, reads and deletes a user, after which it is gone (404)", async () => {
		const { users } = client({ headers: VALID })
		const created = await users.create({ json: { email: "life@test.com", name: "Lifecycle" } })
		const id = (created.data as Json).id
		const read = await users.get({ params: { id } })
		const deleted = await users.delete({ params: { id } })
		const gone = await users.get({ params: { id } })
		expect([created, read, deleted, gone].map((result) => [result.status, result.error === null])).toEqual([
			[201, true],
			[200, true],
			[204, true],
			[404, false],
		])
		expect(read.data).toEqual(created.data)
	})
})

describe("document → SDK: one call each", () => {
	// v0: 908e699934
	it("sends a JSON body and reads the created id", async () => {
		const result = await client({ headers: VALID }).users.create({ json: { email: "alice@test.com", name: "Alice" } })
		expect(outcome(result)).toEqual({
			data: { email: "alice@test.com", id: expect.stringMatching(/^user-\d+$/), name: "Alice" },
			errorKey: null,
			status: 201,
		})
	})

	// v0: a62b942bd4
	it("calls a route that takes no input", async () => {
		expect(outcome(await client().ping())).toEqual({ data: { ping: "pong" }, errorKey: null, status: 200 })
	})

	// v0: 659a3bd4c7
	it("sends path params with a JSON body; the app answers both", async () => {
		const { users } = client({ headers: VALID })
		const id = ((await users.create({ json: { email: "p@test.com", name: "Params" } })).data as Json).id
		const updated = await users.update({ json: { name: "Updated" }, params: { id } })
		expect(updated.data).toEqual({ email: "p@test.com", id, name: "Updated" })
	})

	// v0: 205a07c287
	it("resolves a 204 delete with null data and null error", async () => {
		const { users } = client({ headers: VALID })
		const id = ((await users.create({ json: { email: "d@test.com", name: "Doomed" } })).data as Json).id
		const deleted = await users.delete({ params: { id } })
		expect([deleted.data, deleted.error, deleted.status]).toEqual([null, null, 204])
	})

	// v0: 723ebdf457
	it("resolves parallel calls (text 200, JSON 200, 404) independently", async () => {
		const sdk = client({ headers: VALID })
		const [health, echo, missing] = await Promise.all([
			sdk.health(),
			sdk.echo.get(),
			sdk.users.get({ params: { id: "nope" } }),
		])
		expect([health, echo, missing].map(outcome)).toEqual([
			{ data: "ok", errorKey: null, status: 200 },
			{ data: { method: "GET", requestId: expect.any(String) }, errorKey: null, status: 200 },
			{ data: null, errorKey: "not_found", status: 404 },
		])
	})
})

describe("safe-mode errors", () => {
	// v0: 013547b50a
	// v0: cb37ed933b
	it("returns a framework validation failure as data null, status 400, validation_failed", async () => {
		const sdk = client()
		const short = await sdk.validated.create({ json: { name: "ab" } })
		const missing = await sdk.validated.create({ json: {} })
		expect([short, missing].map(outcome)).toEqual([
			{ data: null, errorKey: "validation_failed", status: 400 },
			{ data: null, errorKey: "validation_failed", status: 400 },
		])
	})

	// v0: e77953a398
	it("returns a thrown HoneyError 404 as data null, status 404, not_found", async () => {
		const result = await client({ headers: VALID }).users.get({ params: { id: "user-999999" } })
		expect(outcome(result)).toEqual({ data: null, errorKey: "not_found", status: 404 })
	})

	// v0: dad9e61b35
	it("returns a handler's invalid_input 400 with a field error per missing field", async () => {
		const result = await client({ headers: VALID }).users.create({ json: {} })
		expect(outcome(result)).toEqual({ data: null, errorKey: "invalid_input", status: 400 })
		expect(Object.keys((result.error?.fields ?? {}) as Json).sort()).toEqual(["email", "name"])
	})

	// v0: f50cd92188
	it("returns a declared custom error key (409 email_taken)", async () => {
		const result = await client({ headers: VALID }).users.create({ json: { email: "taken@example.com", name: "Dupe" } })
		expect(outcome(result)).toEqual({ data: null, errorKey: "email_taken", status: 409 })
	})

	// v0: 0d8a347568
	it("returns the default boundary's 500 api_error; the formatter's field reads from the response too", async () => {
		const result = await client().boundary.default()
		expect(outcome(result)).toEqual({ data: null, errorKey: "api_error", status: 500 })
		expect([result.error?.request_id, ((await result.response.json()) as Json).request_id]).toEqual([
			"conformance",
			"conformance",
		])
	})

	// v0: 79bc430386
	it("returns a route boundary's key and status (403 limit_reached)", async () => {
		expect(outcome(await client().boundary.custom())).toEqual({ data: null, errorKey: "limit_reached", status: 403 })
	})

	// v0: fb79adaaf7
	it("localizes the error message by a per-call Accept-Language", async () => {
		const { users } = client()
		const de = await users.list({ headers: { "accept-language": "de" } })
		const en = await users.list({ headers: { "accept-language": "en" } })
		expect([outcome(de), outcome(en)]).toEqual([
			{ data: null, errorKey: "unauthorized", status: 401 },
			{ data: null, errorKey: "unauthorized", status: 401 },
		])
		expect([typeof de.error?.message, de.error?.message === en.error?.message]).toEqual(["string", false])
	})
})
