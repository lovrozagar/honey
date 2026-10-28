/**
 * `uploads(options)` (bit 21 g, H24.5), `@lovrozagar/honey/mcp/uploads`: out-of-band file uploads for the mounted MCP
 * endpoint, handed to `mcp(app, path, handler, { uploads: uploads(options) })`. An ordinary import (H23), so an app
 * that mounts MCP without it bundles none of this. The generated handler asks for an upload when a 2026-07-28 call
 * declares the file-uploads extension and sends a file's metadata without its bytes; here are the rest:
 * - **The token**, one a file, is the upload's only authority (the client sends no credential to it): HMAC-SHA-256
 *   under the app's secret over a random id, the expiry, the declared size and SHA-256, the principal, and the call.
 *   The principal is HMAC(secret, the credential headers the request carried), keyed so a leaked token or store gives
 *   no offline guess at the credential; the call is HMAC(secret, the tool, every argument canonically, the file's id).
 *   Nothing of either reaches the app's routes.
 * - **The upload route**, `PUT <path>/uploads/<token>`, a real route on the handle (its basePath and every middleware,
 *   bodyLimit included, apply; internal and served, so out of every document and the tool set). A forged or expired
 *   token is 403. The body is read as it streams, past the declared size 413 (Content-Length never trusted), then
 *   checked to be exactly that size (400) with that SHA-256 (400). Only then is it claimed, atomically, by the store:
 *   the first claim wins, any later PUT is 409, and the bytes are kept. A refused PUT keeps nothing and claims
 *   nothing, so the client's own retry of a failed transfer (the draft's three attempts) can still land.
 * - **The retry** takes each file's bytes once, from the store, after the token is checked again against the
 *   retry's own credential and call: a credential that changed since (say a refreshed OAuth token) no longer matches,
 *   so the call is refused and the client uploads again.
 */
import type { HoneyContext } from "../context/context.ts"
import type { TypedResponse } from "../response/response.ts"
import { joinPatterns, parsePattern } from "../routing/pattern.ts"
import { assertRouteFree, GRAPH, type HandleView, type HoneyGraph, SERVED, VIEW } from "../routing/register.ts"
import type { McpUploading, McpUploads } from "./mount.ts"

/**
 * Where uploads wait for their call's retry. Each method may be async. On Workers, the atomic claim and take are a D1
 * row or a Durable Object's (`INSERT … ON CONFLICT DO NOTHING`, `DELETE … RETURNING`) and the bytes R2's, since either
 * row holds at most 2 MB; KV is eventually consistent, so two claims can both succeed there, and it cannot keep an
 * upload one-shot.
 */
export type UploadStore = {
	/** marks `id` used, atomically: true for its first claim alone; it need be kept only until `expires` (ms epoch) */
	readonly claim: (id: string, expires: number) => boolean | Promise<boolean>
	/** keeps a claimed upload's checked bytes until they are taken or `expires` passes */
	readonly put: (id: string, bytes: Uint8Array, expires: number) => void | Promise<void>
	/** the bytes kept under `id`, removed as they are returned, atomically, so one caller alone gets them */
	readonly take: (id: string) => Uint8Array | undefined | Promise<Uint8Array | undefined>
}

/** The options of `uploads()`. */
export type McpUploadsOptions = {
	/** the HMAC key its tokens are signed with: at least 32 characters, the app's own secret */
	readonly secret: string
	/** where uploads wait for their call's retry */
	readonly store: UploadStore
	/** how long a token works, in ms: 10 minutes by default */
	readonly ttlMs?: number
	/** the most bytes one file may declare: 50 MiB by default */
	readonly maxBytes?: number
	/** the endpoint's public origin, for an app whose requests do not carry it (behind a proxy) */
	readonly origin?: string
}

/** The handle the hook registers on, as far as it reads one. */
type Handle = {
	readonly [GRAPH]: HoneyGraph
	readonly [VIEW]: HandleView
	put(path: string): { meta(meta: object): { handler(fn: (ctx: Ctx) => Promise<TypedResponse>): unknown } }
}
type Ctx = HoneyContext & { readonly res: { raw(response: Response): TypedResponse } }

/** A token's fields, in its order; the MAC follows them. */
type Fields = [id: string, expires: string, size: string, digest: string, principal: string, call: string]

// per-process-constant: text-codec
const TEXT = /* @__PURE__ */ new TextEncoder()

/** `bytes` as base64url, unpadded. */
const base64url = (bytes: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replace(/=+$/, "")
		.replaceAll("+", "-")
		.replaceAll("/", "_")

/** `bytes`' SHA-256 as a FileInput's digest: base64url, unpadded. */
async function digestOf(bytes: Uint8Array): Promise<string> {
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))
	return base64url(hash)
}

/** `value` as JSON with every object's keys sorted, so equal arguments are equal text whatever their order. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	/* arguments are JSON, so every other value has its JSON text */
	if (value === null || typeof value !== "object") return JSON.stringify(value) as string
	const object = value as Record<string, unknown>
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
		.join(",")}}`
}

/** `request`'s body, at most `max` bytes counted as they stream; undefined past it. */
async function bodyOf(request: Request, max: number): Promise<Uint8Array | undefined> {
	const chunks: Uint8Array[] = []
	let size = 0
	const reader = request.body?.getReader()
	for (let read = await reader?.read(); read && !read.done; read = await reader?.read()) {
		if ((size += read.value.length) > max) return void (await reader?.cancel())
		chunks.push(read.value)
	}
	return new Uint8Array(await new Blob(chunks as Uint8Array<ArrayBuffer>[]).arrayBuffer())
}

/** A refusal of the upload route, its rule as text. */
const refused = (status: number, rule: string) => new Response(rule, { status })

/** A refusal of `uploads()`'s options, saying why. */
const refuse = (why: string) => new Error(`uploads(): ${why}`)

/** Whether `value` is a whole number of at least `least`. */
const whole = (value: number, least: number) => Number.isSafeInteger(value) && value >= least

/** The MACs under `secret`, each naming what it signs so no value of one kind passes for another. */
function signer(secret: string) {
	const key = crypto.subtle.importKey("raw", TEXT.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"])
	const mac = async (kind: string, text: string) =>
		base64url(await crypto.subtle.sign("HMAC", await key, TEXT.encode(`${kind}\n${text}`)))
	return {
		call: (tool: string, args: Record<string, unknown>, id: string) => mac("call", canonical([tool, args, id])),
		principal: (credential: string) => mac("principal", credential),
		/** `fields` as a token: each, then their MAC */
		token: async (fields: Fields) => `${fields.join(".")}.${await mac("upload", fields.join("."))}`,
		/** `token`'s fields when this app signed it; its expiry unchecked */
		signed: async (token: string): Promise<Fields | undefined> => {
			const parts = token.split(".")
			const fields = parts.slice(0, 6) as Fields
			return parts.length === 7 && (await mac("upload", fields.join("."))) === parts[6] ? fields : undefined
		},
	}
}

type Signer = ReturnType<typeof signer>

/** The upload route's answer to a PUT of `token`: the bytes kept under its claim, else the rule broken. */
async function stored(sign: Signer, store: UploadStore, token: string, request: Request): Promise<Response> {
	const fields = await sign.signed(token)
	if (fields === undefined) return refused(403, "the upload token is not this app's")
	const [id, expires, size, digest] = fields
	if (Date.now() > Number(expires)) return refused(403, "the upload token has expired")
	const bytes = await bodyOf(request, Number(size))
	if (bytes === undefined) return refused(413, `the upload is past its ${size} bytes`)
	if (bytes.length !== Number(size)) return refused(400, `the upload is not its ${size} bytes`)
	if ((await digestOf(bytes)) !== digest) return refused(400, "the upload does not match its digest")
	if (!(await store.claim(id, Number(expires)))) return refused(409, "the upload token is used")
	await store.put(id, bytes, Number(expires))
	return new Response(null, { status: 204 })
}

/** One request's uploads under `base`: a file's token, and on the retry its bytes, taken once. */
function uploading(sign: Signer, store: UploadStore, limits: { ttlMs: number; maxBytes: number }, base: string) {
	const upload: McpUploading = {
		base,
		issue: async ({ args, credential, tool }, file) =>
			sign.token([
				base64url(crypto.getRandomValues(new Uint8Array(16))),
				String(Date.now() + limits.ttlMs),
				String(file.size),
				file.digest,
				await sign.principal(credential),
				await sign.call(tool, args, file.id),
			]),
		max: limits.maxBytes,
		take: async ({ args, credential, tool }, file, token) => {
			const fields = await sign.signed(token)
			if (fields === undefined) throw new Error("requestState holds no upload token of this app's")
			const [id, expires, size, digest, principal, call] = fields
			if (Date.now() > Number(expires)) throw new Error("requestState's upload token has expired")
			if (principal !== (await sign.principal(credential)))
				throw new Error("requestState's upload was made under another credential")
			if (call !== (await sign.call(tool, args, file.id))) throw new Error("requestState's upload is another call's")
			const bytes = await store.take(id)
			if (bytes === undefined) return "was not uploaded, or its upload was taken"
			const intact = bytes.length === Number(size) && (await digestOf(bytes)) === digest
			return intact ? bytes : "does not match its upload's digest"
		},
	}
	return upload
}

/** The uploads hook for `mcp()`'s `uploads`: `options` refused now when they cannot work. */
export function uploads(options: McpUploadsOptions): McpUploads {
	const { maxBytes = 52_428_800, origin, secret, store, ttlMs = 600_000 } = options
	if (secret.length < 32) throw refuse("secret needs at least 32 characters, the app's own")
	if (!whole(ttlMs, 1)) throw refuse("ttlMs is no whole number of milliseconds")
	if (!whole(maxBytes, 0)) throw refuse("maxBytes is no whole number of bytes")
	if (origin !== undefined && (!URL.canParse(origin) || new URL(origin).origin !== origin))
		throw refuse(`origin ${origin} is no origin: a scheme, a host and a port alone`)
	const sign = signer(secret)
	return (app, at) => {
		const handle = app as Handle
		const graph = handle[GRAPH]
		const route = joinPatterns(at, "uploads/:token")
		assertRouteFree(graph, "PUT", parsePattern(joinPatterns(handle[VIEW].basePath, route)))
		/* the URL a client PUTs to: the prefix the app strips, the basePath, the route */
		const tail = joinPatterns(graph.settings.stripPrefix ?? "/", joinPatterns(handle[VIEW].basePath, at))
		handle
			.put(route)
			.meta({ internal: true, [SERVED]: true })
			.handler(async (ctx) => ctx.res.raw(await stored(sign, store, ctx.params.token as string, ctx.req)))
		return (request) =>
			uploading(
				sign,
				store,
				{ maxBytes, ttlMs },
				`${origin ?? new URL(request.url).origin}${tail.replace(/\/$/, "")}/uploads`,
			)
	}
}

/**
 * An in-memory UploadStore, for one process: development, tests, a single Node or Bun server. Its claim is atomic
 * (no await between its check and its mark). Not for Workers or any app on more than one instance: each isolate has
 * its own memory, so an upload PUT to one is missing on another.
 */
export function memoryUploadStore(): UploadStore {
	const claims = new Map<string, number>()
	const kept = new Map<string, { readonly bytes: Uint8Array; readonly expires: number }>()
	return {
		claim: (id, expires) => {
			const now = Date.now()
			for (const [each, until] of claims) if (until < now) claims.delete(each)
			for (const [each, upload] of kept) if (upload.expires < now) kept.delete(each)
			if (claims.has(id)) return false
			claims.set(id, expires)
			return true
		},
		put: (id, bytes, expires) => void kept.set(id, { bytes, expires }),
		take: (id) => {
			const upload = kept.get(id)
			kept.delete(id)
			return upload && upload.expires >= Date.now() ? upload.bytes : undefined
		},
	}
}
