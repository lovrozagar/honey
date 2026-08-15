import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { ipRestrict } from "../../../src/ip-restrict.ts"

function makeApp(opts: Parameters<typeof ipRestrict>[0]) {
	const app = honey<{}>().use(ipRestrict(opts))
	app.get("/admin").handler((ctx) => ctx.res.json("ok", { access: true }))
	return app
}

function reqWithIp(ip: string, header = "cf-connecting-ip") {
	return new Request("http://localhost/admin", {
		headers: { [header]: ip },
	})
}

describe("ip-restrict — uncovered branches", () => {
	it("stripBrackets: IPv6 with brackets via cf-connecting-ip", async () => {
		const app = makeApp({ allowList: ["::1"] })
		const res = await app.fetch(reqWithIp("[::1]"), {})
		expect(res.status).toBe(200)
	})

	it("proxyAwareGetIp: cf-connecting-ip preferred", async () => {
		const app = makeApp({ allowList: ["1.2.3.4"], trustProxy: true })
		const res = await app.fetch(reqWithIp("1.2.3.4", "cf-connecting-ip"), {})
		expect(res.status).toBe(200)
	})

	it("proxyAwareGetIp: x-forwarded-for fallback", async () => {
		const app = makeApp({ allowList: ["10.0.0.1"], trustProxy: true })
		const res = await app.fetch(reqWithIp("10.0.0.1", "x-forwarded-for"), {})
		expect(res.status).toBe(200)
	})

	it("proxyAwareGetIp: x-real-ip fallback", async () => {
		const app = makeApp({ allowList: ["10.0.0.1"], trustProxy: true })
		const res = await app.fetch(reqWithIp("10.0.0.1", "x-real-ip"), {})
		expect(res.status).toBe(200)
	})

	it("proxyAwareGetIp: no headers → 403", async () => {
		const app = makeApp({ allowList: ["10.0.0.1"], trustProxy: true })
		const res = await app.fetch(new Request("http://localhost/admin"), {})
		expect(res.status).toBe(403)
	})

	it("IPv6 CIDR: fe80::/10 matches fe80::1", async () => {
		const app = makeApp({ allowList: ["fe80::/10"] })
		const res = await app.fetch(reqWithIp("fe80::1"), {})
		expect(res.status).toBe(200)
	})

	it("IPv6 CIDR: fe80::/10 rejects fd00::1", async () => {
		const app = makeApp({ allowList: ["fe80::/10"] })
		const res = await app.fetch(reqWithIp("fd00::1"), {})
		expect(res.status).toBe(403)
	})

	it("IPv4-mapped IPv6: ::ffff:10.0.0.1 matching", async () => {
		const app = makeApp({ allowList: ["::ffff:10.0.0.0/120"] })
		const res = await app.fetch(reqWithIp("::ffff:10.0.0.1"), {})
		expect(res.status).toBe(200)
	})

	it("invalid IPv6 in CIDR rule falls back to exact match", async () => {
		const app = makeApp({ allowList: ["not-valid-ipv6/64"] })
		const res = await app.fetch(reqWithIp("not-valid-ipv6/64"), {})
		expect(res.status).toBe(200)
	})

	it("x-forwarded-for with brackets stripped", async () => {
		const app = makeApp({ allowList: ["::1"], trustProxy: true })
		const res = await app.fetch(reqWithIp("[::1]", "x-forwarded-for"), {})
		expect(res.status).toBe(200)
	})
})
