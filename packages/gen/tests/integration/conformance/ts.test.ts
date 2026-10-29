/**
 * The TS target of the conformance grid: every `cellsFor("ts")` cell runs through the SDK
 * `generateSdk` emits from the spawned reference app's served document, driven in process, and
 * the app front (`createClient`) sends the reference request. The safe variant (bit 21 i1) runs one cell per
 * response kind through `client.safe`, and its compile leg type-checks every operation's safe call and both arms
 * under tsc. Opt-in: `vitest run --mode harness`.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, assert, beforeAll, describe, expect, it } from "vitest"
import { emittedApp, emittedSdk } from "../../../src/emit/ts/__fixtures__/emitted.ts"
import { generateSdk } from "../../../src/emit/ts/sdk.ts"
import { memberTree } from "../../../src/emit/ts/service-map.ts"
import { type OpenApiDocument, toIR } from "../../../src/ir/build.ts"
import type { IRNamespace } from "../../../src/ir/model.ts"
import { type ReferenceApp, SPAWN_TIMEOUT, startReferenceApp, targetSuite } from "./harness.ts"
import {
	type Call,
	type Cell,
	cellsFor,
	compareCell,
	type Json,
	type NoAnswer,
	type Observed,
	type Setup,
} from "./matrix.ts"
import { SAFE } from "./safe.ts"
import type { Result as RuntimeResult } from "../../../src/runtime/ts/response.ts"

type Input = Record<string, unknown>
/** A safe call's Result as the runtime declares it, with or without declared headers: never a shape of this file's. */
type Result = RuntimeResult<unknown> | RuntimeResult<unknown, never, Record<string, string>>
type Event = { data: Json; event?: string; id?: string }
type Socket = {
	close(code?: number): void
	on(event: "close" | "error" | "message", handler: (value: never) => void): void
	send(data: string): void
}
type Sdk = { dispose(): void } & Record<string, unknown>
type SdkClass = new (config: Input) => Sdk
/**
 * A service map node, read for three facts: `empty`, an operation declaring no success body; `realtime`; and
 * `headers`, the success answer's declared headers.
 */
type MapNode = { empty?: boolean; headers?: readonly string[]; realtime?: boolean } & Record<string, unknown>
type App = Record<string, (path: string, input: Input) => Promise<unknown>>
type ErrorClass = abstract new (...args: never[]) => Error
/** The emitted SDK's error classes the grid tells apart: an error status, an undecodable 2xx, and no answer. */
type Errors = {
	readonly APIConnectionError: ErrorClass
	readonly ClientError: ErrorClass
	readonly DecodeError: ErrorClass
}

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
	return {
		baseURL: app.url,
		headers,
		maxResponseBytes: setup.maxResponseBytes,
		redirect: setup.redirect,
		timeout: setup.timeoutMs,
	}
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
	if (call.origin !== undefined) input.baseURL = app[call.origin]
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

/** The operation's entry in the service map the SDK dispatches by. */
function entryOf(map: MapNode, operation: string): MapNode | undefined {
	let node: MapNode | undefined = map
	for (const segment of operation.split(".")) node = node?.[segment] as MapNode | undefined
	return node
}

/**
 * The answer to an operation declaring no success body, its data null by type, as Go's driver
 * reads it: the raw response's body, JSON when it parses, else the text, null when empty.
 */
function untypedOf(text: string, status: number): Observed {
	let data: Json = text.length === 0 ? null : text
	try {
		data = JSON.parse(text) as Json
	} catch {
		/* not JSON: the text itself, or null when empty */
	}
	return { data, kind: "data", status }
}

/**
 * What failed with no answer, as the grid observes it: a timeout or an abort, or the SDK's APIConnectionError; else
 * null (no outcome the grid has).
 */
function noAnswerOf(e: unknown, errors: Errors): NoAnswer | null {
	if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return "timeout"
	return e instanceof errors.APIConnectionError ? "transport" : null
}

/** An answer's error as the grid observes it: an undecodable 2xx's DecodeError, else an error by status and key. */
function failureOf(error: unknown, errors: Errors): Observed {
	const { body, status } = error as { body: Json; status: number }
	if (error instanceof errors.DecodeError) return { kind: "decode", status }
	const key = (body as { error_key?: unknown } | null)?.error_key
	return { body, errorKey: typeof key === "string" ? key : null, kind: "error", status }
}

/** A 2xx's value as the grid observes it: bytes by digest, else data, with the declared headers it carries. */
function valueOf(data: unknown, status: number, headers?: Record<string, string>): Observed {
	if (data instanceof Uint8Array) {
		const sha256 = createHash("sha256").update(data).digest("hex")
		return { kind: "bytes", sha256, size: data.byteLength, status }
	}
	const value: Observed = { data: data as Json, kind: "data", status }
	return headers ? { ...value, headers } : value
}

/** The headers `names` declares, by lower-case name, each one only when `response` carries it: the safe Ok's own. */
function declaredOf(response: Response, names: readonly string[] | undefined): Record<string, string> | undefined {
	if (names === undefined) return undefined
	return Object.fromEntries(names.flatMap((name) => [response.headers.get(name) ?? []].flat().map((v) => [name, v])))
}

/**
 * Up to `take` events of a stream, then the stream is closed (`break`). A stream that fails with no answer after its
 * first event is the events delivered and how it `failed`; any other failure is the call's.
 */
async function eventsOf(
	stream: AsyncIterable<Event>,
	errors: Errors,
	take = Number.POSITIVE_INFINITY,
): Promise<Observed> {
	const events: Event[] = []
	try {
		for await (const { data, event, id } of stream) {
			const seen: Event = { data }
			if (event !== undefined) seen.event = event
			if (id !== undefined) seen.id = id
			events.push(seen)
			if (events.length >= take) break
		}
	} catch (e) {
		const failed = events.length > 0 ? noAnswerOf(e, errors) : null
		if (failed === null) throw e
		return { events, failed, kind: "events" }
	}
	return { events, kind: "events" }
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

/** A connection's answer, normalized: a raw response, a socket, a realtime connection or an event stream; else null. */
async function streamed(answer: unknown, call: Call, errors: Errors, connected?: Promise<unknown>) {
	if (answer instanceof Response) {
		const headers = Object.fromEntries(answer.headers)
		return { body: await answer.text(), headers, kind: "raw", status: answer.status } satisfies Observed
	}
	if (isSocket(answer)) return { frames: await framesOf(answer, call), kind: "frames" } satisfies Observed
	if (isResumable(answer)) return { frames: await liveOf(answer, call, connected), kind: "frames" } satisfies Observed
	if (isStream(answer)) return eventsOf(answer, errors, call.take)
	return null
}

/**
 * A safe call's Result, read strictly: both arms carry the answer's Response, an Err's its error's own; an Ok is its
 * value at the response's status, an Err its failure. Anything else fails the cell's assertion.
 */
async function resulted(result: Result, call: Call, errors: Errors, names?: readonly string[]): Promise<Observed> {
	if (!(result.response instanceof Response)) assert.fail(`${call.operation}: a Result without its response`)
	if (!result.ok) {
		if ((result.error as { response?: unknown }).response !== result.response)
			assert.fail(`${call.operation}: an Err whose response is not its error's`)
		return failureOf(result.error, errors)
	}
	const status = result.response.status
	const stream = await streamed(result.data, call, errors)
	if (stream !== null) return stream
	const headers = ("headers" in result ? result.headers : undefined) ?? (names === undefined ? undefined : {})
	return valueOf(result.data, status, headers)
}

/** What a cell's calls go through: the service map, the client (normal or safe) and the SDK's error classes. */
type Clients = {
	readonly errors: Errors
	readonly map: MapNode
	readonly sdk: Sdk
	/** the last response the client's onResponse hook saw: a normal call's status */
	readonly last: () => Response | undefined
	readonly safe: boolean
}

/**
 * Send one call. No answer (a timeout or abort, APIConnectionError) is that kind in both styles. The normal style
 * observes a value at the status its hook saw and a thrown answer as its failure; the safe style a Result, and a
 * thrown API answer fails the cell, since a safe call never throws one. A connection (realtime or WebSocket) is the
 * same object in both styles, its refusal thrown from it in both.
 */
async function attempt(fire: () => unknown, call: Call, clients: Clients, connected?: Promise<unknown>) {
	const { errors } = clients
	const names = entryOf(clients.map, call.operation)?.headers
	try {
		const answer = await fire()
		const stream = await streamed(answer, call, errors, connected)
		if (stream !== null) return stream
		if (clients.safe) return await resulted(answer as Result, call, errors, names)
		const response = clients.last()
		if (response === undefined) throw new Error(`${call.operation}: answered with no response seen`)
		return valueOf(answer, response.status, declaredOf(response, names))
	} catch (e) {
		const failed = noAnswerOf(e, errors)
		if (failed !== null) return { kind: failed } satisfies Observed
		if (!(e instanceof errors.ClientError)) throw e
		if (clients.safe && connected === undefined)
			assert.fail(`${call.operation}: the safe call threw an API answer, ${e.name}: ${e.message}`)
		return failureOf(e, errors)
	}
}

/**
 * One call through the runner's client; an operation declaring no success body goes `raw: true`, so an error status
 * is still its failure and a 2xx is read untyped.
 */
async function callOf(clients: Clients, call: Call, app: ReferenceApp): Promise<Observed> {
	const input = inputOf(call, app)
	const send = operationOf(clients.sdk, call.operation)
	const entry = entryOf(clients.map, call.operation)
	/* a realtime op opens one connection, whatever its body: its sends wait for the open */
	if (entry?.realtime === true) {
		const connected = new Promise((resolve) => (input.onReconnected = resolve))
		return attempt(() => send(input), call, clients, connected)
	}
	if (call.raw || entry?.empty !== true) return attempt(() => send(input), call, clients)
	const answered = await attempt(() => send({ ...input, raw: true }), call, clients)
	return answered.kind === "raw" ? untypedOf(answered.body as string, answered.status as number) : answered
}

/**
 * The TS runner: the emitted SDK class built once from the served document, one instance per cell, its calls the
 * normal client's, or with `safe` its safe twin's (`client.safe`).
 */
function tsRunner(safe = false) {
	let built: { ConformanceSDK: SdkClass; errors: Errors; map: MapNode } | undefined
	return {
		async prepare(app: ReferenceApp): Promise<void> {
			const sdk = await emittedSdk(app.document, { name: "ConformanceSDK" })
			const { APIConnectionError, ClientError, DecodeError } = sdk
			const errors = { APIConnectionError, ClientError, DecodeError } as Errors
			built = { ConformanceSDK: sdk.ConformanceSDK as SdkClass, errors, map: sdk.serviceMap as MapNode }
		},
		async run(cell: Cell, app: ReferenceApp): Promise<readonly Observed[]> {
			if (!built) throw new Error("the TS runner ran a cell before prepare")
			let last: Response | undefined
			const seen = (ctx: { response: Response }) => {
				last = ctx.response
				return undefined
			}
			const client = new built.ConformanceSDK({ ...configOf(app, cell.setup), onResponse: [seen] })
			const observed: Observed[] = []
			try {
				const sdk = (safe ? client.safe : client) as Sdk
				const clients = { errors: built.errors, last: () => last, map: built.map, safe, sdk }
				for (const call of cell.calls) observed.push(await callOf(clients, call, app))
			} finally {
				client.dispose()
			}
			return observed
		},
		target: "ts" as const,
		titles: V0_PORTS,
	}
}

targetSuite(tsRunner())
targetSuite({ ...tsRunner(true), variant: SAFE })

/** How an operation is called: a REST call, an event stream, or a connection (realtime or WebSocket). */
type Shape = "call" | "connection" | "stream"

/** Each operation of `ns` by its member path, with its shape. */
function operationsOf(ns: IRNamespace, prefix: readonly string[] = []): [path: string[], shape: Shape][] {
	return [...ns.entries].flatMap(([key, entry]): [string[], Shape][] => {
		if (entry.kind === "namespace") return operationsOf(entry.ns, [...prefix, key])
		const { realtime, sse, websocket } = entry.op.extensions
		const shape = realtime || websocket ? "connection" : sse ? "stream" : "call"
		return [[[...prefix, key], shape]]
	})
}

/**
 * The safe compile leg's driver (R-i6 a): for every operation, its safe call with the normal call's own input, both
 * arms read with the response on each, the Ok's data the normal call's value, the Err's error narrowed past
 * DecodeError to its status; a REST call's raw twin's Ok the Response; a connection the very same on the twin.
 */
function safeDriver(stem: string, operations: readonly [string[], Shape][]): string {
	const head = `import { ClientError, ConformanceSDK, DecodeError } from "./${stem}.index.gen.ts"
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
declare function expectType<T extends true>(): void
const client = new ConformanceSDK({ baseURL: "http://localhost" })
`
	const body = operations.map(([path, shape], i) => {
		const at = path.map((key) => `[${JSON.stringify(key)}]`).join("")
		if (shape === "connection") return `expectType<Equal<typeof client.safe${at}, typeof client${at}>>()`
		const raw = `
	const raw = await client.safe${at}({ ...args[0], raw: true })
	if (raw.ok) expectType<Equal<typeof raw.data, Response>>()
	else raw.error satisfies ClientError`
		return `export async function op${i}(...args: Parameters<typeof client.safe${at}>) {
	const r = await client.safe${at}(...args)
	r.response satisfies Response
	if (r.ok) expectType<Equal<typeof r.data, Awaited<ReturnType<typeof client${at}>>>>()
	else if (r.error instanceof DecodeError) r.error.body satisfies string | null
	else r.error satisfies ClientError & { status: number }${shape === "call" ? raw : ""}
}`
	})
	return `${head}${body.join("\n")}\n`
}

/** tsc's diagnostics on `driver.ts` beside the emitted `files`, strict; a run with none that still failed throws. */
function driverErrors(files: Readonly<Record<string, string>>, driver: string): string[] {
	const root = join(process.env.HOME ?? homedir(), ".cache/honey-tmp/gen-ts-types")
	mkdirSync(root, { recursive: true })
	const dir = mkdtempSync(join(root, "safe-"))
	const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin/tsc")
	const compilerOptions = {
		allowImportingTsExtensions: true,
		lib: ["esnext", "dom"],
		module: "esnext",
		moduleResolution: "bundler",
		noEmit: true,
		skipLibCheck: true,
		strict: true,
		target: "esnext",
		types: [],
	}
	for (const [name, text] of Object.entries({ ...files, "driver.ts": driver })) writeFileSync(join(dir, name), text)
	writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["*.ts"] }))
	try {
		execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: dir, encoding: "utf8", timeout: 120_000 })
		return []
	} catch (error) {
		/* a failed run without one diagnostic is tsc not running at all, never a clean check */
		const lines = String((error as { stdout?: string }).stdout ?? "").split("\n")
		if (!lines.some((line) => / error TS\d+:/.test(line))) throw error
		return lines.filter((line) => / error TS\d+:/.test(line))
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}

describe("conformance × ts (safe): every operation's safe call compiles", () => {
	let app: ReferenceApp | undefined
	beforeAll(async () => {
		app = await startReferenceApp()
	}, SPAWN_TIMEOUT)
	afterAll(() => app?.stop())

	it("type-checks each operation's safe call, its raw twin and both arms over the served document's SDK", () => {
		const document = (app as ReferenceApp).document
		const operations = operationsOf(memberTree(toIR(document as OpenApiDocument, { deriveOperationIds: true }).tree))
		const { files, stem } = generateSdk(document, { name: "ConformanceSDK" })
		const count = (shape: Shape) => operations.filter(([, of]) => of === shape).length
		expect([count("call") > 20, count("stream") > 0, count("connection") > 0]).toEqual([true, true, true])
		expect(driverErrors(files, safeDriver(stem, operations))).toEqual([])
	}, 120_000)
})

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
		const front = (await emittedApp()) as unknown as Errors & { createClient: (config: Input) => App }
		let last: Response | undefined
		const seen = (ctx: { response: Response }) => void (last = ctx.response)
		const client = front.createClient({ ...configOf(live, (cell as Cell).setup), onResponse: [seen] })
		const method = call.route.method.toLowerCase()
		const since = await live.mark()
		const clients = { errors: front, last: () => last, map: {}, safe: false, sdk: {} as Sdk }
		const observed = await attempt(() => client[method]?.(call.route.path, inputOf(call, live)), call, clients)
		expect(compareCell(cell as Cell, [observed], await live.wire(since))).toEqual([])
	})
})
