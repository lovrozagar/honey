/**
 * ctx.ip through app.fetch (H23): the peer each platform reports, in one canonical spelling. No
 * proxy trust exists, so forwarding headers never move it: behind a self-hosted proxy ctx.ip is
 * the proxy's address.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { PEER_ADDRESS } from "../../src/context/peer.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"

/** An app whose /who answers with ctx.ip. */
function ipApp() {
	const app = honey<{}>()
	app.get("/who").handler((ctx) => ctx.res.json("ok", { ip: ctx.ip }))
	return app
}

async function ipOf(req: Request, env: object = {}): Promise<unknown> {
	const res = await ipApp().fetch(req, env)
	return ((await res.json()) as { ip: unknown }).ip
}

/** A request as the Node adapter hands it over: its peer under PEER_ADDRESS. */
function fromNode(peer: string, headers: Record<string, string> = {}): Request {
	const req = new Request("http://app.internal/who", { headers })
	Object.defineProperty(req, PEER_ADDRESS, { value: peer })
	return req
}

/** A Bun server whose socket reports `address`. */
const bunServer = (address: string) => ({ requestIP: () => ({ address }) })

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("the peer each runtime reports", () => {
	// v0: fc369c9b18
	it("on Bun, the server passed as the env, or as env.server", async () => {
		expect(await ipOf(new Request("http://h/who"), bunServer("192.0.2.1"))).toBe("192.0.2.1")
		expect(await ipOf(new Request("http://h/who"), { server: bunServer("192.0.2.1") })).toBe("192.0.2.1")
	})

	it("on Node, the socket address the adapter's request reports", async () => {
		expect(await ipOf(fromNode("198.51.100.7"))).toBe("198.51.100.7")
	})

	it("on Workers, CF-Connecting-IP, which the edge sets and a client cannot", async () => {
		vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" })
		expect(await ipOf(new Request("http://h/who", { headers: { "cf-connecting-ip": "203.0.113.9" } }))).toBe(
			"203.0.113.9",
		)
	})

	// v0: 1698bda343
	it("off Workers, CF-Connecting-IP is client text: with no other source the answer is null", async () => {
		expect(await ipOf(new Request("http://h/who", { headers: { "cf-connecting-ip": "203.0.113.9" } }))).toBeNull()
	})
})

describe("one spelling per client, whichever runtime reported it", () => {
	it.each([
		["Node, IPv4-mapped", () => ipOf(fromNode("::ffff:203.0.113.7"))],
		["Bun, plain IPv4", () => ipOf(new Request("http://h/who"), bunServer("203.0.113.7"))],
		[
			"Workers, plain IPv4",
			() => {
				vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" })
				return ipOf(new Request("http://h/who", { headers: { "cf-connecting-ip": "203.0.113.7" } }))
			},
		],
	])("%s is 203.0.113.7", async (_runtime, read) => {
		expect(await read()).toBe("203.0.113.7")
	})

	it("an IPv6 peer is lowercase RFC 5952 on every runtime", async () => {
		expect(await ipOf(fromNode("2001:0DB8:0000:0000:0000:0000:0000:0001"))).toBe("2001:db8::1")
		expect(await ipOf(new Request("http://h/who"), bunServer("2001:DB8::1"))).toBe("2001:db8::1")
	})
})

describe("behind a self-hosted reverse proxy", () => {
	// v0: e00ddcb282
	it("ctx.ip is the proxy's address: no forwarding header moves it", async () => {
		const headers = {
			"cf-connecting-ip": "9.9.9.9",
			forwarded: "for=8.8.8.8;proto=https",
			"x-forwarded-for": "1.1.1.1, 2.2.2.2",
			"x-real-ip": "3.3.3.3",
		}
		expect(await ipOf(fromNode("10.0.0.1", headers))).toBe("10.0.0.1")
		expect(await ipOf(new Request("http://h/who", { headers }), bunServer("10.0.0.1"))).toBe("10.0.0.1")
	})
})

describe("ctx.ip is read once per request", () => {
	it("however many readers ask, the runtime is asked once", async () => {
		let asks = 0
		const server = {
			requestIP: () => {
				asks++
				return { address: "192.0.2.1" }
			},
		}
		const seen: unknown[] = []
		const app = honey<{}>()
		app
			.use(
				createMiddleware((ctx, next) => {
					seen.push(ctx.ip, ctx.ip)
					return next()
				}),
			)
			.get("/who")
			.handler((ctx) => ctx.res.json("ok", { ip: ctx.ip }))
		const res = await app.fetch(new Request("http://h/who"), server)
		expect([await res.json(), seen, asks]).toEqual([{ ip: "192.0.2.1" }, ["192.0.2.1", "192.0.2.1"], 1])
	})
})

describe("ip is a framework key", () => {
	// v0: 59b96fa98f
	it("context() refuses it, and next() cannot replace it", async () => {
		expect(() => honey<{}>().context({ ip: "x" } as never)).toThrow('context() cannot set reserved key "ip"')
		const app = honey<{}>()
		app
			.use(createMiddleware((_ctx, next) => next({ ip: "6.6.6.6" } as {})))
			.get("/who")
			.handler((ctx) => ctx.res.json("ok", { ip: ctx.ip }))
		expect(await (await app.fetch(fromNode("10.0.0.1"), {})).json()).toEqual({ ip: "10.0.0.1" })
	})
})
