/**
 * `remoteJwks(url)`: an issuer's published keys for `verifyJwt`. Its state lives in the source it returns, so create
 * one per issuer, once, and pass it to every verify.
 */
import { ALGORITHMS, type AsymmetricAlgorithm, type Jwk, type JwtHeader } from "./jws.ts"

/** The header a key is looked up for: its `alg` already passed the verify's `algorithms`. */
export type JwkLookup = JwtHeader & {
	/** The algorithm the key must be for. */
	alg: AsymmetricAlgorithm
}

/**
 * Finds the key that verifies a token: `null` when the issuer has no such key, which `verifyJwt` answers as
 * `unknown_key`. It throws only when it cannot tell, so an outage never reads as a forged token.
 */
export type JwkSource = (header: JwkLookup) => Promise<Jwk | null>

/** How `remoteJwks` keeps an issuer's keys. Each default suits a public issuer. */
export type RemoteJwksOptions = {
	/** How long keys are used before they are fetched again, in ms. Default 10 minutes. */
	maxAgeMs?: number
	/** The least time between two fetches an unknown `kid` or a failure can cause, in ms. Default 30 seconds. */
	cooldownMs?: number
	/** How far past `maxAgeMs` keys keep verifying while the issuer cannot be reached, in ms. Default 1 hour. */
	staleMs?: number
	/** How long one fetch may take, in ms. Default 5 seconds. */
	timeoutMs?: number
}

type KeySet = { readonly fetchedAt: number; readonly keys: readonly Jwk[] }

/** A fetch under way, and when it began. */
type Flight = { readonly keys: Promise<KeySet>; readonly startedAt: number }

/** The one key that can verify `header`: by `kid` when the token names one, else the only candidate. */
function pick(keys: readonly Jwk[], header: JwkLookup): Jwk | null {
	const candidates = keys.filter(
		(key) =>
			key.kty === ALGORITHMS[header.alg].kty &&
			(key.alg === undefined || key.alg === header.alg) &&
			(header.kid === undefined || key.kid === header.kid),
	)
	return candidates.length === 1 ? (candidates[0] as Jwk) : null
}

/** The key set at `url`. Throws on anything but a JWKS. */
async function fetchKeys(url: string, timeoutMs: number): Promise<KeySet> {
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
	if (!response.ok) {
		await response.body?.cancel()
		throw new Error(`JWKS fetch failed: ${response.status} ${url}`)
	}
	const body = (await response.json()) as { keys?: unknown }
	if (!Array.isArray(body.keys)) throw new Error(`JWKS has no keys: ${url}`)
	return { fetchedAt: Date.now(), keys: body.keys as Jwk[] }
}

/** Waits for `pending`, a fetch another request may have started, for at most `timeoutMs`. */
function bounded(pending: Promise<KeySet>, timeoutMs: number): Promise<KeySet> {
	/* on Workers a fetch dies with the request that began it, so a waiter must not outwait it */
	const timeout = AbortSignal.timeout(timeoutMs)
	const expired = new Promise<never>((_resolve, reject) => {
		timeout.addEventListener("abort", () => reject(new Error("JWKS fetch timed out")), { once: true })
	})
	return Promise.race([pending, expired])
}

/**
 * Keys from an issuer's JWKS endpoint, as `verifyJwt`'s `jwks`. Concurrent lookups share one fetch. An unknown `kid`
 * fetches again, at most once per `cooldownMs`, so a key the issuer just published verifies and a stream of forged
 * ids cannot hammer the endpoint. When the issuer cannot be reached, keys already held keep verifying for `staleMs`;
 * after that, or with no keys held, the lookup throws.
 *
 * @param url The issuer's JWKS endpoint.
 * @param options How long keys are kept and how often they are fetched.
 * @returns The key source to pass to every verify for this issuer.
 *
 * @example
 * const apple = remoteJwks("https://appleid.apple.com/auth/keys")
 * await verifyJwt(token, { algorithms: ["RS256"], audience: clientId, issuer: "https://appleid.apple.com", jwks: apple })
 */
export function remoteJwks(url: string, options: RemoteJwksOptions = {}): JwkSource {
	const { cooldownMs = 30_000, maxAgeMs = 600_000, staleMs = 3_600_000, timeoutMs = 5000 } = options
	let held: KeySet | undefined
	let pending: Flight | undefined
	let attemptedAt = Number.NEGATIVE_INFINITY
	let failure: unknown

	/** A fetch whose outcome replaces the keys held, a failure being kept for the cooldown. */
	const fetchAndHold = async (): Promise<KeySet> => {
		try {
			held = await fetchKeys(url, timeoutMs)
			failure = undefined
			return held
		} catch (error) {
			failure = error
			throw error
		}
	}

	/** One fetch at a time. On Workers a fetch dies with the request that began it and never settles, so one older than its own timeout is replaced. */
	const load = (): Promise<KeySet> => {
		attemptedAt = Date.now()
		if (pending === undefined || attemptedAt - pending.startedAt >= timeoutMs) {
			const flight: Flight = {
				keys: fetchAndHold().finally(() => {
					if (pending === flight) pending = undefined
				}),
				startedAt: attemptedAt,
			}
			pending = flight
		}
		return bounded(pending.keys, timeoutMs)
	}

	/** The keys to use now: the held ones while fresh, else a fetch, else the held ones while they may stand in. */
	const current = async (): Promise<KeySet> => {
		const now = Date.now()
		if (held !== undefined && now - held.fetchedAt < maxAgeMs) return held
		try {
			if (pending === undefined && now - attemptedAt < cooldownMs && failure !== undefined) throw failure
			return await load()
		} catch (error) {
			if (held !== undefined && now - held.fetchedAt < maxAgeMs + staleMs) return held
			throw error
		}
	}

	return async (header) => {
		const set = await current()
		const key = pick(set.keys, header)
		if (key !== null || Date.now() - attemptedAt < cooldownMs) return key
		/* keys are held, so a failed look for a newer one leaves this kid unknown: a forged id is no outage */
		return load().then(
			(fresh) => pick(fresh.keys, header),
			() => null,
		)
	}
}
