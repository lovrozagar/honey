import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { emittedSdk } from "../../src/emit/ts/__fixtures__/emitted.ts"
import type { ClientError } from "../../src/runtime/ts/error.ts"
import type { Result as RuntimeResult } from "../../src/runtime/ts/response.ts"
import { type ReferenceApp, startReferenceApp } from "./conformance/harness.ts"

type Json = Record<string, unknown>
/**
 * The emitted SDK is untyped here (generated from the served document at run time), so its answers are typed by the
 * runtime's own declarations, never a shape of this file's: a change to the runtime's answer reds typecheck.
 */
type ApiError = ClientError<Json | null>
/** A safe call's answer (bit 21 i1): its data, or the error the normal call would throw; the response on both. */
type Result = RuntimeResult<unknown>
type Call<T> = (input?: Json) => Promise<T>
/** A member of the SDK: an operation, a namespace of members, or both. */
type Member<T> = Call<T> & { readonly [key: string]: Member<T> }
/** The SDK: its operations answering the value (and throwing an error status), its safe twin's answering a Result. */
type Sdk = Readonly<Record<string, Member<Json>>> & { readonly safe: Readonly<Record<string, Member<Result>>> }

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

/** A HarnessSDK on the app's primary origin. */
const client = (config: Json = {}): Sdk =>
	new (emitted.HarnessSDK as new (config: Json) => Sdk)({ baseURL: live().url, ...config })

/** A HarnessSDK whose every answer's status is recorded, in order: a normal call answers only its value. */
function recorded(config: Json = {}): { sdk: Sdk; statuses: number[] } {
	const statuses: number[] = []
	const seen = (ctx: { response: Response }) => void statuses.push(ctx.response.status)
	return { sdk: client({ ...config, onResponse: [seen] }), statuses }
}

/** What a normal call threw: its class's name, status and error key. */
const thrown = (promise: Promise<unknown>) =>
	promise.then(
		(value) => ({ value }),
		(e: ApiError) => ({ errorKey: e.body?.error_key ?? null, name: e.name, status: e.status }),
	)

/** Every operationId the app's served document declares. */
function operationIds(document: Json): string[] {
	const paths = Object.values((document.paths ?? {}) as Record<string, Json>)
	return paths.flatMap((item) =>
		METHODS.map((method) => (item[method] as Json | undefined)?.operationId).filter((id) => typeof id === "string"),
	) as string[]
}

/** The member of `root` at the dotted `path`. */
const memberAt = (root: object, path: string): unknown =>
	path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], root)

/**
 * A safe call's Err as most cases compare it: the error's class's name, its status and key, the response's status;
 * an Ok fails the case.
 */
function errOf(result: Result) {
	if (result.ok) throw new Error(`expected an Err, got an Ok at ${result.response.status}`)
	const { error, response } = result
	const key = (error.body as Json | null)?.error_key ?? null
	return { errorKey: key, name: error.name, response: response.status, status: error.status }
}

/** An Err's envelope; an Ok fails the case. */
function envelopeOf(result: Result): Json {
	if (result.ok) throw new Error(`expected an Err, got an Ok at ${result.response.status}`)
	return result.error.body as Json
}

describe("document → SDK", () => {
	// v0: 7765198c03
	it("exposes every operationId of the served document as a function at its dotted path, on its safe twin too", () => {
		const sdk = client()
		const ids = operationIds(live().document)
		expect(ids).toEqual(
			expect.arrayContaining(["users.list", "users.get", "users.create", "users.update", "users.delete"]),
		)
		expect(ids.filter((id) => typeof memberAt(sdk, id) !== "function")).toEqual([])
		expect(ids.filter((id) => typeof memberAt(sdk.safe, id) !== "function")).toEqual([])
	})

	// v0: 5155f73584
	// v0: 609a6a675a
	it("lists, gets, creates, updates and deletes users, each answering parsed data; delete answers null", async () => {
		const { sdk, statuses } = recorded({ headers: VALID })
		const { users } = sdk
		const list = await users.list()
		const user = await users.create({ json: { email: "bob@test.com", name: "Bob" } })
		const got = await users.get({ params: { id: user.id } })
		const updated = await users.update({ json: { name: "Bob Updated" }, params: { id: user.id } })
		const deleted = await users.delete({ params: { id: user.id } })
		expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ email: "taken@example.com" })]))
		expect([user, got, updated, deleted]).toEqual([
			{ email: "bob@test.com", id: expect.stringMatching(/^user-/), name: "Bob" },
			user,
			{ ...user, name: "Bob Updated" },
			null,
		])
		expect(statuses).toEqual([200, 201, 200, 200, 204])
	})

	// v0: 7a9e017143
	it("creates, reads and deletes a user, after which it is gone (404)", async () => {
		const { sdk, statuses } = recorded({ headers: VALID })
		const { users } = sdk
		const created = await users.create({ json: { email: "life@test.com", name: "Lifecycle" } })
		const read = await users.get({ params: { id: created.id } })
		await users.delete({ params: { id: created.id } })
		const gone = await thrown(users.get({ params: { id: created.id } }))
		expect([statuses, read, gone]).toEqual([
			[201, 200, 204, 404],
			created,
			{ errorKey: "not_found", name: "NotFoundError", status: 404 },
		])
	})
})

describe("document → SDK: one call each", () => {
	// v0: 908e699934
	it("sends a JSON body and reads the created id", async () => {
		const { sdk, statuses } = recorded({ headers: VALID })
		const created = await sdk.users.create({ json: { email: "alice@test.com", name: "Alice" } })
		expect([created, statuses]).toEqual([
			{ email: "alice@test.com", id: expect.stringMatching(/^user-\d+$/), name: "Alice" },
			[201],
		])
	})

	// v0: a62b942bd4
	it("calls a route that takes no input", async () => {
		const { sdk, statuses } = recorded()
		expect([await sdk.ping(), statuses]).toEqual([{ ping: "pong" }, [200]])
	})

	// v0: 659a3bd4c7
	it("sends path params with a JSON body; the app answers both", async () => {
		const { users } = client({ headers: VALID })
		const { id } = await users.create({ json: { email: "p@test.com", name: "Params" } })
		const updated = await users.update({ json: { name: "Updated" }, params: { id } })
		expect(updated).toEqual({ email: "p@test.com", id, name: "Updated" })
	})

	// v0: 205a07c287
	it("resolves a 204 delete with null", async () => {
		const { sdk, statuses } = recorded({ headers: VALID })
		const { id } = await sdk.users.create({ json: { email: "d@test.com", name: "Doomed" } })
		expect([await sdk.users.delete({ params: { id } }), statuses]).toEqual([null, [201, 204]])
	})

	// v0: 723ebdf457
	it("resolves parallel calls (text 200, JSON 200, 404) independently", async () => {
		const { sdk, statuses } = recorded({ headers: VALID })
		const [health, echo, missing] = await Promise.all([
			sdk.health(),
			sdk.echo.get(),
			thrown(sdk.users.get({ params: { id: "nope" } })),
		])
		expect([health, echo, missing, statuses.toSorted()]).toEqual([
			"ok",
			{ method: "GET", requestId: expect.any(String) },
			{ errorKey: "not_found", name: "NotFoundError", status: 404 },
			[200, 200, 404],
		])
	})
})

describe("the safe twin's errors (bit 21 i1: an Err holding the error the normal call throws)", () => {
	// v0: 013547b50a
	// v0: cb37ed933b
	it("answers a framework validation failure as an Err: 400, validation_failed", async () => {
		const { validated } = client().safe
		const short = await validated.create({ json: { name: "ab" } })
		const missing = await validated.create({ json: {} })
		const failed = { errorKey: "validation_failed", name: "BadRequestError", response: 400, status: 400 }
		expect([short, missing].map(errOf)).toEqual([failed, failed])
	})

	// v0: e77953a398
	it("answers a thrown HoneyError 404 as an Err: 404, not_found", async () => {
		const result = await client({ headers: VALID }).safe.users.get({ params: { id: "user-999999" } })
		expect(errOf(result)).toEqual({ errorKey: "not_found", name: "NotFoundError", response: 404, status: 404 })
	})

	// v0: dad9e61b35
	it("answers a handler's invalid_input 400 with a field error per missing field", async () => {
		const result = await client({ headers: VALID }).safe.users.create({ json: {} })
		expect(errOf(result)).toEqual({ errorKey: "invalid_input", name: "BadRequestError", response: 400, status: 400 })
		expect(Object.keys((envelopeOf(result).fields ?? {}) as Json).sort()).toEqual(["email", "name"])
	})

	// v0: f50cd92188
	it("answers a declared custom error key (409 email_taken)", async () => {
		const result = await client({ headers: VALID }).safe.users.create({
			json: { email: "taken@example.com", name: "Dupe" },
		})
		expect(errOf(result)).toEqual({ errorKey: "email_taken", name: "ConflictError", response: 409, status: 409 })
	})
})

describe("the safe twin's errors at a boundary and in a locale (bit 21 i1)", () => {
	// v0: 0d8a347568
	it("answers the default boundary's 500 api_error; the formatter's field reads from the response too", async () => {
		const result = await client().safe.boundary.default()
		expect(errOf(result)).toEqual({ errorKey: "api_error", name: "InternalServerError", response: 500, status: 500 })
		expect([envelopeOf(result).request_id, ((await result.response.json()) as Json).request_id]).toEqual([
			"conformance",
			"conformance",
		])
	})

	// v0: 79bc430386
	it("answers a route boundary's key and status (403 limit_reached)", async () => {
		expect(errOf(await client().safe.boundary.custom())).toEqual({
			errorKey: "limit_reached",
			name: "ForbiddenError",
			response: 403,
			status: 403,
		})
	})

	// v0: fb79adaaf7
	it("localizes the error message by a per-call Accept-Language", async () => {
		const { users } = client().safe
		const de = await users.list({ headers: { "accept-language": "de" } })
		const en = await users.list({ headers: { "accept-language": "en" } })
		const unauthorized = { errorKey: "unauthorized", name: "UnauthorizedError", response: 401, status: 401 }
		expect([errOf(de), errOf(en)]).toEqual([unauthorized, unauthorized])
		const [deMessage, enMessage] = [envelopeOf(de).message, envelopeOf(en).message]
		expect([typeof deMessage, deMessage === enMessage]).toEqual(["string", false])
	})
})
