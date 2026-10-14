/**
 * `ipRestrict({ allowList, denyList })`: admit or refuse a request by `ctx.ip`, the platform peer
 * (H23): no forwarding header can stand in for it, so behind a self-hosted proxy restrict at the
 * proxy. Rules are addresses or CIDR ranges, IPv4 or IPv6, compared as numbers, so every spelling
 * of one address (IPv4-mapped, zero-compressed, any case) is one address.
 *
 * The deny list is checked first; with an allow list, everything else is refused. Fails closed: no
 * reported peer is 403 under either list.
 */
import { parseIpv4, parseIpv6 } from "../context/peer.ts"
import { HoneyError } from "../errors/error.ts"
import { type MiddlewareFn, namedMiddleware } from "./middleware.ts"

export type IpRestrictOptions = {
	/** Addresses and CIDR ranges admitted; with it, every other peer is refused. */
	allowList?: readonly string[]
	/** Addresses and CIDR ranges refused, checked before `allowList`. */
	denyList?: readonly string[]
}

type Address = { readonly n: number; readonly v: 4 } | { readonly n: bigint; readonly v: 6 }

type Range =
	| { readonly base: number; readonly mask: number; readonly v: 4 }
	| { readonly base: bigint; readonly mask: bigint; readonly v: 6 }

const PREFIX_LENGTH = /^\d{1,3}$/

function v4Range(n: number, prefix: number): Range {
	/* a shift by 32 is a shift by 0 in JS: /0 is spelled out */
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
	return { base: (n & mask) >>> 0, mask, v: 4 }
}

/** An address or CIDR rule, strict: no brackets, zone or port, a prefix that fits the family. */
function parseRule(rule: string): Range | null {
	const slash = rule.indexOf("/")
	const text = slash === -1 ? rule : rule.slice(0, slash)
	const bits = slash === -1 ? null : rule.slice(slash + 1)
	if (bits !== null && !PREFIX_LENGTH.test(bits)) return null
	if (!text.includes(":")) {
		const n = parseIpv4(text)
		const prefix = bits === null ? 32 : Number(bits)
		return n === null || prefix > 32 ? null : v4Range(n, prefix)
	}
	const n = parseIpv6(text)
	const prefix = bits === null ? 128 : Number(bits)
	if (n === null || prefix > 128) return null
	/* `::ffff:a.b.c.d/96` or longer is the IPv4 range it maps, which is how ctx.ip spells those peers */
	if (n >> 32n === 0xffffn && prefix >= 96) return v4Range(Number(n & 0xffffffffn), prefix - 96)
	const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix)
	return { base: n & mask, mask, v: 6 }
}

function rulesOf(list: readonly string[] | undefined, name: string): Range[] {
	return (list ?? []).map((rule) => {
		const range = parseRule(rule)
		if (range === null) {
			throw new TypeError(`ipRestrict: ${name} entry ${JSON.stringify(rule)} is not an IP address or CIDR range`)
		}
		return range
	})
}

/** ctx.ip is canonical (dotted IPv4 or RFC 5952 IPv6), so it always parses. */
function addressOf(ip: string): Address {
	return ip.includes(":") ? { n: parseIpv6(ip) as bigint, v: 6 } : { n: parseIpv4(ip) as number, v: 4 }
}

function inRange(addr: Address, range: Range): boolean {
	if (addr.v === 4) return range.v === 4 && (addr.n & range.mask) >>> 0 === range.base
	return range.v === 6 && (addr.n & range.mask) === range.base
}

function forbidden(): never {
	throw new HoneyError({ errorKey: "forbidden", status: "forbidden" })
}

export function ipRestrict(options: IpRestrictOptions): MiddlewareFn<{ readonly ip: string | null }, {}, "forbidden"> {
	if (options.allowList?.length === 0) {
		throw new TypeError(
			"ipRestrict: `allowList: []` would refuse every request; remove the middleware or list addresses",
		)
	}
	const deny = rulesOf(options.denyList, "denyList")
	const allow = rulesOf(options.allowList, "allowList")
	if (deny.length === 0 && allow.length === 0)
		throw new TypeError("ipRestrict: pass a non-empty `allowList` or `denyList`")
	const mw: MiddlewareFn<{ readonly ip: string | null }, {}, "forbidden"> = (ctx, next) => {
		if (ctx.ip === null) return forbidden()
		const addr = addressOf(ctx.ip)
		if (deny.some((range) => inRange(addr, range))) return forbidden()
		if (allow.length > 0 && !allow.some((range) => inRange(addr, range))) return forbidden()
		return next()
	}
	mw.errors = ["forbidden"]
	return namedMiddleware("ipRestrict", mw)
}
