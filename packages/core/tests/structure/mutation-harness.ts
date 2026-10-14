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
