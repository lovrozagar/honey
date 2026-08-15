import { namedMiddleware } from "./middleware.ts"
import { HoneyError } from "./error.ts"
import type { MiddlewareFn } from "./middleware.ts"
import { EK, SK } from "./types.ts"

type IpRestrictOptions = {
	allowList?: string[]
	denyList?: string[]
	getIp?: (req: Request) => string | null
	trustProxy?: boolean
}

function stripBrackets(ip: string): string {
	if (ip.startsWith("[") && ip.endsWith("]")) {
		return ip.slice(1, -1)
	}
	return ip
}

function defaultGetIp(req: Request): string | null {
	const cfIp = req.headers.get("cf-connecting-ip")
	if (cfIp) return stripBrackets(cfIp.trim())

	return null
}

function proxyAwareGetIp(req: Request): string | null {
	const cfIp = req.headers.get("cf-connecting-ip")
	if (cfIp) return stripBrackets(cfIp.trim())

	const xff = req.headers.get("x-forwarded-for")
	if (xff) return stripBrackets(xff.split(",")[0].trim())

	const realIp = req.headers.get("x-real-ip")
	if (realIp) return stripBrackets(realIp.trim())

	return null
}

function parseIpv4(ip: string): number | null {
	const parts = ip.split(".")
	if (parts.length !== 4) return null
	let result = 0
	for (const part of parts) {
		const n = Number.parseInt(part, 10)
		if (Number.isNaN(n) || n < 0 || n > 255) return null
		result = (result << 8) | n
	}
	return result >>> 0
}

type Ipv4CidrRule = {
	base: number
	mask: number
	v6: false
}

type Ipv6CidrRule = {
	base: bigint
	mask: bigint
	v6: true
}

type CidrRule = Ipv4CidrRule | Ipv6CidrRule

type ParsedRule = {
	cidr?: CidrRule
	exact: string
}

function expandIpv6(ip: string): bigint | null {
	let addr = ip

	/* handle ::ffff:1.2.3.4 mapped IPv4 */
	const v4Suffix = addr.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
	if (v4Suffix) {
		const v4 = parseIpv4(v4Suffix[1])
		if (v4 === null) return null
		addr = `${addr.slice(0, addr.lastIndexOf(":"))}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
	}

	/* expand :: */
	const halves = addr.split("::")
	if (halves.length > 2) return null

	let groups: string[]
	if (halves.length === 2) {
		const left = halves[0] === "" ? [] : halves[0].split(":")
		const right = halves[1] === "" ? [] : halves[1].split(":")
		const fill = 8 - left.length - right.length
		if (fill < 0) return null
		groups = [...left, ...Array.from<string>({ length: fill }).fill("0"), ...right]
	} else {
		groups = addr.split(":")
	}

	if (groups.length !== 8) return null

	let result = 0n
	for (const g of groups) {
		const n = Number.parseInt(g, 16)
		if (Number.isNaN(n) || n < 0 || n > 0xffff) return null
		result = (result << 16n) | BigInt(n)
	}
	return result
}

function isIpv6(ip: string): boolean {
	return ip.includes(":")
}

function parseRule(rule: string): ParsedRule {
	const slashIdx = rule.indexOf("/")
	if (slashIdx === -1) {
		return { exact: rule }
	}

	const ip = rule.slice(0, slashIdx)
	const bits = Number.parseInt(rule.slice(slashIdx + 1), 10)

	if (isIpv6(ip)) {
		const base = expandIpv6(ip)
		if (base === null || Number.isNaN(bits) || bits < 0 || bits > 128) {
			return { exact: rule }
		}
		const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits)
		return { cidr: { base: base & mask, mask, v6: true }, exact: rule }
	}

	const base = parseIpv4(ip)
	if (base === null || Number.isNaN(bits) || bits < 0 || bits > 32) {
		return { exact: rule }
	}

	const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
	return { cidr: { base: (base & mask) >>> 0, mask, v6: false }, exact: rule }
}

function matchesRule(ip: string, rule: ParsedRule): boolean {
	if (rule.cidr) {
		if (rule.cidr.v6) {
			const parsed = expandIpv6(ip)
			if (parsed === null) return false
			return (parsed & rule.cidr.mask) === rule.cidr.base
		}
		const parsed = parseIpv4(ip)
		if (parsed === null) return false
		return (parsed & rule.cidr.mask) >>> 0 === rule.cidr.base
	}
	return ip === rule.exact
}

function throwForbidden(): never {
	throw new HoneyError({
		errorKey: EK.forbidden,
		status: SK.forbidden,
	})
}

export function ipRestrict(opts: IpRestrictOptions): MiddlewareFn<{ req: Request }, {}> {
	const getIp = opts.getIp ?? (opts.trustProxy === true ? proxyAwareGetIp : defaultGetIp)
	const denyRules = opts.denyList?.map(parseRule) ?? []
	const allowRules = opts.allowList?.map(parseRule) ?? []
	const hasAllowList = allowRules.length > 0

	const mw: MiddlewareFn<{ req: Request }, {}> = (ctx, next) => {
		const ip = getIp(ctx.req)

		/* deny list checked first */
		if (ip !== null) {
			for (const rule of denyRules) {
				if (matchesRule(ip, rule)) throwForbidden()
			}
		}

		/* allow list: if set, IP must match at least one rule */
		if (hasAllowList) {
			if (ip === null) throwForbidden()
			let allowed = false
			for (const rule of allowRules) {
				if (matchesRule(ip, rule)) {
					allowed = true
					break
				}
			}
			if (!allowed) throwForbidden()
		}

		return next()
	}

	return namedMiddleware("ipRestrict", mw)
}
