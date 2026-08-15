import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { ipRestrict } from "../../../src/ip-restrict.ts"

function makeApp(opts: Parameters<typeof ipRestrict>[0]) {
	const app = honey<{}>().use(ipRestrict(opts))
	app.get("/admin").handler((ctx) => ctx.res.json("ok", { access: true }))
	return app
}

function reqWithIp(ip: string, header = "x-forwarded-for") {
	return new Request("http://localhost/admin", {
		headers: { [header]: ip },
	})
}

describe("ip-restrict middleware — internal", () => {
	it("IP in allowList → allowed", async () => {
		const app = makeApp({ allowList: ["10.0.0.1"], trustProxy: true })
		const res = await app.fetch(reqWithIp("10.0.0.1"), {})
		expect(res.status).toBe(200)
	})

	it("IP not in allowList → 403", async () => {
		const app = makeApp({ allowList: ["10.0.0.1"], trustProxy: true })
		const res = await app.fetch(reqWithIp("192.168.1.1"), {})
		expect(res.status).toBe(403)
	})

	it("IP in denyList → 403 even if also in allowList", async () => {
		const app = makeApp({ allowList: ["10.0.0.1"], denyList: ["10.0.0.1"], trustProxy: true })
		const res = await app.fetch(reqWithIp("10.0.0.1"), {})
		expect(res.status).toBe(403)
	})

	it("CIDR: 10.0.0.50 matches 10.0.0.0/24", async () => {
		const app = makeApp({ allowList: ["10.0.0.0/24"], trustProxy: true })
		const res = await app.fetch(reqWithIp("10.0.0.50"), {})
		expect(res.status).toBe(200)
	})

	it("CIDR: 10.0.1.50 does NOT match 10.0.0.0/24", async () => {
		const app = makeApp({ allowList: ["10.0.0.0/24"], trustProxy: true })
		const res = await app.fetch(reqWithIp("10.0.1.50"), {})
		expect(res.status).toBe(403)
	})

	it("custom getIp function used", async () => {
		const app = makeApp({
			allowList: ["1.2.3.4"],
			getIp: (req) => req.headers.get("cf-connecting-ip"),
		})
		const res = await app.fetch(reqWithIp("1.2.3.4", "cf-connecting-ip"), {})
		expect(res.status).toBe(200)
	})

	it("no IP extracted with allowList → 403", async () => {
		const app = makeApp({ allowList: ["10.0.0.1"] })
		const res = await app.fetch(new Request("http://localhost/admin"), {})
		expect(res.status).toBe(403)
	})

	it("no IP extracted with no allowList → allowed", async () => {
		const app = makeApp({ denyList: ["10.0.0.1"] })
		const res = await app.fetch(new Request("http://localhost/admin"), {})
		expect(res.status).toBe(200)
	})

	it("exact IPv6 match works", async () => {
		const app = makeApp({ allowList: ["::1"], trustProxy: true })
		const res = await app.fetch(reqWithIp("::1"), {})
		expect(res.status).toBe(200)
	})

	it("/32 CIDR = exact match", async () => {
		const app = makeApp({ allowList: ["10.0.0.5/32"], trustProxy: true })
		const r1 = await app.fetch(reqWithIp("10.0.0.5"), {})
		expect(r1.status).toBe(200)
		const r2 = await app.fetch(reqWithIp("10.0.0.6"), {})
		expect(r2.status).toBe(403)
	})

	it("/16 CIDR range", async () => {
		const app = makeApp({ allowList: ["172.16.0.0/16"], trustProxy: true })
		const r1 = await app.fetch(reqWithIp("172.16.255.1"), {})
		expect(r1.status).toBe(200)
		const r2 = await app.fetch(reqWithIp("172.17.0.1"), {})
		expect(r2.status).toBe(403)
	})

	it("X-Forwarded-For uses first entry", async () => {
		const app = makeApp({ allowList: ["10.0.0.1"], trustProxy: true })
		const res = await app.fetch(
			new Request("http://localhost/admin", {
				headers: { "x-forwarded-for": "10.0.0.1, 192.168.1.1" },
			}),
			{},
		)
		expect(res.status).toBe(200)
	})
})

describe("ip-restrict middleware — consumer", () => {
	it("admin route blocked from public IP", async () => {
		const app = makeApp({ allowList: ["10.0.0.0/8"], trustProxy: true })
		const res = await app.fetch(reqWithIp("203.0.113.50"), {})
		expect(res.status).toBe(403)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("forbidden")
	})

	it("webhook endpoint accepts known IP range", async () => {
		const app = makeApp({ allowList: ["54.187.174.0/24", "54.187.205.0/24"], trustProxy: true })
		const res = await app.fetch(reqWithIp("54.187.174.100"), {})
		expect(res.status).toBe(200)
	})
})
