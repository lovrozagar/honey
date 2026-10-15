import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { emittedSdk } from "../../src/emit/ts/__fixtures__/emitted.ts"
import { type ReferenceApp, startReferenceApp } from "./conformance/harness.ts"

type Json = Record<string, unknown>
type Call = (input?: Json) => Promise<Json>
type Sdk = Readonly<Record<string, Readonly<Record<string, Call>>>>
type ErrorClass = abstract new (...args: never[]) => Error
type Failure = Error & { body?: unknown; status?: number }
type Hops = Awaited<ReturnType<ReferenceApp["wire"]>>
type Socket = {
	close(code?: number, reason?: string): void
	on(event: string, handler: (...args: never[]) => void): void
	send(data: string): void
}

const VALID = { Authorization: "Bearer valid-token" }
const EXPIRED = { Authorization: "Bearer expired-token" }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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

/** An error class the emitted SDK exports. */
const cls = (name: string): ErrorClass => emitted[name] as ErrorClass

/** What `call` rejects with; undefined when it resolves. */
const rejection = (call: Promise<unknown>): Promise<Failure | undefined> =>
	call.then(
		() => undefined,
		(e: unknown) => e as Failure,
	)

/** What `run` settled to, and the requests the app received meanwhile. */
async function observe(run: () => Promise<unknown>): Promise<{ hops: Hops; outcome: unknown }> {
	const since = await live().mark()
	const outcome = await run().catch((e: unknown) => e)
	return { hops: await live().wire(since), outcome }
}

/** `socket`'s text frames, and its open and close as promises; close is listened to before open. */
function watch(socket: Socket) {
	const frames: string[] = []
	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		socket.on("close", (code: number, reason: string) => resolve({ code, reason }))
	})
	const opened = new Promise<void>((resolve) => socket.on("open", () => resolve()))
	socket.on("message", (data: string) => frames.push(data))
	return { closed, frames, opened }
}

/** A connection to `ws.echo` with `search`. */
const echoSocket = (search?: Json): Socket => client().ws.echo(search && { search }) as unknown as Socket

describe("round trip", () => {
	// v0: de55a6308c
	it("creates a user, then reads the same user back by its id", async () => {
		const sdk = client({ headers: VALID, throwOnError: true })
		const created = await sdk.users.create({ json: { email: "a@b.com", name: "Alice" } })
		const fetched = await sdk.users.get({ params: { id: created.id } })
		expect([created, fetched]).toEqual([
			{ email: "a@b.com", id: expect.stringMatching(/^user-/), name: "Alice" },
			created,
		])
	})
})

describe("onAuthExpired", () => {
	// v0: 98faa7a50c
	it("retries a 401 once with the hook's token, then keeps that token", async () => {
		let calls = 0
		const onAuthExpired = () => {
			calls++
			return "valid-token"
		}
		const sdk = client({ headers: EXPIRED, onAuthExpired, throwOnError: true })
		const { hops, outcome } = await observe(async () => {
			const user = await sdk.users.create({ json: { email: "b@c.com", name: "Bob" } })
			return sdk.users.get({ params: { id: user.id } })
		})
		expect((outcome as Json).name).toBe("Bob")
		expect([calls, hops.map((hop) => hop.headers.authorization)]).toEqual([
			1,
			["Bearer expired-token", "Bearer valid-token", "Bearer valid-token"],
		])
	})

	// v0: 695e2bf63b
	it("gives up when the hook returns null: no retry, the 401 is thrown", async () => {
		const sdk = client({ headers: EXPIRED, onAuthExpired: () => null, throwOnError: true })
		const { hops, outcome } = await observe(() => sdk.users.create({ json: { email: "n@n.com", name: "Nope" } }))
		expect([outcome instanceof cls("UnauthorizedError"), (outcome as Failure).status, hops.length]).toEqual([
			true,
			401,
			1,
		])
	})

	// v0: 1527910afa
	it("passes a 401 through with no retry when no hook is configured", async () => {
		const sdk = client({ headers: EXPIRED, throwOnError: true })
		const { hops, outcome } = await observe(() => sdk.users.create({ json: { email: "n@n.com", name: "Nope" } }))
		expect([(outcome as Failure).status, hops.length]).toEqual([401, 1])
	})

	// v0: 01134c0b5f
	it("sends the retried token in authHeaderName with authHeaderPrefix", async () => {
		let calls = 0
		const onAuthExpired = () => {
			calls++
			return "valid-token"
		}
		const explicit = { authHeaderName: "Authorization", authHeaderPrefix: "Bearer ", headers: EXPIRED, onAuthExpired }
		const user = await client({ ...explicit, throwOnError: true }).users.create({
			json: { email: "c@c.com", name: "Custom" },
		})
		const custom = client({ authHeaderName: "X-Token", authHeaderPrefix: "Token ", headers: EXPIRED, onAuthExpired })
		const { hops } = await observe(() => custom.users.list())
		expect([user.name, calls, hops.map((hop) => hop.headers["x-token"])]).toEqual([
			"Custom",
			2,
			[undefined, "Token valid-token"],
		])
	})
})

describe("onAuthExpired: request bodies", () => {
	// v0: 40dd62d460
	it("retries a multipart form body with the new token; the hook learns which token failed", async () => {
		const rejected: unknown[] = []
		const onAuthExpired = (ctx: { rejectedToken: string | null }) => {
			rejected.push(ctx.rejectedToken)
			return "valid-token"
		}
		const sdk = client({ headers: EXPIRED, onAuthExpired, throwOnError: true })
		const out = await sdk.uploads.form({ form: { file: new Blob(["hello multipart"], { type: "text/plain" }) } })
		expect([rejected, (out.size as number) > 0]).toEqual([["expired-token"], true])
	})

	// v0: ec425dfa9b
	it("does not retry a streamed body, which the first attempt consumed: the 401 surfaces", async () => {
		let calls = 0
		const onAuthExpired = () => {
			calls++
			return "valid-token"
		}
		const sdk = client({ headers: EXPIRED, onAuthExpired, throwOnError: true })
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("x"))
				controller.close()
			},
		})
		const error = await rejection(sdk.uploads.blob({ body }))
		expect([calls, error?.status]).toEqual([0, 401])
	})
})

describe("typed errors", () => {
	// v0: 4749aee6b7
	it("throws the ClientError subclass of each known status, name and status kept", async () => {
		const sdk = client({ throwOnError: true })
		const names = {
			400: "BadRequestError",
			401: "UnauthorizedError",
			404: "NotFoundError",
			429: "RateLimitError",
			500: "InternalServerError",
		}
		const seen: unknown[] = []
		for (const [status, name] of Object.entries(names)) {
			const error = await rejection(sdk.errors.status({ params: { status } }))
			seen.push([error?.name, error instanceof cls(name), error instanceof cls("ClientError"), error?.status])
		}
		expect(seen).toEqual(Object.entries(names).map(([status, name]) => [name, true, true, Number(status)]))
	})

	// v0: fb04dab92d
	it("throws exactly the base ClientError for a status with no subclass (418)", async () => {
		const error = await rejection(client({ throwOnError: true }).errors.status({ params: { status: "418" } }))
		expect([error?.constructor === cls("ClientError"), error?.name, error?.status]).toEqual([true, "ClientError", 418])
	})

	// v0: 7e435f6692
	it("answers isClientError for a typed subclass (422), status kept", async () => {
		const error = await rejection(client({ throwOnError: true }).errors.status({ params: { status: "422" } }))
		const isClientError = emitted.isClientError as (e: unknown) => boolean
		expect([isClientError(error), error instanceof cls("UnprocessableEntityError"), error?.status]).toEqual([
			true,
			true,
			422,
		])
	})

	// v0: 56e5309a8c
	it("carries a declared 400's envelope on body, with no data alias", async () => {
		const error = await rejection(client({ throwOnError: true }).errors.declared({ params: { status: "400" } }))
		expect([error instanceof cls("BadRequestError"), error?.status, Object.hasOwn(error ?? {}, "data")]).toEqual([
			true,
			400,
			false,
		])
		expect(error?.body).toMatchObject({
			error_key: "bad_request",
			message: expect.any(String),
			status: 400,
			success: false,
		})
	})
})

describe("timeouts", () => {
	// v0: cc221b68ac
	it("lets a per-call timeout beat the config timeout and abort a slow call", async () => {
		const sdk = client({ throwOnError: true, timeout: 10_000 })
		const started = Date.now()
		const error = await rejection(sdk.timing.slow({ search: { ms: 2000 }, timeout: 50 }))
		expect([error instanceof Error, Date.now() - started < 1000]).toEqual([true, true])
	})

	// v0: c6c5a1dd2f
	it("applies the config timeout when the call sets none, and a slow call within it succeeds", async () => {
		const result = await client({ throwOnError: true, timeout: 10_000 }).timing.slow({ search: { ms: 50 } })
		expect(result).toEqual({ ok: true })
	})
})

describe("hooks", () => {
	// v0: cdb56a936e
	it("logs request_start, then response_received with the status and a duration", async () => {
		const entries: Json[] = []
		const sdk = client({ headers: VALID, onLog: (entry: Json) => entries.push(entry), throwOnError: true })
		await sdk.users.create({ json: { email: "l@l.com", name: "Log" } })
		const operation = "POST /v1/secure/users"
		expect(entries).toEqual([
			{ duration_ms: 0, event: "request_start", level: "debug", operation },
			{ duration_ms: expect.any(Number), event: "response_received", level: "info", operation, status: 201 },
		])
		expect(entries[1]?.duration_ms).toBeGreaterThanOrEqual(0)
	})
})

describe("bodies", () => {
	// v0: 27223597c0
	it("uploads a 1 MiB ReadableStream intact: the app echoes its size and sha256", async () => {
		const total = 1024 * 1024
		const hasher = createHash("sha256")
		let sent = 0
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent >= total) return controller.close()
				const chunk = Uint8Array.from({ length: 64 * 1024 }, (_, i) => (sent + i) & 0xff)
				hasher.update(chunk)
				sent += chunk.length
				controller.enqueue(chunk)
			},
		})
		const result = await client({ headers: VALID, throwOnError: true }).uploads.blob({ body })
		expect(result).toEqual({ sha256: hasher.digest("hex"), size: total })
	})

	// v0: 9898b4fc7c
	it("sends an idempotent op an auto UUID key, the explicit key, or the caller's header over both", async () => {
		const sdk = client({ throwOnError: true })
		const auto = await sdk.idempotent.create()
		const explicit = await sdk.idempotent.create({ idempotencyKey: "user-supplied-key-123" })
		const header = await sdk.idempotent.create({
			headers: { "Idempotency-Key": "header-wins-456" },
			idempotencyKey: "loses",
		})
		expect([auto.idempotencyKey, explicit.idempotencyKey, header.idempotencyKey]).toEqual([
			expect.stringMatching(UUID),
			"user-supplied-key-123",
			"header-wins-456",
		])
	})
})

describe("WebSocket", () => {
	// v0: 2880d215cc
	it("connects, sends and receives the echo", async () => {
		const socket = echoSocket()
		const { closed, frames, opened } = watch(socket)
		socket.on("message", () => socket.close(1000, "done"))
		await opened
		socket.send("hello")
		await closed
		expect(frames).toEqual(["hello"])
	})

	// v0: 6fc8bcae59
	it("surfaces close code 1000 on a client-initiated close", async () => {
		const socket = echoSocket()
		const { closed, opened } = watch(socket)
		await opened
		socket.close(1000, "client-bye")
		expect((await closed).code).toBe(1000)
	})

	// v0: c8f263e730
	it("surfaces a server-initiated close's code and reason", async () => {
		const socket = echoSocket()
		const { closed, opened } = watch(socket)
		await opened
		socket.send("__close__")
		expect(await closed).toEqual({ code: 1000, reason: "server-initiated" })
	})

	// v0: 0d13b22a22
	it("echoes with ?token=valid-token and closes 4401 with nothing echoed for a bogus token", async () => {
		const run = async (token: string) => {
			const socket = echoSocket({ token })
			const { closed, frames, opened } = watch(socket)
			socket.on("message", () => socket.close(1000, "done"))
			await Promise.race([opened, closed])
			socket.send("ping")
			return { code: (await closed).code, frames }
		}
		expect([await run("valid-token"), await run("bogus-token")]).toEqual([
			{ code: 1000, frames: ["ping"] },
			{ code: 4401, frames: [] },
		])
	})
})
