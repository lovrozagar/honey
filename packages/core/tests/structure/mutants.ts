/**
 * The mutants the mutation harness swaps in for a guard: each is the guarded code with the one check
 * it exists for taken out. Split from mutation-harness.ts, which keeps the guard list and the runner.
 */
import type { ServerResponse } from "node:http"
import type { TapCall } from "../../src/context/context.ts"
import type { CompressOptions } from "../../src/middleware/compress.ts"
import type { CompiledChain } from "../../src/middleware/middleware.ts"
import type { StaticConfig } from "../../src/response/static.ts"
import type { IpRestrictOptions } from "../../src/middleware/ip-restrict.ts"
import type { MemoryStoreOptions, RateLimitOptions } from "../../src/middleware/rate-limit.ts"
import type { SSEEvent, SSEOptions, SSEStream } from "../../src/response/sse.ts"
import { type ProducerOptions, type ProducerSink, producerStream } from "../../src/streaming/producer-stream.ts"
import type { WSContext, WSHandler } from "../../src/ws/contract.ts"
export type NormalizePath = (raw: string, encodedSlashes?: "allow" | "reject") => string | null

export const HOP_BY_HOP = /^(?:connection|keep-alive|proxy-connection|te|trailer|transfer-encoding|upgrade)$/

/**
 * A response writer without one of the bridge's framing checks: every header the response carries
 * goes out (`keepHopByHop`), or a stream keeps the length it declares (`trustLength`).
 */
export function naiveWriter(mutation: { keepHopByHop: boolean; trustLength: boolean }) {
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

export type Mw = (
	ctx: { req: Request },
	next: (adds?: Record<string, unknown>) => Promise<Response>,
) => Promise<Response>

/** A middleware that does nothing: the guard it replaces is gone. */
export const passThrough: Mw = (_ctx, next) => next()

/** CORS that reflects whatever Origin came, with credentials. */
export const reflectingCors: Mw = async (ctx, next) => {
	const res = await next()
	const origin = ctx.req.headers.get("origin")
	if (origin === null) return res
	const out = new Response(res.body, res)
	out.headers.set("access-control-allow-origin", origin)
	out.headers.set("access-control-allow-credentials", "true")
	return out
}

/** requestId that adopts any inbound id. */
export const adoptingRequestId: Mw = async (ctx, next) => {
	const id = ctx.req.headers.get("x-request-id") ?? crypto.randomUUID()
	const res = await next({ requestId: id })
	const out = new Response(res.body, res)
	out.headers.set("x-request-id", id)
	return out
}

/** serverTiming that writes names and descriptions as given. */
export const rawServerTiming: Mw = async (_ctx, next) => {
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
export function textIpRestrict(options: IpRestrictOptions): Mw {
	return (ctx, next) => {
		const ip = (ctx as { ip?: string | null }).ip ?? ""
		const denied = options.denyList?.includes(ip) ?? false
		const admitted = options.allowList === undefined || options.allowList.includes(ip)
		if (denied || !admitted) return Promise.resolve(new Response(null, { status: 403 }))
		return next()
	}
}

export type IpRestrict = (options: IpRestrictOptions) => Mw

/** ipRestrict that takes the client's X-Forwarded-For as its address. */
export function forwardedIp(real: IpRestrict): IpRestrict {
	return (options) => {
		const mw = real(options)
		return (ctx, next) => mw({ ...ctx, ip: ctx.req.headers.get("x-forwarded-for") } as typeof ctx, next)
	}
}

export type Compress = (options?: CompressOptions) => unknown
export type ProxyFactory = (config: never) => (ctx: { req: Request }) => Promise<Response>

/** proxy whose ctx.path is the raw request target, as if the router never normalized it. */
export function rawTargetProxy(real: ProxyFactory): ProxyFactory {
	return (config) => {
		const handler = real(config)
		return (ctx) => {
			const url = ctx.req.url
			const raw = url.slice(url.indexOf("/", url.indexOf("://") + 3)).split("?")[0]
			/* a Proxy, not a copy: ctx's getters read its private fields */
			return handler(
				new Proxy(ctx, { get: (target, key) => (key === "path" ? raw : Reflect.get(target, key, target)) }),
			)
		}
	}
}

/** compress that encodes credentialed answers too. */
export function credentialedCompress(real: Compress): Compress {
	return (options) => real({ ...options, credentialed: true })
}

export type RateLimit = (options: RateLimitOptions) => unknown
export type MemoryStoreFactory = (options: MemoryStoreOptions) => unknown

/** rateLimit keyed on the client's own X-Forwarded-For. */
export function forwardedKey(real: RateLimit): RateLimit {
	return (options) =>
		real({ ...options, key: (ctx) => ctx.req.headers.get("x-forwarded-for") ?? ctx.ip ?? "" } as RateLimitOptions)
}

/** memoryStore with no cap on its windows. */
export function uncappedStore(real: MemoryStoreFactory): MemoryStoreFactory {
	return (options) => real({ ...options, maxKeys: Number.MAX_SAFE_INTEGER })
}

export type HeaderMap = Record<string, string | string[]>

/** HoneyOutHeaders without Fetch's name and value checks: a plain map that takes anything. */
export class NaiveOutHeaders {
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

export type CreateWsSession = (options: never) => WSHandler<unknown>

/** `ws` with its 1008 close ignored. */
export function keptOpen(ws: WSContext): WSContext {
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
export function uncapped(real: CreateWsSession): CreateWsSession {
	return (options) => {
		const handler = real(options)
		return { ...handler, onMessage: (ctx, ws, data) => handler.onMessage?.(ctx, keptOpen(ws), data) }
	}
}

/** producerStream whose writes resolve at once, demand or not. */
export function withoutBackpressure(real: typeof producerStream): typeof producerStream {
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
export function rawFrame(event: SSEEvent): string {
	return `event: ${event.event}\ndata: ${String(event.data)}\n${event.id === undefined ? "" : `id: ${event.id}\n`}\n`
}

/** sseBody that writes the id and event name as given, newlines and all. */
export function unvalidatedSse(
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

/** staticFiles that decodes ctx.path and hands it to resolve unchecked: `..`, NUL, `:` and all. */
export function uncheckedStatic(config: StaticConfig<unknown>): Mw {
	return async (ctx, next) => {
		const file = await config.resolve(ctx, decodeURIComponent((ctx as { path?: string }).path ?? "/"))
		return file instanceof Response ? file : next()
	}
}

function utf8Bytes(value: string | Uint8Array): Uint8Array {
	return typeof value === "string" ? new TextEncoder().encode(value) : value
}

/** timingSafeEqual that compares the UTF-8 encodings: every lone surrogate becomes U+FFFD, so different strings match. */
export async function utf8Equal(a: string | Uint8Array, b: string | Uint8Array): Promise<boolean> {
	if ((typeof a === "string") !== (typeof b === "string")) return false
	const [x, y] = [utf8Bytes(a), utf8Bytes(b)]
	return x.length === y.length && x.every((byte, i) => byte === y[i])
}

export type LoggerFactory = (options?: { redactHeader?: (name: string, value: string) => string | null }) => unknown

/** curlLogger that logs every header value as it came. */
export function unredacted(real: LoggerFactory): LoggerFactory {
	return (options) => real({ ...options, redactHeader: (_name, value) => value })
}

export type ErrorI18nFactory = (config: never) => {
	resolveLocale: unknown
	translate(error: unknown, locale: string): unknown
}

/** errorI18n whose translate writes the message into the thrown error itself, and returns it. */
export function translatingInPlace(real: ErrorI18nFactory): ErrorI18nFactory {
	return (config) => {
		const value = real(config)
		return {
			resolveLocale: value.resolveLocale,
			translate(error: unknown, locale: string) {
				const copy = value.translate(error, locale) as { message: string }
				;(error as { message: string }).message = copy.message
				return error
			},
		}
	}
}

export type Firing = (
	run: CompiledChain,
	taps: ReadonlyMap<string, (ctx: object, payload: unknown) => unknown>,
) => CompiledChain

/**
 * `firing` that runs each `ctx.tap()` call's handler inline, awaited before the answer goes out.
 * context.ts loads lazily: a top-level import would load it before the suite's mock is in place.
 */
export const inlineFiring: Firing = (run, taps) => async (ctx) => {
	const { TAPS } = await import("../../src/context/context.ts")
	const response = await run(ctx)
	for (const call of (ctx as { [TAPS]: readonly TapCall[] | null })[TAPS] ?? []) {
		await taps.get(call.key)?.(ctx, call.payload)
	}
	return response
}

export type InboundTraceFn = (source: never, trust: unknown, report: (error: unknown) => void) => unknown

/** inboundTrace that trusts every hop: a client's traceparent and tracestate are continued. */
export function trustingEveryHop(real: InboundTraceFn): InboundTraceFn {
	return (source, _trust, report) => real(source, true, report)
}
