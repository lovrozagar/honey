/* ============================================================================
 * Honey SDK — TypeScript end-to-end example
 *
 * Assumes ./sdk/ was generated via `generateTypeScriptSDK(spec, { name: "MockSDK", stem: "sdk" })`.
 * Five files are emitted: sdk.client.gen.ts, sdk.index.gen.ts, sdk.map.gen.ts,
 * sdk.runtime.gen.ts (only for x-realtime), sdk.types.gen.ts.
 * This file is DOCUMENTATION — not a compile target. Types referenced below
 * exist only after codegen.
 *
 * Demonstrates the cross-lang parity surface:
 *   1. Client init + config                   9.  Per-call headers merge
 *   2. Typed operation call                  10.  Invalidation + isStale
 *   3. Typed error hierarchy                 11.  SSE iteration
 *   4. Declared error payload (err.data)     12.  WebSocket bidi + close
 *   5. onAuthExpired + 1x 401 retry          13.  Realtime + TransportAdapter
 *   6. onRequest / onResponse hooks          14.  Streaming upload
 *   7. onLog lifecycle                       15.  x-idempotency-key
 *   8. Per-call timeout override             16.  AbortSignal cancellation
 * ========================================================================== */

import { createHash } from "node:crypto"
import {
	MockSDK,
	ClientError,
	BadRequestError,
	UnauthorizedError,
	NotFoundError,
	RateLimitError,
	InternalServerError,
	isClientError,
	createResumableConnection,
	type TransportAdapter,
	type TransportConnection,
	type TransportOpts,
	type ServerFrame,
} from "./sdk/sdk.index.gen"

const BASE_URL = process.env["BASE_URL"] ?? "http://127.0.0.1:8080"

/* §1 + §5 + §6 + §7: ClientConfig — mechanism not policy. The SDK provides
 * hooks; the consumer picks retry/log/auth strategies. */
const sdk = new MockSDK({
	baseURL: BASE_URL,
	headers: { Authorization: "Bearer expired-token" },
	/* §5: exactly 1 retry on 401 — built-in retry beyond that is a non-goal
	 * (consumer wires 5xx retry via onResponse). */
	onAuthExpired: () => Promise.resolve("valid-token"),
	/* §7: single pluggable sink — NOT a logger framework. */
	onLog: (entry) => console.debug(entry.event, entry.operation, entry.duration_ms, entry.status),
	/* §6: hooks chain in declaration order, awaited in order, may mutate ctx. */
	onRequest: [
		(ctx) => { ctx.headers["X-Trace-Id"] = crypto.randomUUID(); return Promise.resolve() },
		(ctx) => { ctx.headers["X-App"] = "example"; return Promise.resolve() },
	],
	onResponse: [
		(ctx) => { if (ctx.status >= 500) console.warn("5xx:", ctx.status); return Promise.resolve() },
	],
	throwOnError: true,
	timeout: 10_000,
})

/* §2 + §3 + §4: typed call + typed error catch. Every SDK error is a
 * ClientError subclass; isClientError() is the type-guard helper. */
try {
	const user = await sdk.createUser({ json: { email: "a@b.com", name: "Alice" } })
	console.log(user.id, user.name)
} catch (e) {
	if (e instanceof BadRequestError) {
		/* err.data is the parsed typed payload from the operation's declared error
		 * schema; err.body is raw text. Both always present on subclass instances. */
		console.error("400 data:", e.data, "body:", e.body)
	} else if (e instanceof UnauthorizedError) console.error("401")
	else if (e instanceof NotFoundError) console.error("404")
	else if (e instanceof RateLimitError) console.error("429 — backoff per consumer policy")
	else if (e instanceof InternalServerError) console.error("500")
	else if (isClientError(e)) console.error("unknown status:", (e as ClientError).status)
	else throw e
}

/* §8: per-call timeout wins over config timeout. Config is a default; the
 * per-call value is a hard override. */
try {
	await sdk.slow({ search: { ms: 200 }, timeout: 50 })
} catch (e) {
	console.error("aborted:", (e as Error).message)
}

/* §9: per-call headers merge over config headers — per-call wins per key. */
await sdk.getUser({
	headers: { "X-Both": "call-wins" },
	params: { id: "u1" },
})

/* §10: mutation invalidates matching GET paths; consumer reads isStale() to
 * decide refetch. SDK stores ONLY staleness — no cached bodies. */
await sdk.updateUser({ json: { name: "Alice2" }, params: { id: "u1" } })
const stale = sdk.isStale("GET", "/users/u1")
console.log("users/u1 stale?", stale)

/* §11: SSE — typed async iterable. Reconnect on drop is consumer-driven for
 * basic SSE (for auto-reconnect see §13 x-realtime). */
for await (const ev of sdk.streamEvents()) {
	console.log("sse event:", ev)
	break
}

/* §12: WebSocket — typed bidirectional channel. Client close returns code
 * 1000; server-initiated close surfaces a reason. */
const ws = sdk.connectWs()
await new Promise<void>((resolve) => { ws.on("open", () => resolve()) })
ws.on("message", (data: string) => {
	console.log("ws recv:", data)
	ws.close(1000, "done")
})
ws.send("hello")

/* §13: x-realtime ResumableConnection — pluggable TransportAdapter + auto
 * fallback chain (ws → sse → longpoll) + hidden proven-transport memoization.
 * Default adapter bundle is shipped; consumer can swap for custom impl. */
function makeCustomAdapter(): TransportAdapter {
	return {
		connect(_url: string, _opts: TransportOpts): TransportConnection {
			let onFrame: (f: ServerFrame) => void = () => {}
			let onClose: (r: string) => void = () => {}
			let onError: (e: unknown) => void = () => {}
			const conn: TransportConnection = {
				close() {},
				get onClose() { return onClose },
				set onClose(cb) { onClose = cb },
				get onError() { return onError },
				set onError(cb) { onError = cb },
				get onFrame() { return onFrame },
				set onFrame(cb) { onFrame = cb },
				send(_data) {},
			}
			queueMicrotask(() => {
				onFrame({ reconnectToken: "rt-1", t: "ready" })
				queueMicrotask(() => onFrame({ data: { kind: "tick" }, id: 1, t: "msg" }))
			})
			return conn
		},
	}
}
const rc = createResumableConnection({
	maxReconnectAttempts: 5,
	reconnectDelayMs: 100,
	transports: [makeCustomAdapter()],
	url: `${BASE_URL}/rt`,
})
for await (const ev of rc) {
	console.log("rt event:", ev)
	break
}
rc.close()

/* §14: streaming upload — ReadableStream<Uint8Array>. SDK pipes the stream
 * directly to fetch; no buffering (critical for CF Workers / memory-bounded
 * runtimes). */
const TOTAL = 1024 * 1024
const CHUNK = 64 * 1024
const hasher = createHash("sha256")
let sent = 0
const stream = new ReadableStream<Uint8Array>({
	pull(controller) {
		if (sent >= TOTAL) { controller.close(); return }
		const len = Math.min(CHUNK, TOTAL - sent)
		const chunk = new Uint8Array(len)
		for (let i = 0; i < len; i++) chunk[i] = (sent + i) & 0xff
		hasher.update(chunk)
		sent += len
		controller.enqueue(chunk)
	},
})
const uploaded = await sdk.uploadBlob({ body: stream })
console.log("uploaded:", uploaded.size, uploaded.hash, "expected:", hasher.digest("hex"))

/* §15: x-idempotency-key — auto UUID when caller omits; explicit
 * idempotencyKey option; headers["Idempotency-Key"] wins over both. */
const auto = await sdk.idempotentCreate()
const explicit = await sdk.idempotentCreate({ idempotencyKey: "user-supplied-123" })
const viaHeader = await sdk.idempotentCreate({ headers: { "Idempotency-Key": "header-wins-456" } })
console.log(auto.idempotencyKey, explicit.idempotencyKey, viaHeader.idempotencyKey)

/* §16: cancellation via AbortSignal. Idiomatic TS; propagates to fetch. */
const ctrl = new AbortController()
setTimeout(() => ctrl.abort(), 25)
try {
	await sdk.slow({ search: { ms: 500 }, signal: ctrl.signal })
} catch (e) {
	console.error("cancelled:", (e as Error).name)
}
