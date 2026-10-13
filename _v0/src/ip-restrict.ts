import { namedMiddleware } from "./middleware.ts"
import { HoneyError } from "./error.ts"
import { ipInRange, parseIp, parseIpRange, type IpRange } from "./ip.ts"
import type { MiddlewareFn } from "./middleware.ts"
import { EK, SK } from "./types.ts"

type IpRestrictOptions = {
	/** Addresses and CIDR ranges allowed through. When set, everything else is rejected. */
	allowList?: string[]
	/** Addresses and CIDR ranges rejected. Checked before `allowList`. */
	denyList?: string[]
	/**
	 * Returns the client address, replacing `ctx.ip`. Leave it out to use `ctx.ip`, which the
	 * app's `trustProxy()` setting decides — the same address every other feature sees.
	 */
	getIp?: (req: Request) => string | null
}

function parseRules(list: readonly string[] | undefined, name: string): IpRange[] {
	if (list === undefined) return []
	return list.map((rule) => {
		const range = typeof rule === "string" ? parseIpRange(rule) : null
		if (range === null)
			throw new Error(`ipRestrict: ${name} entry ${JSON.stringify(rule)} is not an IP address or CIDR range`)
		return range
	})
}

function throwForbidden(): never {
	throw new HoneyError({
		errorKey: EK.forbidden,
		status: SK.forbidden,
	})
}

/**
 * Allows or rejects requests by client address. Rules and addresses are compared in canonical
 * numeric form, so `::ffff:203.0.113.7`, `203.0.113.7` and `203.0.113.7:51234` are one address.
 *
 * Fails closed: a request whose address is unknown or unparseable is rejected with 403, under
 * a deny list as much as under an allow list.
 */
export function ipRestrict(opts: IpRestrictOptions): MiddlewareFn<{ req: Request }, {}> {
	const legacy = opts as { trustCloudflare?: unknown; trustProxy?: unknown }
	if (legacy.trustProxy !== undefined || legacy.trustCloudflare !== undefined) {
		throw new Error(
			"ipRestrict: `trustProxy` and `trustCloudflare` moved to the app. Call `app.trustProxy(1)` " +
				"(one reverse proxy) or `app.trustProxy([...proxy ranges])`; on Cloudflare Workers `ctx.ip` " +
				"already reads CF-Connecting-IP.",
		)
	}
	if (opts.allowList !== undefined && opts.allowList.length === 0) {
		throw new Error("ipRestrict: `allowList: []` would reject every request. Remove the middleware or list addresses.")
	}
	const denyRules = parseRules(opts.denyList, "denyList")
	const allowRules = parseRules(opts.allowList, "allowList")
	if (denyRules.length === 0 && allowRules.length === 0) {
		throw new Error("ipRestrict: pass a non-empty `allowList` or `denyList`")
	}
	const getIp = opts.getIp

	const mw: MiddlewareFn<{ req: Request }, {}> = (ctx, next) => {
		const raw = getIp ? getIp(ctx.req) : ((ctx as { ip?: string | null }).ip ?? null)
		const addr = raw === null || raw === "" ? null : parseIp(raw)

		/* fail closed: an unknown address can match neither list */
		if (addr === null) throwForbidden()

		for (const rule of denyRules) {
			if (ipInRange(addr, rule)) throwForbidden()
		}

		if (allowRules.length > 0 && !allowRules.some((rule) => ipInRange(addr, rule))) throwForbidden()

		return next()
	}

	return namedMiddleware("ipRestrict", mw)
}
