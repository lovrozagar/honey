/**
 * The TS target of the conformance grid: every `cellsFor("ts")` cell runs through the SDK
 * `generateSdk` emits from the spawned reference app's served document, driven in process, and
 * the app front (`createClient`) sends the reference request. Opt-in: `vitest run --mode harness`.
 */
import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { emittedApp, emittedSdk } from "../../../src/emit/ts/__fixtures__/emitted.ts"
import { type ReferenceApp, SPAWN_TIMEOUT, startReferenceApp, targetSuite } from "./harness.ts"
import { type Call, type Cell, cellsFor, compareCell, type Json, type Observed, type Setup } from "./matrix.ts"

type Input = Record<string, unknown>
type Result = { data: unknown; error: unknown; headers?: Record<string, string>; status: number }
type Event = { data: Json; event?: string; id?: string }
type Socket = {
	close(code?: number): void
	on(event: "close" | "error" | "message", handler: (value: never) => void): void
	send(data: string): void
}
type Sdk = { dispose(): void } & Record<string, unknown>
type SdkClass = new (config: Input) => Sdk
/** A service map node, read for two facts: `empty`, an operation declaring no success body, and `realtime`. */
type MapNode = { empty?: boolean; realtime?: boolean } & Record<string, unknown>
type App = Record<string, (path: string, input: Input) => Promise<unknown>>

/** Each titled cell's v0 port, or the C5 case whose live leg it is: the suite names its `it` `<key> (<title>)`. */
const V0_PORTS: Readonly<Record<string, string>> = {
	// v0: 1fd9382e8e
	"verbs/reference-request": "v0 1fd9382e8e",
	"reconnect/sse-last-event-id": "live leg of C5 6b06bf8f90",
	"sse/typed-events": "live leg of C5 11410bbf49",
}

/** The client config a cell's setup asks for: the credential as a header, the timeout and redirect policy. */
function configOf(app: ReferenceApp, setup: Setup = {}): Input {
	const headers: Record<string, string> = { ...setup.headers }
	if (setup.auth?.kind === "bearer") headers.authorization = `Bearer ${setup.auth.token}`
	else if (setup.auth) headers[setup.auth.name] = setup.auth.value
	return { baseURL: app.url, headers, redirect: setup.redirect, timeout: setup.timeoutMs }
}

/** The client input for `call`: params, search, headers, body, per-call overrides and resume cursors. */
function inputOf(call: Call, app: ReferenceApp): Input {
	const headers: Record<string, string> = { ...call.headers }
	const input: Input = {
		headers,
		lastEventId: call.lastEventId,
		params: call.params,
		raw: call.raw,
		reconnectToken: call.reconnectToken,
		search: call.search,
		timeout: call.timeoutMs,
	}
	if (call.origin === "alt") input.baseURL = app.alt
	if (call.body?.kind === "json") input.json = call.body.value
	else if (call.body) {
		input.body = Uint8Array.from({ length: call.body.size }, (_, i) => i & 0xff)
		headers["content-type"] = call.body.contentType
	}
	return input
}

/** The SDK member an operationId names: `items.get` is `sdk.items.get`; a missing one fails the cell. */
function operationOf(sdk: Sdk, operation: string): (input: Input) => unknown {
	let member: unknown = sdk
	for (const segment of operation.split(".")) member = (member as Record<string, unknown> | undefined)?.[segment]
	if (typeof member !== "function") throw new Error(`ConformanceSDK has no operation ${operation}`)
	return member as (input: Input) => unknown
}

/** Whether the operation is realtime, by the service map the SDK dispatches by. */
function isRealtime(map: MapNode, operation: string): boolean {
	let node: MapNode | undefined = map
	for (const segment of operation.split(".")) node = node?.[segment] as MapNode | undefined
	return node?.realtime === true
}

/** Whether the operation declares no success body, by the service map the SDK dispatches by. */
function declaresNoBody(map: MapNode, operation: string): boolean {
	let node: MapNode | undefined = map
	for (const segment of operation.split(".")) node = node?.[segment] as MapNode | undefined
	return node?.empty === true
}

/**
 * The answer to an operation declaring no success body, its data null by type, as Go's driver
 * reads it: the raw response's body, JSON when it parses, else the text, null when empty.
 */
async function untypedOf(response: Response): Promise<Observed> {
	const text = await response.text()
	let data: Json = text.length === 0 ? null : text
	try {
		data = JSON.parse(text) as Json
	} catch {
		/* not JSON: the text itself, or null when empty */
	}
	return { data, kind: "data", status: response.status }
}

/** A safe-mode result as the grid observes it: an error by status and key, bytes by digest, else data. */
function settled(result: Result): Observed {
	if (result.error) {
		const body = (result.error instanceof Error ? (result.error as { body?: unknown }).body : result.error) as Json
		const key = (body as { error_key?: unknown } | null)?.error_key
		return { body, errorKey: typeof key === "string" ? key : null, kind: "error", status: result.status }
	}
	if (result.data instanceof Uint8Array) {
		const sha256 = createHash("sha256").update(result.data).digest("hex")
		return { kind: "bytes", sha256, size: result.data.byteLength, status: result.status }
	}
	const data: Observed = { data: result.data as Json, kind: "data", status: result.status }
	return result.headers ? { ...data, headers: result.headers } : data
}

/** Up to `take` events of a stream, then the stream is closed (`break`). */
async function eventsOf(stream: AsyncIterable<Event>, take = Number.POSITIVE_INFINITY): Promise<Event[]> {
	const events: Event[] = []
	for await (const { data, event, id } of stream) {
		const seen: Event = { data }
		if (event !== undefined) seen.event = event
		if (id !== undefined) seen.id = id
		events.push(seen)
		if (events.length >= take) break
	}
	return events
}

/** Send the call's frames, read `take` text frames as JSON, then close 1000; resolves once the socket closes. */
function framesOf(socket: Socket, call: Call): Promise<Json[]> {
	const take = call.take ?? Number.POSITIVE_INFINITY
	return new Promise((resolve, reject) => {
		const frames: Json[] = []
		socket.on("message", (data: string) => {
			if (frames.length < take) frames.push(JSON.parse(data) as Json)
			if (frames.length === take) socket.close(1000)
		})
		socket.on("close", () => resolve(frames))
		socket.on("error", (e: unknown) => reject(e instanceof Error ? e : new Error("WebSocket error")))
		for (const frame of call.send ?? []) socket.send(frame)
	})
}

const isSocket = (value: unknown): value is Socket =>
	typeof value === "object" && value !== null && typeof (value as Socket).on === "function" && "send" in value

const isStream = (value: unknown): value is AsyncIterable<Event> =>
	typeof value === "object" && value !== null && Symbol.asyncIterator in value

type Resumable = AsyncIterable<Json> & {
	close(): void
	send(data: unknown): Promise<void>
	sendText(text: string): Promise<void>
}
/** Whether `text` parses as JSON. */
function isJson(text: string): boolean {
	try {
		JSON.parse(text)
		return true
	} catch {
		return false
	}
}

const isResumable = (value: unknown): value is Resumable => isStream(value) && "provenTransport" in value

/**
 * A realtime connection's first `take` values, read as Go's driver reads them (frames), then it is closed. The call's
 * `send` goes once it is `connected`, a JSON text as its value and any other as raw text (`sendText`).
 */
async function liveOf(connection: Resumable, call: Call, connected?: Promise<unknown>): Promise<Json[]> {
	const values = connection[Symbol.asyncIterator]()
	const frames: Json[] = []
	try {
		let next = values.next()
		if (call.send?.length) await connected
		for (const text of call.send ?? [])
			await (isJson(text) ? connection.send(JSON.parse(text)) : connection.sendText(text))
		for (let result = await next; !result.done; result = await next) {
			if (frames.push(result.value) >= (call.take ?? Number.POSITIVE_INFINITY)) break
			next = values.next()
		}
	} finally {
		connection.close()
	}
	return frames
}

/** One call's answer, normalized: a raw response, a socket, a realtime connection, an event stream or a safe-mode result. */
async function observe(answer: unknown, call: Call, connected?: Promise<unknown>): Promise<Observed> {
	if (answer instanceof Response) {
		const headers = Object.fromEntries(answer.headers)
		return { body: await answer.text(), headers, kind: "raw", status: answer.status }
	}
	if (isSocket(answer)) return { frames: await framesOf(answer, call), kind: "frames" }
	if (isResumable(answer)) return { frames: await liveOf(answer, call, connected), kind: "frames" }
	if (isStream(answer)) return { events: await eventsOf(answer, call.take), kind: "events" }
	return settled(answer as Result)
}

/** Send one call: a timeout or abort is `timeout`, a thrown ClientError (a stream's non-2xx) an error. */
async function attempt(fire: () => unknown, call: Call, connected?: Promise<unknown>): Promise<Observed> {
	try {
		return await observe(await fire(), call, connected)
	} catch (e) {
		if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return { kind: "timeout" }
		const status = (e as { status?: unknown } | null)?.status
		if (e instanceof Error && typeof status === "number") return settled({ data: null, error: e, status })
		throw e
	}
}

/**
 * One call through `safe`; an operation declaring no success body goes `raw: true` through
 * `thrower` instead, so an error status still throws its ClientError and a 2xx is read untyped.
 */
async function callOf(clients: { map: MapNode; safe: Sdk; thrower: Sdk }, call: Call, app: ReferenceApp) {
	const input = inputOf(call, app)
	/* a realtime op opens one connection, whatever its body: its sends wait for the open */
	if (isRealtime(clients.map, call.operation)) {
		const connected = new Promise((resolve) => (input.onReconnected = resolve))
		return attempt(() => operationOf(clients.safe, call.operation)(input), call, connected)
	}
	if (call.raw || !declaresNoBody(clients.map, call.operation))
		return attempt(() => operationOf(clients.safe, call.operation)(input), call)
	const send = async () =>
		untypedOf((await operationOf(clients.thrower, call.operation)({ ...input, raw: true })) as Response)
	return attempt(send, call)
}

/** The TS runner: the emitted SDK class built once from the served document, one instance per mode per cell. */
function tsRunner() {
	let built: { ConformanceSDK: SdkClass; map: MapNode } | undefined
	return {
		async prepare(app: ReferenceApp): Promise<void> {
			const sdk = await emittedSdk(app.document, { name: "ConformanceSDK" })
			built = { ConformanceSDK: sdk.ConformanceSDK as SdkClass, map: sdk.serviceMap as MapNode }
		},
		async run(cell: Cell, app: ReferenceApp): Promise<readonly Observed[]> {
			if (!built) throw new Error("the TS runner ran a cell before prepare")
			const config = configOf(app, cell.setup)
			const safe = new built.ConformanceSDK(config)
			const thrower = new built.ConformanceSDK({ ...config, throwOnError: true })
			const observed: Observed[] = []
			try {
				for (const call of cell.calls) observed.push(await callOf({ map: built.map, safe, thrower }, call, app))
			} finally {
				safe.dispose()
				thrower.dispose()
			}
			return observed
		},
		target: "ts" as const,
		titles: V0_PORTS,
	}
}

targetSuite(tsRunner())

describe("conformance × ts titles", () => {
	it("titles only cells the grid holds for ts", () => {
		const keys = new Set(cellsFor("ts").map((cell) => cell.key))
		expect(Object.keys(V0_PORTS).filter((key) => !keys.has(key))).toEqual([])
	})
})

describe("app front", () => {
	let app: ReferenceApp | undefined
	beforeAll(async () => {
		app = await startReferenceApp()
	}, SPAWN_TIMEOUT)
	afterAll(() => app?.stop())

	// v0: 1a11479004
	it("createClient sends the reference request: the same hop and data as verbs/reference-request", async () => {
		const live = app as ReferenceApp
		const cell = cellsFor("ts").find((c) => c.key === "verbs/reference-request")
		expect(cell?.calls).toHaveLength(1)
		const [call] = (cell as Cell).calls as [Call]
		const { createClient } = (await emittedApp()) as unknown as { createClient: (config: Input) => App }
		const client = createClient(configOf(live, (cell as Cell).setup))
		const method = call.route.method.toLowerCase()
		const since = await live.mark()
		const observed = await attempt(() => client[method]?.(call.route.path, inputOf(call, live)), call)
		expect(compareCell(cell as Cell, [observed], await live.wire(since))).toEqual([])
	})
})
