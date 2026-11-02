/**
 * HTTP Basic for a served document: the guard `basic()` builds, the header parse at the network edge,
 * and the constant-time pair check. Nothing here reaches the router or the generator, and a serving call
 * reaches it only through a guard, so a document served without one carries none of it.
 */
import { HoneyError } from "../errors/error.ts"
import type { RuntimeMiddleware } from "../middleware/middleware.ts"
import { withHeaders } from "../response/with-headers.ts"
import { timingSafeEqual } from "../security/crypto.ts"

declare const SERVED_AUTH: unique symbol

/** A guard `basic()` built: opaque, so no app hand-builds one and skips the realm check. */
export type ServedAuth = { readonly [SERVED_AUTH]: true }

/** A username and password, as a Basic credential carries them. */
export type Credentials = {
	/** Everything after the first `:`, so it may hold colons itself. */
	readonly password: string
	/** Everything before the first `:`. */
	readonly username: string
}

/** What `basic` takes: the realm a browser names in its prompt, and the check of each request's pair. */
export type BasicAuthOptions<E = unknown> = {
	/** Named in the browser's prompt; text with no quote or control character. */
	readonly realm: string
	/**
	 * Whether the pair may read the document. A throw is a fault, answered 500, never a refusal.
	 */
	readonly verify: (
		input: Credentials & {
			/** The request's runtime env, such as Workers bindings. */
			readonly env: E
		},
	) => boolean | Promise<boolean>
}

/** What a guarded route's handler reads of its context. */
type GuardedContext = { readonly env: unknown; readonly req: Request }

/**
 * One serving call's guard: the middleware in front of each route it mounts, and the wrap around each
 * handler. A refused request is thrown as `unauthorized`, a key the middleware declares so an app
 * enforcing its errors answers it too, and its answer from the app's error boundary is stamped with the
 * challenge and `no-store` whatever onError made of it; every other answer is `private, no-store` with no
 * validator. A throw in `verify` reaches the boundary as itself, a 500.
 */
export type Guard = {
	readonly stamp: RuntimeMiddleware
	readonly wrap: <C extends GuardedContext>(handler: (ctx: C) => unknown) => (ctx: C) => Promise<unknown>
}

/** What a guard is made of: a fresh `Guard` for each serving call. */
export type GuardFactory = { readonly guard: () => Guard }

/**
 * The pair a `Basic` Authorization header carries, split at the first `:`; null for any other
 * scheme, base64 that does not decode, bytes that are not UTF-8, or no colon.
 */
export function parseBasic(header: string | null): Credentials | null {
	const encoded = /^basic +([A-Za-z0-9+/]+={0,2}) *$/i.exec(header ?? "")?.[1]
	if (encoded === undefined) return null
	let text: string
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)))
	} catch {
		/* not base64, or not UTF-8: no Basic pair, which the guard refuses */
		return null
	}
	const colon = text.indexOf(":")
	return colon === -1 ? null : { password: text.slice(colon + 1), username: text.slice(0, colon) }
}

/**
 * The guard for `auth`: a request whose Basic pair `verify` accepts reads the document, any other is
 * answered 401 with a challenge naming `realm`. Throws when `realm` cannot be quoted in the challenge.
 */
export function basic<E = unknown>(options: BasicAuthOptions<E>): ServedAuth {
	const { realm, verify } = options
	if (realm === "" || /[\p{Cc}"]/u.test(realm))
		throw new TypeError(`basic: realm ${JSON.stringify(realm)} must be text with no quote or control character`)
	const challenge = `Basic realm="${realm}", charset="UTF-8"`
	const allows = async ({ env, req }: GuardedContext) => {
		const given = parseBasic(req.headers.get("authorization"))
		return given !== null && (await verify({ ...given, env: env as E }))
	}
	const guard = (): Guard => {
		const refused = new WeakSet<object>()
		const stamp: RuntimeMiddleware = async (ctx, next) =>
			withHeaders(await next(), (headers) => {
				if (refused.has(ctx)) {
					headers.set("www-authenticate", challenge)
					headers.set("cache-control", "no-store")
					return
				}
				headers.set("cache-control", "private, no-store")
				headers.delete("etag")
			})
		Object.defineProperties(stamp, { errors: { value: ["unauthorized"] }, name: { value: "servedAuth" } })
		return {
			stamp,
			wrap: (handler) => async (ctx) => {
				if (await allows(ctx)) return handler(ctx)
				refused.add(ctx)
				throw new HoneyError({ errorKey: "unauthorized", status: "unauthorized" })
			},
		}
	}
	const factory: GuardFactory = { guard }
	return factory as unknown as ServedAuth
}

/**
 * Whether `given` is `expected`: both fields compared in constant time, both always, so the answer's
 * timing says nothing about which one differed.
 */
export async function credentialsMatch(given: Credentials, expected: Credentials): Promise<boolean> {
	const [username, password] = await Promise.all([
		timingSafeEqual(given.username, expected.username),
		timingSafeEqual(given.password, expected.password),
	])
	return username && password
}
