/**
 * The mutation check (00-rules "Security gate"): a guard is load-bearing only if the adversarial
 * suite goes red without it. For each registered guard, run the suite with that guard disabled
 * (HONEY_MUTANT=<id>, applied by the suite through vi.doMock) and require a failing run; with
 * every guard in place the suite must pass.
 *
 *     bun packages/core/tests/structure/mutation-harness.ts
 */
import { spawnSync } from "node:child_process"
import type { IncomingMessage, ServerResponse } from "node:http"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import type { CompressOptions } from "../../src/middleware/compress.ts"
import type { IpRestrictOptions } from "../../src/middleware/ip-restrict.ts"
import type { MemoryStoreOptions, RateLimitOptions } from "../../src/middleware/rate-limit.ts"
import type { SSEEvent, SSEOptions, SSEStream } from "../../src/response/sse.ts"
import { type ProducerOptions, type ProducerSink, producerStream } from "../../src/streaming/producer-stream.ts"
import type { WSContext, WSHandler } from "../../src/ws/contract.ts"

export type Guard = {
	/** what the suite must catch once this guard is gone */
	catches: string
	/** the module's exports with the guard switched off, built from its real exports */
	disable(original: Record<string, unknown>): Record<string, unknown>
	id: string
	/** repo-relative path of the module that holds the guard */
	module: string
}

type NormalizePath = (raw: string, encodedSlashes?: "allow" | "reject") => string | null

const HOP_BY_HOP = /^(?:connection|keep-alive|proxy-connection|te|trailer|transfer-encoding|upgrade)$/

/**
 * A response writer without one of the bridge's framing checks: every header the response carries
 * goes out (`keepHopByHop`), or a stream keeps the length it declares (`trustLength`).
 */
function naiveWriter(mutation: { keepHopByHop: boolean; trustLength: boolean }) {
	return async (response: Response, res: ServerResponse): Promise<void> => {
		const named = (response.headers.get("connection") ?? "").toLowerCase().split(/\s*,\s*/)
		const headers: Record<string, string> = {}
		response.headers.forEach((value, name) => {
			if (mutation.keepHopByHop || !(HOP_BY_HOP.test(name) || named.includes(name))) headers[name] = value
		})
		const body = response.body
		if (!mutation.trustLength && body !== null) delete headers["content-length"]
		res.writeHead(response.status, headers)
		if (body !== null) for await (const chunk of body) res.write(chunk)
		res.end()
	}
}

export const GUARDS: readonly Guard[] = [
	{
		/* the v0 guard that proves the mechanism until bit 07 registers v1's (H21: v0 serves until cutover) */
		catches: "an encoded / or \\ reaching a route param",
		disable: (original) => {
			const normalizePath = original.normalizePath as NormalizePath
			return { normalizePath: (raw: string) => normalizePath(raw, "allow") }
		},
		id: "encoded-separator",
		module: "_v0/src/request-path.ts",
	},
	{
		catches: "v1: an encoded / or \\ reaching a route param",
		disable: (original) => {
			const normalizePath = original.normalizePath as NormalizePath
			return { normalizePath: (raw: string) => normalizePath(raw, "allow") }
		},
		id: "v1-encoded-separator",
		module: "packages/core/src/routing/request-path.ts",
	},
	{
		catches: "v1: a dot segment or doubled slash slipping past a scope",
		disable: (original) => {
			const normalizePath = original.normalizePath as NormalizePath
			return {
				normalizePath: (raw: string, encodedSlashes?: "allow" | "reject") =>
					normalizePath(raw, encodedSlashes) === null ? null : raw,
			}
		},
		id: "v1-path-canonical",
		module: "packages/core/src/routing/request-path.ts",
	},
	{
		catches: "v1: a cookie value written raw into Set-Cookie",
		disable: () => ({ serializeCookie: (name: string, opts: { value: string }) => `${name}=${opts.value}` }),
		id: "v1-cookie-octets",
		module: "packages/core/src/context/cookie.ts",
	},
	{
		catches: "v1: a cookie record with a prototype",
		disable: (original) => {
			const parse = original.parseCookieHeader as (header: string) => Record<string, string>
			return { parseCookieHeader: (header: string) => ({ ...parse(header) }) }
		},
		id: "v1-cookie-record",
		module: "packages/core/src/context/cookie.ts",
	},
	{
		catches: "v1: a tampered signed cookie accepted",
		disable: () => ({
			createCookieSigner: () => ({
				sign: async (value: string) => `${value}.~sig`,
				verify: async (signed: string) => signed.slice(0, Math.max(0, signed.lastIndexOf("."))) || null,
			}),
		}),
		id: "v1-cookie-signature",
		module: "packages/core/src/context/cookie-sign.ts",
	},
	{
		catches: "v1: a request URL built from whatever Host the client sent (a second one, or one carrying a path)",
		disable: () => ({
			nodeRequestUrl: (incoming: IncomingMessage) => `http://${incoming.headers.host}${incoming.url}`,
		}),
		id: "v1-node-host",
		module: "packages/core/src/adapters/node/url.ts",
	},
	{
		catches: "v1: a request body read past maxRequestBodySize",
		disable: (original) => {
			const nodeRequest = original.nodeRequest as (incoming: IncomingMessage, url: string, maxBody: number) => Request
			return { nodeRequest: (incoming: IncomingMessage, url: string) => nodeRequest(incoming, url, 0) }
		},
		id: "v1-node-body-cap",
		module: "packages/core/src/adapters/node/request.ts",
	},
	{
		catches: "v1: an upstream's hop-by-hop or Connection-named headers written onto this connection",
		disable: () => ({ writeResponse: naiveWriter({ keepHopByHop: true, trustLength: false }) }),
		id: "v1-node-hop-by-hop",
		module: "packages/core/src/adapters/node/response.ts",
	},
	{
		catches: "v1: a stream's declared length trusted, desynchronizing keep-alive",
		disable: () => ({ writeResponse: naiveWriter({ keepHopByHop: false, trustLength: true }) }),
		id: "v1-node-stream-length",
		module: "packages/core/src/adapters/node/response.ts",
	},
	{
		catches: "v1: a producer running ahead of a reader that stopped reading",
		disable: (original) => ({ producerStream: withoutBackpressure(original.producerStream as typeof producerStream) }),
		id: "v1-producer-backpressure",
		module: "packages/core/src/streaming/producer-stream.ts",
	},
	{
		catches: "v1: an SSE id or event name carrying CR/LF written as another field",
		disable: () => ({ sseBody: unvalidatedSse }),
		id: "v1-sse-field-injection",
		module: "packages/core/src/response/sse.ts",
	},
	{
		catches: "v1: security headers missing from an answer",
		disable: () => ({ secureHeaders: () => passThrough }),
		id: "v1-secure-headers",
		module: "packages/core/src/middleware/secure-headers.ts",
	},
	{
		catches: "v1: CORS reflecting any Origin, the opaque null included, with credentials",
		disable: () => ({ cors: () => reflectingCors }),
		id: "v1-cors-origin",
		module: "packages/core/src/middleware/cors.ts",
	},
	{
		catches: "v1: a cross-site unsafe request let through",
		disable: () => ({ csrf: () => passThrough }),
		id: "v1-csrf",
		module: "packages/core/src/middleware/csrf.ts",
	},
	{
		catches: "v1: a client-chosen request id adopted",
		disable: () => ({ requestId: () => adoptingRequestId }),
		id: "v1-request-id-trust",
		module: "packages/core/src/middleware/request-id.ts",
	},
	{
		catches: "v1: a stalled handler holding the request past its timeout",
		disable: () => ({ timeout: () => passThrough }),
		id: "v1-timeout",
		module: "packages/core/src/middleware/timeout.ts",
	},
	{
		catches: "v1: a Server-Timing name or description forging a metric the server never timed",
		disable: () => ({ serverTiming: () => rawServerTiming }),
		id: "v1-server-timing-token",
		module: "packages/core/src/middleware/server-timing.ts",
	},
	{
		catches: "v1: a rate limit keyed on X-Forwarded-For, so a client rotates its window at will",
		disable: (original) => ({ rateLimit: forwardedKey(original.rateLimit as RateLimit) }),
		id: "v1-rate-limit-key",
		module: "packages/core/src/middleware/rate-limit.ts",
	},
	{
		catches: "v1: a rate-limit memory store a key spray grows without bound",
		disable: (original) => ({ memoryStore: uncappedStore(original.memoryStore as MemoryStoreFactory) }),
		id: "v1-rate-limit-bounded",
		module: "packages/core/src/middleware/rate-limit.ts",
	},
	{
		catches: "v1: an IP rule compared as text, so another spelling of a denied address passes",
		disable: () => ({ ipRestrict: textIpRestrict }),
		id: "v1-ip-restrict-canonical",
		module: "packages/core/src/middleware/ip-restrict.ts",
	},
	{
		catches: "v1: ipRestrict reading the client's own forwarding header as its address",
		disable: (original) => ({ ipRestrict: forwardedIp(original.ipRestrict as IpRestrict) }),
		id: "v1-ip-restrict-peer",
		module: "packages/core/src/middleware/ip-restrict.ts",
	},
	{
		catches: "v1: compression of a credentialed answer, its length an oracle for the secret it carries (BREACH)",
		disable: (original) => ({ compress: credentialedCompress(original.compress as Compress) }),
		id: "v1-compress-breach",
		module: "packages/core/src/middleware/compress.ts",
	},
	{
		catches: "v1: a header value carrying CR/LF written through the plain header path",
		disable: () => ({ HoneyOutHeaders: NaiveOutHeaders }),
		id: "v1-out-headers-validation",
		module: "packages/core/src/response/out-headers.ts",
	},
	{
		catches: "v1: a cross-site WebSocket upgrade carrying credentials let through",
		disable: () => ({ originAllowed: () => true }),
		id: "v1-ws-origin",
		module: "packages/core/src/ws/origin.ts",
	},
	{
		catches: "v1: a flood of WebSocket messages queued without bound for a handler that never drains",
		disable: (original) => ({ createWsSession: uncapped(original.createWsSession as CreateWsSession) }),
		id: "v1-ws-pending-cap",
		module: "packages/core/src/ws/session.ts",
	},
]

type Mw = (ctx: { req: Request }, next: (adds?: Record<string, unknown>) => Promise<Response>) => Promise<Response>

/** A middleware that does nothing: the guard it replaces is gone. */
const passThrough: Mw = (_ctx, next) => next()

/** CORS that reflects whatever Origin came, with credentials. */
const reflectingCors: Mw = async (ctx, next) => {
	const res = await next()
	const origin = ctx.req.headers.get("origin")
	if (origin === null) return res
	const out = new Response(res.body, res)
	out.headers.set("access-control-allow-origin", origin)
	out.headers.set("access-control-allow-credentials", "true")
	return out
}

/** requestId that adopts any inbound id. */
const adoptingRequestId: Mw = async (ctx, next) => {
	const id = ctx.req.headers.get("x-request-id") ?? crypto.randomUUID()
	const res = await next({ requestId: id })
	const out = new Response(res.body, res)
	out.headers.set("x-request-id", id)
	return out
}

/** serverTiming that writes names and descriptions as given. */
const rawServerTiming: Mw = async (_ctx, next) => {
	const parts: string[] = []
	const timing = {
		end() {},
		start(name: string, description?: string) {
			parts.push(description ? `${name};desc="${description}";dur=0` : `${name};dur=0`)
		},
	}
	const res = await next({ timing })
	const out = new Response(res.body, res)
	out.headers.set("server-timing", [...parts, "total;dur=0"].join(", "))
	return out
}

/** ipRestrict that compares ctx.ip with each rule as text. */
function textIpRestrict(options: IpRestrictOptions): Mw {
	return (ctx, next) => {
		const ip = (ctx as { ip?: string | null }).ip ?? ""
		const denied = options.denyList?.includes(ip) ?? false
		const admitted = options.allowList === undefined || options.allowList.includes(ip)
		if (denied || !admitted) return Promise.resolve(new Response(null, { status: 403 }))
		return next()
	}
}

type IpRestrict = (options: IpRestrictOptions) => Mw

/** ipRestrict that takes the client's X-Forwarded-For as its address. */
function forwardedIp(real: IpRestrict): IpRestrict {
	return (options) => {
		const mw = real(options)
		return (ctx, next) => mw({ ...ctx, ip: ctx.req.headers.get("x-forwarded-for") } as typeof ctx, next)
	}
}

type Compress = (options?: CompressOptions) => unknown

/** compress that encodes credentialed answers too. */
function credentialedCompress(real: Compress): Compress {
	return (options) => real({ ...options, credentialed: true })
}

type RateLimit = (options: RateLimitOptions) => unknown
type MemoryStoreFactory = (options: MemoryStoreOptions) => unknown

/** rateLimit keyed on the client's own X-Forwarded-For. */
function forwardedKey(real: RateLimit): RateLimit {
	return (options) =>
		real({ ...options, key: (ctx) => ctx.req.headers.get("x-forwarded-for") ?? ctx.ip ?? "" } as RateLimitOptions)
}

/** memoryStore with no cap on its windows. */
function uncappedStore(real: MemoryStoreFactory): MemoryStoreFactory {
	return (options) => real({ ...options, maxKeys: Number.MAX_SAFE_INTEGER })
}

type HeaderMap = Record<string, string | string[]>

/** HoneyOutHeaders without Fetch's name and value checks: a plain map that takes anything. */
class NaiveOutHeaders {
	#map: HeaderMap
	constructor(map: HeaderMap) {
		this.#map = { ...map }
	}
	append(name: string, value: string): void {
		const key = name.toLowerCase()
		const old = this.#map[key]
		this.#map[key] = old === undefined ? value : [...(Array.isArray(old) ? old : [old]), value]
	}
	delete(name: string): void {
		delete this.#map[name.toLowerCase()]
	}
	get(name: string): string | null {
		const value = this.#map[name.toLowerCase()]
		if (value === undefined) return null
		return Array.isArray(value) ? value.join(", ") : value
	}
	getSetCookie(): string[] {
		const value = this.#map["set-cookie"]
		return value === undefined ? [] : Array.isArray(value) ? value : [value]
	}
	has(name: string): boolean {
		return this.get(name) !== null
	}
	set(name: string, value: string): void {
		this.#map[name.toLowerCase()] = value
	}
	toRecord(): HeaderMap {
		return this.#map
	}
	forEach(callback: (value: string, key: string) => void): void {
		for (const [key, value] of this) callback(value, key)
	}
	*[Symbol.iterator](): IterableIterator<[string, string]> {
		for (const key in this.#map) {
			const value = this.#map[key] as string | string[]
			for (const item of Array.isArray(value) ? value : [value]) yield [key, item]
		}
	}
}

type CreateWsSession = (options: never) => WSHandler<unknown>

/** `ws` with its 1008 close ignored. */
function keptOpen(ws: WSContext): WSContext {
	return {
		get bufferedAmount() {
			return ws.bufferedAmount
		},
		close: (code, reason) => (code === 1008 ? undefined : ws.close(code, reason)),
		raw: ws.raw,
		get readyState() {
			return ws.readyState
		},
		send: (data) => ws.send(data),
	}
}

/** createWsSession whose pending cap never closes the connection: the flood just keeps arriving. */
function uncapped(real: CreateWsSession): CreateWsSession {
	return (options) => {
		const handler = real(options)
		return { ...handler, onMessage: (ctx, ws, data) => handler.onMessage?.(ctx, keptOpen(ws), data) }
	}
}

/** producerStream whose writes resolve at once, demand or not. */
function withoutBackpressure(real: typeof producerStream): typeof producerStream {
	return (start, options) =>
		real((sink) => {
			const eager: ProducerSink = {
				close: () => sink.close(),
				get closed() {
					return sink.closed
				},
				error: (error) => sink.error(error),
				onEnd: (fn) => sink.onEnd(fn),
				signal: sink.signal,
				write: (chunk) => {
					sink.write(chunk).catch(() => {})
					return Promise.resolve()
				},
			}
			return start(eager)
		}, options)
}

/** An event framed with no newline check. */
function rawFrame(event: SSEEvent): string {
	return `event: ${event.event}\ndata: ${String(event.data)}\n${event.id === undefined ? "" : `id: ${event.id}\n`}\n`
}

/** sseBody that writes the id and event name as given, newlines and all. */
function unvalidatedSse(
	callback: (stream: SSEStream) => Promise<void>,
	options: SSEOptions,
	producer: ProducerOptions,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	return producerStream(
		(sink) =>
			callback({
				close: () => sink.close(),
				get closed() {
					return sink.closed
				},
				lastEventId: options.lastEventId,
				send: (event) => sink.write(encoder.encode(rawFrame(event))),
				signal: sink.signal,
			}),
		producer,
	)
}

const CORE = resolve(import.meta.dirname, "../..")
const SUITE = "tests/integration/security"
const VITEST = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs")

export function guardNamed(id: string | undefined): Guard | undefined {
	if (id === undefined || id === "") return undefined
	const guard = GUARDS.find((g) => g.id === id)
	if (guard === undefined) throw new Error(`unknown guard "${id}"; known: ${GUARDS.map((g) => g.id).join(", ")}`)
	return guard
}

/** The adversarial suite's exit status, with `mutant` disabled when given. */
export function runSuite(mutant: string | undefined): number {
	const env = { ...process.env, HONEY_MUTANT: mutant ?? "" }
	const run = spawnSync(process.execPath, [VITEST, "run", SUITE], { cwd: CORE, encoding: "utf8", env })
	return run.status ?? 1
}

export function survivors(results: ReadonlyArray<{ id: string; status: number }>): string[] {
	return results.filter((r) => r.status === 0).map((r) => r.id)
}

function main(): number {
	if (runSuite(undefined) !== 0) {
		process.stderr.write("mutation: the adversarial suite fails with every guard in place\n")
		return 1
	}
	const results = GUARDS.map((g) => ({ id: g.id, status: runSuite(g.id) }))
	for (const r of results) process.stdout.write(`${r.status === 0 ? "SURVIVED" : "killed  "} ${r.id}\n`)
	const left = survivors(results)
	if (left.length > 0) process.stderr.write(`mutation: no case catches ${left.join(", ")}\n`)
	return left.length === 0 ? 0 : 1
}

if (import.meta.main) process.exit(main())
