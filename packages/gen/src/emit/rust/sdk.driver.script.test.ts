/**
 * The Rust test driver's script (contract 19 §4.5, the Go `sdk.driver.script.test.ts` analog): the script a
 * unit test adds beside a grid cell, decoded strictly; `{observed, trace}` on stdout, the trace's errors read
 * through the SDK's accessors (`Trace<RustError>`); client config, hooks, refresh, log, cancel and sleep; the
 * `bytes` outcome's hand-written SHA-256 (Fc3) against node:crypto; binary bodies, the idempotency key and typed
 * response headers; and what the driver refuses. Driven against `http` and `http-safe`.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { RustError, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { compiledRust } from "./__fixtures__/compiled.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/driven.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const MEMBERS: Call = {
	operation: "members.get",
	params: { org: "o", "user-id": "u" },
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
}
const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 }
const FOUND: Reply = { json: { id: "u", name: "n" }, status: 200 }
const DATA = { data: { id: "u", name: "n" }, kind: "data", status: 200 }

/** The sizes the SHA-256 is checked at: around each block boundary (55 and 56 change the padding), and large. */
const SIZES = [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 256, 4096, 65_536]

/** `size` bytes `i & 0xff`, the grid's binary body and the recording server's `bytes` reply. */
const bytes = (size: number) => Buffer.from(Array.from({ length: size }, (_, i) => i & 0xff))
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex")

/** A program over the dependency-free `cache` crate printing the driver's `sha256_hex` of each size on stdin. */
const SHA_MAIN = `mod sha256;

use std::io::Read;

fn main() {
    let mut sizes = String::new();
    std::io::stdin().read_to_string(&mut sizes).expect("stdin");
    for size in sizes.split_whitespace() {
        let n: usize = size.parse().expect("a size");
        let data: Vec<u8> = (0..n).map(|i| (i & 0xff) as u8).collect();
        println!("{}", sha256::sha256_hex(&data));
    }
}
`

/** A 300-byte binary body for `files.put`, sent once as a stream when `oneShot`. */
const putFile = (oneShot: boolean): Call => ({
	body: { contentType: "application/octet-stream", kind: "binary", size: 300 },
	operation: "files.put",
	params: { name: oneShot ? "b" : "a" },
	route: { method: "PUT", path: "/files/{name}" },
})
const ORDER: Call = {
	body: { kind: "json", value: { sku: "s" } },
	operation: "orders.create",
	route: { method: "POST", path: "/orders" },
}
const ITEM: Call = { operation: "items.get", params: { id: "i1" }, route: { method: "GET", path: "/items/{id}" } }

/** The answers to two uploads, an order, an item with its typed headers, and one without its required header. */
const BODY_REPLIES: readonly Reply[] = [
	{ json: { size: 300 }, status: 200 },
	{ json: { size: 300 }, status: 200 },
	{ json: { id: "o1" }, status: 201 },
	{ headers: { "x-etag": "e1", "x-item-version": "3" }, json: { id: "i1", name: "n" }, status: 200 },
	{ json: { id: "i1", name: "n" }, status: 200 },
]

/** The registry SDK `key` compiled with the driver, which must build. */
function driven(key: "http" | "http-safe"): DrivenRustSdk {
	const sdk = drivenRustSdk(key)
	expect(sdk.built, sdk.stderr).toBe(true)
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup }

/** `calls` run by `sdk` under `options` against a server answering `replies`: the run, the hops and the origin. */
async function drive(sdk: DrivenRustSdk, replies: readonly Reply[], calls: readonly Call[], options: Options) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: options.setup ?? {} }, server, options.script)
		return { hops: [...server.hops], run, url: server.url }
	})
}

/** A 307 to `to` on the `origin` listener. */
const hop = (origin: "alt" | "primary", to: string): Reply => ({ redirect: { origin, path: to }, status: 307 })

/** A hook trace entry with the stale fields of a client without invalidation. */
const hook = (entry: Record<string, unknown>) => ({
	invalidatedBy: [],
	isRetry: false,
	isStale: false,
	selector: "",
	...entry,
})

/** A Rust error as the trace records it: no source and the method's own Err unless given, any Debug text. */
const plain = (entry: Partial<RustError>) => ({ debug: expect.any(String), source: false, via: "return", ...entry })

describe.skipIf(!RUST)("the driver's SHA-256 (Fc3): hand-written, test-side only, checked against node:crypto", () => {
	it("digests i & 0xff bytes as node does at every block boundary, padding edge and large size", async () => {
		const source = readFileSync(join(import.meta.dirname, "__fixtures__/driver/sha256.rs"), "utf8")
		const crate = compiledRust("cache", { programs: { sha: { "main.rs": SHA_MAIN, "sha256.rs": source } } })
		expect(crate.built, crate.stderr).toBe(true)
		const sizes = [...SIZES, 1 << 20]
		const ran = await crate.exec("sha", sizes.join(" "))
		expect({ digests: ran.stdout.trim().split("\n"), status: ran.status }, ran.stderr).toEqual({
			digests: sizes.map((size) => digest(bytes(size))),
			status: 0,
		})
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust test driver's script: {observed, trace} on stdout", () => {
	it("records each call's time, a no-op hook per phase, no log and no refresh for an empty script", async () => {
		const { run, url } = await drive(driven("http"), [OK], [ECHO], { script: {} })
		expect({ observed: run.observed, status: run.status, trace: run.trace }, run.stderr).toEqual({
			observed: [OK_DATA],
			status: 0,
			trace: {
				authExpired: 0,
				calls: [{ elapsedMs: expect.any(Number) }],
				hooks: [
					hook({ call: 0, index: 0, method: "GET", path: "/echo", phase: "request", url: `${url}/echo` }),
					hook({ call: 0, index: 0, phase: "response", status: 200 }),
				],
				log: [],
			},
		})
	}, 600_000)

	it("sets the auth header name and prefix, and records on_log with each entry's duration under logDurations", async () => {
		const script: Script = {
			config: { authHeaderName: "X-Token", authHeaderPrefix: "Token " },
			log: true,
			logDurations: true,
		}
		const setup: Setup = { auth: { kind: "bearer", token: "tok" } }
		const { hops, run } = await drive(driven("http"), [OK, OK], [ECHO, ECHO], { script, setup })
		const log = run.trace?.log ?? []
		const operation = "GET /echo"
		const entries = [
			{ event: "request_start", level: "debug", operation },
			{ event: "response_received", level: "info", operation, status: 200 },
		]
		expect(
			{
				auth: hops.map((h) => [h.headers["x-token"], h.headers.authorization]),
				durations: log.map((entry) => Number.isInteger(entry.durationMs) && (entry.durationMs ?? -1) >= 0),
				log: log.map((entry) => ({ ...entry, durationMs: undefined })),
			},
			run.stderr,
		).toEqual({
			auth: [
				["Token tok", undefined],
				["Token tok", undefined],
			],
			durations: [true, true, true, true],
			log: [...entries, ...entries],
		})
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust test driver's script: client config", () => {
	it("turns on invalidation: a read after a mutation sees its concrete selector stale, by the mutation", async () => {
		const create: Call = {
			body: { kind: "json", value: { name: "a" } },
			operation: "users.create",
			route: { method: "POST", path: "/users" },
		}
		const read: Call = { operation: "users.get", params: { id: "u1" }, route: { method: "GET", path: "/users/{id}" } }
		const script: Script = { config: { invalidation: { staleTimeMs: 60_000 } } }
		const replies: Reply[] = [
			{ json: { id: "u1" }, status: 200 },
			{ json: { id: "u1" }, status: 200 },
		]
		const { run } = await drive(driven("http"), replies, [create, read], { script })
		expect(
			run.trace?.hooks.map((h) => [h.phase, h.selector, h.isStale, h.invalidatedBy]),
			run.stderr,
		).toEqual([
			["request", "POST /users", false, []],
			["response", "POST /users", false, []],
			["request", "GET /users/u1", true, ["POST /users"]],
			["response", "GET /users/u1", true, ["POST /users"]],
		])
	}, 600_000)

	it("caps a buffered answer by maxResponseBytes: observed as transport, the SDK's Transport variant", async () => {
		const script: Script = { config: { maxResponseBytes: 10 } }
		const replies: Reply[] = [{ bytes: 64, headers: { "content-type": "application/json" }, status: 200 }]
		const { run } = await drive(driven("http"), replies, [ECHO], { script })
		expect({ error: run.trace?.calls[0]?.error, observed: run.observed, status: run.status }, run.stderr).toEqual({
			error: plain({ source: true, text: "transport: the answer exceeds 10 bytes", variant: "Transport" }),
			observed: [{ kind: "transport" }],
			status: 0,
		})
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust test driver's script: on_auth_expired and the hooks", () => {
	it("answers on_auth_expired from its tokens in order, then fails it; a retry's hooks see isRetry", async () => {
		const script: Script = { onAuthExpired: { tokens: ["new"] } }
		const replies: Reply[] = [{ status: 401 }, FOUND, { status: 401 }]
		const setup: Setup = { auth: { kind: "bearer", token: "old" } }
		const { hops, run } = await drive(driven("http"), replies, [MEMBERS, MEMBERS], { script, setup })
		const requests = run.trace?.hooks.filter((h) => h.phase === "request")
		expect(
			{
				auth: hops.map((h) => h.headers.authorization),
				error: run.trace?.calls[1]?.error,
				expired: run.trace?.authExpired,
				observed: run.observed,
				retries: requests?.map((h) => [h.call, h.isRetry]),
			},
			run.stderr,
		).toEqual({
			auth: ["Bearer old", "Bearer new", "Bearer new"],
			error: plain({ text: "on_auth_expired: config: driver: no token left", variant: "AuthExpired" }),
			expired: 2,
			observed: [DATA, null],
			retries: [
				[0, false],
				[0, true],
				[1, false],
			],
		})
	}, 600_000)

	it("runs the scripted hooks in order: a set header is sent, a body replaced, a failure ends the call as Hook", async () => {
		const sdk = driven("http")
		const hooks: Script["hooks"] = {
			request: [{ setHeader: ["X-Hooked", "1"] }, {}],
			response: [{ body: '{"ok":false}' }],
		}
		const shaped = await drive(sdk, [OK], [ECHO], { script: { hooks } })
		const failing = (request: { fail: string }[], response: { fail: string }[]) =>
			drive(sdk, [OK], [ECHO], { script: { hooks: { request, response } } })
		const [before, after] = await Promise.all([failing([{ fail: "boom" }], []), failing([], [{ fail: "bad" }])])
		const ended = (r: typeof before) => [r.run.observed, r.run.trace?.calls[0]?.error, r.hops.length]
		expect({
			after: ended(after),
			before: ended(before),
			observed: shaped.run.observed,
			order: shaped.run.trace?.hooks.map((h) => `${h.phase} ${h.index}`),
			sent: shaped.hops[0]?.headers["x-hooked"],
		}).toEqual({
			after: [[null], plain({ source: true, text: "hook: bad", variant: "Hook" }), 1],
			before: [[null], plain({ source: true, text: "hook: boom", variant: "Hook" }), 0],
			observed: [{ data: { ok: false }, kind: "data", status: 200 }],
			order: ["request 0", "request 1", "response 0"],
			sent: "1",
		})
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust test driver's script: a caller's http_builder", () => {
	it("sends through a caller http_builder: its user agent on every hop of a redirect, and no transport count", async () => {
		const sdk = driven("http")
		const script: Script = { config: { httpClient: true } }
		const same = await drive(sdk, [hop("primary", "/landing"), OK], [ECHO], { script })
		const setup: Setup = { auth: { kind: "bearer", token: "t" }, redirect: "follow" }
		const cross = await drive(sdk, [hop("alt", "/landing"), OK], [ECHO], { script, setup })
		const seen = ({ hops, run }: Awaited<ReturnType<typeof drive>>) => ({
			hops: hops.map((h) => `${h.origin} ${h.url} ${h.headers["user-agent"]} ${h.headers.authorization ?? "-"}`),
			observed: run.observed,
			transport: run.trace?.transport,
		})
		expect({ cross: seen(cross), same: seen(same) }).toEqual({
			cross: {
				hops: ["primary /echo honey-driver Bearer t", "alt /landing honey-driver -"],
				observed: [OK_DATA],
				transport: undefined,
			},
			same: {
				hops: ["primary /echo honey-driver -", "primary /landing honey-driver -"],
				observed: [OK_DATA],
				transport: undefined,
			},
		})
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust test driver's script: cancel and sleep", () => {
	it("cancels before a call (nothing sent) or during it, and sleeps before a call outside its elapsedMs", async () => {
		const script: Script = { calls: [{ cancel: "before" }, { cancel: { afterMs: 300 } }, { sleepMs: 1000 }] }
		const late: Reply = { ...OK, delayMs: 2000 }
		const started = Date.now()
		const { hops, run } = await drive(driven("http"), [late, OK], [ECHO, ECHO, ECHO], { script })
		const calls = run.trace?.calls ?? []
		expect(
			{
				errors: calls.map((c) => c.error),
				hops: hops.length,
				observed: run.observed,
				quick: calls.map((c) => c.elapsedMs < 1500),
				slept: Date.now() - started >= 1000 && (calls[2]?.elapsedMs ?? 1000) < 1000,
			},
			run.stderr,
		).toEqual({
			errors: [
				plain({ text: "the call was canceled", variant: "Canceled" }),
				plain({ text: "the call was canceled", variant: "Canceled" }),
				undefined,
			],
			hops: 1 + 1,
			observed: [null, null, OK_DATA],
			quick: [true, true, true],
			slept: true,
		})
	}, 600_000)
})

describe.skipIf(!RUST)(
	"the Rust test driver's script: request bodies, the idempotency key and typed response headers",
	() => {
		it("sends a binary body in memory or one-shot, the idempotency key it sets, and reads typed response headers", async () => {
			const script: Script = { calls: [null, { oneShotBody: true }, { idempotencyKey: "k-1" }] }
			const calls = [putFile(false), putFile(true), ORDER, ITEM, ITEM]
			const { hops, run } = await drive(driven("http"), BODY_REPLIES, calls, { script })
			const sent = digest(bytes(300))
			expect(
				{
					bodies: hops.slice(0, 2).map((h) => [h.body.sha256, h.body.size, h.headers["content-length"] ?? "-"]),
					error: run.trace?.calls[4]?.error,
					key: hops[2]?.headers["idempotency-key"],
					observed: run.observed,
				},
				run.stderr,
			).toEqual({
				bodies: [
					[sent, 300, "300"],
					[sent, 300, "-"],
				],
				error: plain({ text: "decode: the X-Item-Version header is missing", variant: "Decode" }),
				key: "k-1",
				observed: [
					{ data: { size: 300 }, kind: "data", status: 200 },
					{ data: { size: 300 }, kind: "data", status: 200 },
					{ data: { id: "o1" }, kind: "data", status: 201 },
					{
						data: { id: "i1", name: "n" },
						headers: { "x-etag": "e1", "x-item-version": "3" },
						kind: "data",
						status: 200,
					},
					{ kind: "decode", status: 200 },
				],
			})
		}, 600_000)
	},
)

describe.skipIf(!RUST)("the Rust test driver's script: the bytes outcome", () => {
	it("observes a binary answer as its size and SHA-256, equal to node's at every block boundary", async () => {
		const files: Call[] = SIZES.map((size) => ({
			operation: "files.get",
			params: { name: `f${size}` },
			route: { method: "GET", path: "/files/{name}" },
		}))
		const replies: Reply[] = SIZES.map((size) => ({
			bytes: size,
			headers: { "content-type": "application/octet-stream" },
			status: 200,
		}))
		const { run } = await drive(driven("http"), replies, files, {})
		expect({ observed: run.observed, status: run.status }, run.stderr).toEqual({
			observed: SIZES.map((size) => ({ kind: "bytes", sha256: digest(bytes(size)), size, status: 200 })),
			status: 0,
		})
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust test driver's script: a call's Rust error", () => {
	it("traces an error status through ApiError's accessors; safe mode's via result and SdkResult", async () => {
		const missing: Reply = { json: { error_key: "member.missing", message: "gone" }, status: 404 }
		const [thrown, safe] = await Promise.all([
			drive(driven("http"), [missing], [MEMBERS], { script: {} }),
			drive(driven("http-safe"), [missing, FOUND], [MEMBERS, MEMBERS], { script: {} }),
		])
		const error = plain({
			debug: expect.stringMatching(/^Api\(ApiError \{ status: 404, /),
			key: "member.missing",
			keyVariant: 'Some(Other("member.missing"))',
			kind: "NotFound",
			message: "gone",
			status: 404,
			text: "HTTP 404: gone",
			variant: "Api",
		})
		const observed = { body: missing.json, errorKey: "member.missing", kind: "error", status: 404 }
		expect({ safe: safe.run.trace?.calls, thrown: thrown.run.trace?.calls }, thrown.run.stderr).toEqual({
			safe: [
				{
					elapsedMs: expect.any(Number),
					error: { ...error, via: "result" },
					result: { data: false, ok: false, response: true, status: 404 },
				},
				{ elapsedMs: expect.any(Number), result: { data: true, ok: true, response: true, status: 200 } },
			],
			thrown: [{ elapsedMs: expect.any(Number), error }],
		})
		expect({ safe: safe.run.observed, thrown: thrown.run.observed }).toEqual({
			safe: [observed, DATA],
			thrown: [observed],
		})
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust test driver's script: an Api error's envelope", () => {
	it("adds an Api error's envelope under envelope, its set members and extra keys, never unasked or for another error", async () => {
		const fields = { text: [{ error_key: "too_short", message: "short", path: "text" }] }
		const sent = { error_key: "bad_request", fields, message: "Bad request", status: 400, status_key: "bad_request" }
		const bad: Reply = { json: { ...sent, success: false, trace: "t1" }, status: 400 }
		const refused: Call = { ...MEMBERS, params: { org: "..", "user-id": "u" } }
		const calls = [MEMBERS, MEMBERS, refused]
		const asked: Script = { calls: [{ envelope: true }, null, { envelope: true }] }
		const { hops, run } = await drive(driven("http"), [bad, bad], calls, { script: asked })
		const [enveloped, unasked, path] = run.trace?.calls ?? []
		expect(
			{
				envelope: enveloped?.error?.envelope,
				hops: hops.length,
				path: path?.error,
				unasked: unasked?.error !== undefined && !("envelope" in unasked.error),
			},
			run.stderr,
		).toEqual({
			envelope: { ...sent, extraKeys: ["success", "trace"] },
			hops: 2,
			path: plain({
				text: 'path param: "org" is empty, "." or "..", which no path segment can be',
				variant: "PathParam",
			}),
			unasked: true,
		})
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust test driver's script: what it refuses", () => {
	it("exits 1 naming the reason, nothing sent: an unknown member, Go's directives, a multipart call, a key the method has no field for, extra calls", async () => {
		const sdk = driven("http")
		const upload: Call = {
			body: { kind: "json", value: {} },
			operation: "files.upload",
			route: { method: "POST", path: "/upload" },
		}
		const refused: [Call, Script][] = [
			[ECHO, { calls: [{ sleepMs: 1, wait: 2 } as never] }],
			[ECHO, { calls: [{ ctxTimeoutMs: 100 }] }],
			[ECHO, { calls: [{ isKeys: ["other"] }] }],
			[upload, {}],
			[ECHO, { calls: [{ idempotencyKey: "k" }] }],
			[ECHO, { calls: [null, null] }],
			[ECHO, { logDurations: true }],
			[{ ...ECHO, take: 1 }, {}],
		]
		const [runs, hops] = await served([], async (server) => {
			const ran = await Promise.all(refused.map(([call, script]) => sdk.runCalls({ calls: [call] }, server, script)))
			return [ran, server.hops.length] as const
		})
		expect({ hops, runs: runs.map((run) => [run.status, run.observed, run.trace]) }).toEqual({
			hops: 0,
			runs: refused.map(() => [1, undefined, undefined]),
		})
		expect(runs.map((run) => run.stderr.trim())).toEqual([
			expect.stringMatching(/^driver: script: unknown field `wait`/),
			"driver: script: call 0: ctxTimeoutMs is Go's ctx deadline; a Rust call is bounded by timeoutMs",
			"driver: script: call 0: isKeys is Go's errors.Is; the Rust trace records key()",
			"driver: call 0 (files.upload): a multipart body is driven by a consumer program (FilePart)",
			"driver: call 0 (echo.get): the script sets idempotencyKey, and the method has no idempotency key field",
			"driver: script: 2 calls scripted for a cell of 1",
			"driver: script: logDurations needs log",
			"driver: call 0 (echo.get): take on an operation that does not stream",
		])
	}, 600_000)
})
