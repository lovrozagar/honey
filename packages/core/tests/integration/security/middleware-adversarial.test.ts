/**
 * The adversarial suite's edge-middleware cases (F1): security headers on every exit, CORS
 * credential reflection, csrf bypasses, rate-limit key spray and spoofing, the BREACH oracle, proxy
 * SSRF and Host spoofing, curlLogger leaks. Each is a failing input first and the guard that answers
 * it second; the mutation harness reruns this directory with each guard disabled.
 */
import { resolve as resolvePath } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { guardNamed } from "../../structure/mutation-harness.ts"

const REPO = resolvePath(import.meta.dirname, "../../../../..")

const mutant = guardNamed(process.env.HONEY_MUTANT)
if (mutant !== undefined) {
	vi.doMock(resolvePath(REPO, mutant.module), async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>()
		return { ...original, ...mutant.disable(original) }
	})
}

/* imported after the mock, so a mutant reaches every module that uses it */
const { honey } = (await import(
	resolvePath(REPO, "packages/core/src/routing/app.ts")
)) as typeof import("../../../src/routing/app.ts")
const { cors } = (await import(
	resolvePath(REPO, "packages/core/src/middleware/cors.ts")
)) as typeof import("../../../src/middleware/cors.ts")
const { csrf } = (await import(
	resolvePath(REPO, "packages/core/src/middleware/csrf.ts")
)) as typeof import("../../../src/middleware/csrf.ts")
const { requestId } = (await import(
	resolvePath(REPO, "packages/core/src/middleware/request-id.ts")
)) as typeof import("../../../src/middleware/request-id.ts")

const { timeout } = (await import(
	resolvePath(REPO, "packages/core/src/middleware/timeout.ts")
)) as typeof import("../../../src/middleware/timeout.ts")
const { serverTiming } = (await import(
	resolvePath(REPO, "packages/core/src/middleware/server-timing.ts")
)) as typeof import("../../../src/middleware/server-timing.ts")
const { memoryStore, rateLimit } = (await import(
	resolvePath(REPO, "packages/core/src/middleware/rate-limit.ts")
)) as typeof import("../../../src/middleware/rate-limit.ts")
const { PEER_ADDRESS } = (await import(
	resolvePath(REPO, "packages/core/src/context/peer.ts")
)) as typeof import("../../../src/context/peer.ts")
const { ipRestrict } = (await import(
	resolvePath(REPO, "packages/core/src/middleware/ip-restrict.ts")
)) as typeof import("../../../src/middleware/ip-restrict.ts")
const { compress } = (await import(
	resolvePath(REPO, "packages/core/src/middleware/compress.ts")
)) as typeof import("../../../src/middleware/compress.ts")
const { secureHeaders } = (await import(
	resolvePath(REPO, "packages/core/src/middleware/secure-headers.ts")
)) as typeof import("../../../src/middleware/secure-headers.ts")

describe("v1 adversarial: no request strips the security headers", () => {
	it("an error, an unknown path and a refused method still carry the CSP and nosniff", async () => {
		const app = honey<{}>()
		const guarded = app.use(secureHeaders({ contentSecurityPolicy: "default-src 'self'" }))
		guarded.get("/boom").handler(() => {
			throw new Error("boom")
		})
		guarded.post("/only-post").handler((ctx) => ctx.res.text("ok", "x"))
		const answers = await Promise.all(
			["/boom", "/nowhere", "/only-post"].map((path) => app.fetch(new Request(`http://app.test${path}`), {})),
		)
		const security = answers.map((res) => [
			res.status,
			res.headers.get("content-security-policy"),
			res.headers.get("x-content-type-options"),
		])
		expect(security).toEqual([
			[500, "default-src 'self'", "nosniff"],
			[404, "default-src 'self'", "nosniff"],
			[405, "default-src 'self'", "nosniff"],
		])
	})
})

describe("v1 adversarial: credentialed CORS never trusts the caller's Origin", () => {
	it("a foreign Origin and the opaque null earn no allow-origin and no credentials", async () => {
		const app = honey<{}>()
		app
			.use(cors({ credentials: true, origin: ["https://app.example"] }))
			.get("/me")
			.handler((ctx) => ctx.res.json("ok", { me: "secret" }))
		const answers = await Promise.all(
			["https://evil.example", "null"].map((origin) =>
				app.fetch(new Request("http://app.test/me", { headers: { cookie: "sid=1", origin } }), {}),
			),
		)
		expect(
			answers.map((res) => [
				res.headers.get("access-control-allow-origin"),
				res.headers.get("access-control-allow-credentials"),
			]),
		).toEqual([
			[null, null],
			[null, null],
		])
	})
})

describe("v1 adversarial: a cross-site write never passes csrf", () => {
	it("a cross-site POST with no content type, as a form or a fetch could send it, is 403", async () => {
		const app = honey<{}>()
		app
			.use(csrf())
			.post("/transfer")
			.handler((ctx) => ctx.res.text("ok", "sent"))
		const res = await app.fetch(
			new Request("http://app.test/transfer", {
				headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(403)
	})
})

describe("v1 adversarial: a client never picks its request id", () => {
	it("an inbound x-request-id is not adopted unless the hop is trusted", async () => {
		const app = honey<{}>()
		app
			.use(requestId())
			.get("/t")
			.handler((ctx) => ctx.res.text("ok", ctx.requestId))
		const res = await app.fetch(
			new Request("http://app.test/t", { headers: { "x-request-id": "attacker-chosen" } }),
			{},
		)
		expect([await res.text(), res.headers.get("x-request-id")].includes("attacker-chosen")).toBe(false)
	})
})

describe("v1 adversarial: a handler that never answers cannot hold the request", () => {
	it("timeout answers 504 within its duration, not when (or if) the handler does", async () => {
		const app = honey<{}>()
		app
			.use(timeout({ duration: 20 }))
			.get("/stall")
			.handler(() => new Promise<never>(() => {}))
		const answered = Promise.resolve(app.fetch(new Request("http://app.test/stall"), {})).then((res) => res.status)
		const deadline = new Promise((resolve) => setTimeout(() => resolve("still waiting"), 500))
		expect(await Promise.race([answered, deadline])).toBe(504)
	})
})

describe("v1 adversarial: a timing name cannot forge a metric", () => {
	it("a name or description carrying `,` `;` `=` and quotes stays one metric, not several", async () => {
		const app = honey<{}>()
		app
			.use(serverTiming())
			.get("/t")
			.handler((ctx) => {
				ctx.timing.start("db, cache-hit;dur=0", 'q", auth;dur=9999')
				return ctx.res.text("ok", "x")
			})
		const res = await app.fetch(new Request("http://app.test/t"), {})
		const header = res.headers.get("server-timing") ?? ""
		/* split outside quoted strings: the metrics a browser's devtools would show */
		const metrics = header.match(/(?:[^,"]|"(?:[^"\\]|\\.)*")+/g)?.map((metric) => metric.trim().split(";")[0])
		expect(metrics).toEqual(["db__cache-hit_dur_0", "total"])
	})
})

/** A request from `peer`, as the Node adapter reports it. */
function fromPeer(peer: string, headers?: Record<string, string>): Request {
	const req = new Request("http://app.test/t", { headers })
	Object.defineProperty(req, PEER_ADDRESS, { value: peer })
	return req
}

describe("v1 adversarial: a client cannot rotate its rate-limit key", () => {
	it("past the limit, a fresh X-Forwarded-For on every request is still 429", async () => {
		const app = honey<{}>()
		app
			.use(rateLimit({ limit: 2, windowMs: 60_000 }))
			.get("/t")
			.handler((ctx) => ctx.res.text("ok", "x"))
		const statuses: number[] = []
		for (let i = 0; i < 5; i += 1) {
			const res = await app.fetch(fromPeer("203.0.113.7", { "x-forwarded-for": `198.51.100.${i}` }), {})
			statuses.push(res.status)
		}
		expect(statuses).toEqual([200, 200, 429, 429, 429])
	})
})

describe("v1 adversarial: a key spray cannot grow the rate-limit store", () => {
	it("20 000 distinct peers (an IPv6 /64 walk) leave the store at its cap", async () => {
		const store = memoryStore({ maxKeys: 1000, windowMs: 60_000 })
		const app = honey<{}>()
		app
			.use(rateLimit({ limit: 1, store }))
			.get("/t")
			.handler((ctx) => ctx.res.text("ok", "x"))
		for (let i = 0; i < 20_000; i += 1) await app.fetch(fromPeer(`2001:db8::${i.toString(16)}`), {})
		expect(store.size).toBe(1000)
	})
})

describe("v1 adversarial: ipRestrict sees only the platform peer", () => {
	it("a forwarding header naming an allowed address, CF-Connecting-IP off Workers included, is 403", async () => {
		const app = honey<{}>()
		app
			.use(ipRestrict({ allowList: ["10.0.0.0/8"] }))
			.get("/t")
			.handler((ctx) => ctx.res.text("ok", "admin"))
		const statuses = []
		for (const header of ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "true-client-ip"]) {
			statuses.push((await app.fetch(fromPeer("203.0.113.9", { [header]: "10.0.0.1" }), {})).status)
		}
		expect(statuses).toEqual([403, 403, 403, 403])
	})

	it("another spelling of a denied address (IPv4-mapped, zero-expanded, upper case) is still denied", async () => {
		const app = honey<{}>()
		app
			.use(ipRestrict({ denyList: ["::ffff:203.0.113.9", "2001:0DB8:0:0:0:0:0:1"] }))
			.get("/t")
			.handler((ctx) => ctx.res.text("ok", "admin"))
		const statuses = []
		for (const peer of ["203.0.113.9", "2001:db8::1", "[2001:db8::1]:443"]) {
			statuses.push((await app.fetch(fromPeer(peer), {})).status)
		}
		expect(statuses).toEqual([403, 403, 403])
	})
})

describe("v1 adversarial: compressed length is no oracle for a secret (BREACH)", () => {
	it("two same-length guesses reflected beside a session's token answer the same number of bytes", async () => {
		const token = "f3a9c2e17b4d8a6052c9e1f7a3b8d4c6"
		const app = honey<{}>()
		app
			.use(compress())
			.get("/search")
			.handler((ctx) => {
				const q = new URL(ctx.req.url).searchParams.get("q") ?? ""
				const page = `<form><input name="csrf" value="${token}"></form>${"<p>results</p>".repeat(100)}`
				return ctx.res.html("ok", `${page}<p>you searched: value="${q}"</p>`)
			})
		const lengthFor = async (guess: string) => {
			const res = await app.fetch(
				new Request(`http://app.test/search?q=${guess}`, {
					headers: { "accept-encoding": "gzip, br", cookie: "sid=victim" },
				}),
				{},
			)
			return (await res.arrayBuffer()).byteLength
		}
		const wrong = "0123456789abcdef0123456789abcdef"
		expect(await lengthFor(token)).toBe(await lengthFor(wrong))
	})
})
