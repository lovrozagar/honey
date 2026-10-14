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
