import { afterEach, describe, expect, it } from "vitest"
import { clientInfo, honey } from "../../../src/index.ts"
import { serve, type HoneyServer } from "../../../src/node.ts"
import { setPeerAddress } from "../../../src/peer.ts"
import { testClient } from "../../../src/testing.ts"
import { compileTrust, type TrustProxy } from "../../../src/trust.ts"

function infoApp(trust: TrustProxy = false) {
	const app = honey<{}>().trustProxy(trust)
	app.get("/who").handler((ctx) => ctx.res.json("ok", { ...clientInfo(ctx), ctxIp: ctx.ip }))
	return app
}

async function who(
	app: ReturnType<typeof infoApp>,
	peer: string | null,
	headers: Record<string, string> = {},
	url = "http://app.internal:3000/who",
) {
	const req = new Request(url, { headers })
	if (peer !== null) setPeerAddress(req, peer)
	return (await (await app.fetch(req, {})).json()) as {
		ctxIp: string | null
		host: string | null
		ip: string | null
		protocol: string
	}
}

describe("ctx.ip and clientInfo()", () => {
	it("off by default: the peer, canonicalized; forwarding headers ignored", async () => {
		const headers = { "x-forwarded-for": "1.1.1.1", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" }
		const info = await who(infoApp(), "::ffff:203.0.113.7", headers)
		expect(info).toEqual({ ctxIp: "203.0.113.7", host: "app.internal:3000", ip: "203.0.113.7", protocol: "http" })
	})

	it("no peer and no trust: null", async () => {
		expect((await who(infoApp(), null, { "x-forwarded-for": "1.1.1.1" })).ip).toBeNull()
	})

	it("a hop count reads the entry the outermost trusted proxy wrote", async () => {
		const xff = { "x-forwarded-for": "6.6.6.6, 198.51.100.7, 10.0.0.9" }
		expect((await who(infoApp(1), "10.0.0.1", xff)).ip).toBe("10.0.0.9")
		expect((await who(infoApp(2), "10.0.0.1", xff)).ip).toBe("198.51.100.7")
		/* fewer entries than hops: the leftmost, all of which trusted proxies wrote */
		expect((await who(infoApp(5), "10.0.0.1", { "x-forwarded-for": "198.51.100.7" })).ip).toBe("198.51.100.7")
		/* no header at all: the peer */
		expect((await who(infoApp(1), "203.0.113.1")).ip).toBe("203.0.113.1")
	})

	it("ranges: trusted hops are skipped, the first untrusted address is the client", async () => {
		const app = infoApp(["10.0.0.0/8", "fd00::/8"])
		const xff = { "x-forwarded-for": "6.6.6.6, 198.51.100.7, fd00::5, 10.1.1.1" }
		expect((await who(app, "10.0.0.1", xff)).ip).toBe("198.51.100.7")
		/* a peer outside the ranges is the client; nothing it sends is believed */
		expect((await who(app, "203.0.113.1", xff)).ip).toBe("203.0.113.1")
		/* every hop trusted: the leftmost */
		expect((await who(app, "10.0.0.1", { "x-forwarded-for": "10.9.9.9, 10.1.1.1" })).ip).toBe("10.9.9.9")
	})

	it("garbage at the position the trust setting reads is null, not a guess", async () => {
		expect((await who(infoApp(1), "10.0.0.1", { "x-forwarded-for": "1.1.1.1, not-an-ip" })).ip).toBeNull()
		expect(
			(await who(infoApp(["10.0.0.0/8"]), "10.0.0.1", { "x-forwarded-for": "1.1.1.1, bogus, 10.1.1.1" })).ip,
		).toBeNull()
	})

	it("scheme and host come from forwarding headers only through a trusted hop", async () => {
		const headers = { "x-forwarded-host": "api.example.com", "x-forwarded-proto": "https" }
		expect(await who(infoApp(1), "10.0.0.1", headers)).toMatchObject({ host: "api.example.com", protocol: "https" })
		expect(await who(infoApp(["10.0.0.0/8"]), "203.0.113.1", headers)).toMatchObject({
			host: "app.internal:3000",
			protocol: "http",
		})
		/* an invalid forwarded host or proto falls back to the transport */
		expect(
			await who(infoApp(1), "10.0.0.1", { "x-forwarded-host": "a/b", "x-forwarded-proto": "gopher" }),
		).toMatchObject({
			host: "app.internal:3000",
			protocol: "http",
		})
		expect((await who(infoApp(), "10.0.0.1", {}, "https://secure.example/who")).protocol).toBe("https")
	})

	it("reads the Bun server and the Deno serve info when they are the env", async () => {
		const app = infoApp()
		const bunServer = { requestIP: () => ({ address: "::ffff:192.0.2.1" }) }
		const viaServe = (await (await app.fetch(new Request("http://h/who"), { server: bunServer } as never)).json()) as {
			ip: string
		}
		expect(viaServe.ip).toBe("192.0.2.1")
		const viaBunFetch = (await (await app.fetch(new Request("http://h/who"), bunServer as never)).json()) as {
			ip: string
		}
		expect(viaBunFetch.ip).toBe("192.0.2.1")
		const deno = { remoteAddr: { hostname: "2001:DB8::1", port: 1, transport: "tcp" } }
		const viaDeno = (await (await app.fetch(new Request("http://h/who"), deno as never)).json()) as { ip: string }
		expect(viaDeno.ip).toBe("2001:db8::1")
	})

	it("testClient can set the peer", async () => {
		const client = testClient(infoApp(), { env: {}, ip: "198.51.100.1" })
		expect(((await (await client.get("/who")).json()) as { ip: string }).ip).toBe("198.51.100.1")
		expect(((await (await client.get("/who", { ip: "::1" })).json()) as { ip: string }).ip).toBe("::1")
	})

	it("ip is a reserved context key", () => {
		expect(() => honey<{}>().context({ ip: "x" } as never)).toThrow(/reserved key "ip"/)
	})
})

describe("trustProxy() validation", () => {
	it("rejects invalid settings at configuration time", () => {
		expect(() => compileTrust(-1)).toThrow(/hop count/)
		expect(() => compileTrust(1.5)).toThrow(/hop count/)
		expect(() => compileTrust([])).toThrow(/non-empty/)
		expect(() => compileTrust(["10.0.0.0/33"])).toThrow(/not an IP address or CIDR range/)
		expect(() => honey<{}>().trustProxy(["nope"])).toThrow(/not an IP address/)
		expect(compileTrust(false)).toEqual({ kind: "off" })
		expect(compileTrust(0)).toEqual({ kind: "off" })
	})
})

describe("ctx.ip over a real Node socket", () => {
	let server: HoneyServer | undefined
	afterEach(async () => {
		await server?.shutdown(100)
		server = undefined
	})

	it("is the socket peer, IPv4-mapped addresses unwrapped", async () => {
		server = serve(infoApp(), { env: {}, port: 0 })
		await new Promise<void>((resolve) => server?.once("listening", () => resolve()))
		const { port } = server.address() as { port: number }
		const res = await fetch(`http://127.0.0.1:${port}/who`, { headers: { "x-forwarded-for": "6.6.6.6" } })
		expect(((await res.json()) as { ip: string }).ip).toBe("127.0.0.1")
	})
})
