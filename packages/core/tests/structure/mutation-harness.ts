/**
 * The mutation check (00-rules "Security gate"): a guard is load-bearing only if the adversarial
 * suite goes red without it. For each registered guard, run the suite with that guard disabled
 * (HONEY_MUTANT=<id>, applied by the suite through vi.doMock) and require a failing run; with
 * every guard in place the suite must pass.
 *
 *     bun packages/core/tests/structure/mutation-harness.ts
 */
import { spawnSync } from "node:child_process"
import type { IncomingMessage } from "node:http"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import type { producerStream } from "../../src/streaming/producer-stream.ts"
import {
	NaiveOutHeaders,
	adoptingRequestId,
	credentialedCompress,
	forwardedIp,
	forwardedKey,
	inlineFiring,
	naiveWriter,
	passThrough,
	rawServerTiming,
	rawTargetProxy,
	reflectingCors,
	textIpRestrict,
	translatingInPlace,
	type Compress,
	type CreateWsSession,
	type ErrorI18nFactory,
	type IpRestrict,
	type LoggerFactory,
	type MemoryStoreFactory,
	type NormalizePath,
	type ProxyFactory,
	type RateLimit,
	uncapped,
	uncappedStore,
	uncheckedStatic,
	unredacted,
	utf8Equal,
	unvalidatedSse,
	withoutBackpressure,
} from "./mutants.ts"

export type Guard = {
	/** what the suite must catch once this guard is gone */
	catches: string
	/** the module's exports with the guard switched off, built from its real exports */
	disable(original: Record<string, unknown>): Record<string, unknown>
	id: string
	/** repo-relative path of the module that holds the guard */
	module: string
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
		catches: "v1: a proxy handing destination the raw request target, so //host leaves the upstream's origin (SSRF)",
		disable: (original) => ({ proxy: rawTargetProxy(original.proxy as ProxyFactory) }),
		id: "v1-proxy-ssrf",
		module: "packages/core/src/proxy/proxy.ts",
	},
	{
		catches: "v1: a proxy forwarding the client's Host, forwarding and hop-by-hop headers to the upstream",
		disable: () => ({ upstreamHeaders: (request: Request) => new Headers(request.headers) }),
		id: "v1-proxy-header-smuggling",
		module: "packages/core/src/proxy/headers.ts",
	},
	{
		catches: "v1: staticFiles handing resolve a path that leaves the root (`..`, NUL, a drive, an encoded separator)",
		disable: () => ({ staticFiles: uncheckedStatic }),
		id: "v1-static-traversal",
		module: "packages/core/src/response/static.ts",
	},
	{
		catches: "v1: a secret comparison by UTF-8 bytes, where a different lone surrogate matches the stored token",
		disable: () => ({ timingSafeEqual: utf8Equal }),
		id: "v1-timing-safe-code-units",
		module: "packages/core/src/security/crypto.ts",
	},
	{
		catches: "v1: error i18n changing the thrown error, so one request's locale leaks into the next request's answer",
		disable: (original) => ({ errorI18n: translatingInPlace(original.errorI18n as ErrorI18nFactory) }),
		id: "v1-error-i18n-copy",
		module: "packages/core/src/i18n/error-i18n.ts",
	},
	{
		catches: "v1: taps run inline before the answer, so a failing tap fails the request and a slow one holds it",
		disable: () => ({ firing: inlineFiring }),
		id: "v1-tap-background",
		module: "packages/core/src/routing/tap.ts",
	},
	{
		catches: "v1: a request log line carrying the credentials, cookies and CSRF tokens the request sent",
		disable: (original) => ({ curlLogger: unredacted(original.curlLogger as LoggerFactory) }),
		id: "v1-curl-logger-redaction",
		module: "packages/core/src/observability/curl-logger.ts",
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
