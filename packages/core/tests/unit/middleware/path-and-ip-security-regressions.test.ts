import { describe, expect, it, vi } from "vitest"
import { honey } from "../../../src/index.ts"
import { ipRestrict } from "../../../src/ip-restrict.ts"
import { setPeerAddress } from "../../../src/peer.ts"
import { staticFiles } from "../../../src/static.ts"
import "../../../src/trust.ts"

/**
 * Regressions for the bug classes published against comparable frameworks' static-file and
 * IP-restriction middleware (hono `serveStatic` / `ipRestriction`, elysia `static`): path
 * traversal through encodings and separators, Windows path semantics, prefix confusion, and
 * client-address spoofing or non-canonical comparison.
 */

/** A request whose URL is exactly `path`, as a runtime that does not normalize would hand it over. */
function raw(path: string, init?: { headers?: Record<string, string>; peer?: string }): Request {
	const req = new Request("http://localhost/", { headers: init?.headers })
	Object.defineProperty(req, "url", { value: `http://localhost${path}` })
	if (init?.peer !== undefined) setPeerAddress(req, init.peer)
	return req
}

function staticApp() {
	const resolve = vi.fn((_ctx: unknown, filePath: string) => new Response(`file:${filePath}`))
	const app = honey<{}>().use(staticFiles({ prefix: "/assets", resolve }))
	app.get("/*rest").handler((ctx) => ctx.res.text("ok", "fallback"))
	return { app, resolve }
}

describe("staticFiles: traversal", () => {
	const attempts = [
		"/assets/../secret.txt",
		"/assets/..%2fsecret.txt",
		"/assets/..%2Fsecret.txt",
		"/assets/%2e%2e/secret.txt",
		"/assets/%2E%2E%2Fsecret.txt",
		"/assets/..%5csecret.txt",
		"/assets/..\\secret.txt",
		"/assets/%252e%252e%252fsecret.txt",
		"/assets/a/../../secret.txt",
		"/assets/....//secret.txt",
	]
	for (const path of attempts) {
		it(`${path} never hands resolve a path that leaves the root`, async () => {
			const { app, resolve } = staticApp()
			await app.fetch(raw(path), {})
			for (const [, filePath] of resolve.mock.calls) {
				expect(filePath.startsWith("/")).toBe(true)
				expect(filePath.split("/")).not.toContain("..")
				expect(filePath).not.toMatch(/\\/)
			}
		})
	}

	it("double encoding is decoded once: %252e stays a literal %2e in the file name", async () => {
		const { app, resolve } = staticApp()
		await app.fetch(raw("/assets/%252e%252e"), {})
		expect(resolve).toHaveBeenCalledWith(expect.anything(), "/%2e%2e")
	})
})

describe("staticFiles: Windows path semantics", () => {
	for (const path of [
		"/assets/C:%5Cwindows%5Cwin.ini",
		"/assets/C:/windows/win.ini",
		"/assets/secret.txt::$DATA",
		"/assets/a%00.txt",
	]) {
		it(`${path} falls through`, async () => {
			const { app, resolve } = staticApp()
			const res = await app.fetch(raw(path), {})
			expect(resolve).not.toHaveBeenCalled()
			expect([400, 200]).toContain(res.status)
			if (res.status === 200) expect(await res.text()).toBe("fallback")
		})
	}
})

describe("staticFiles: prefix confusion", () => {
	it("a sibling directory sharing the prefix's spelling is not served", async () => {
		const { app, resolve } = staticApp()
		const res = await app.fetch(raw("/assets-private/secret.txt"), {})
		expect(resolve).not.toHaveBeenCalled()
		expect(await res.text()).toBe("fallback")
	})

	it("doubled slashes cannot slip past the prefix check", async () => {
		const { app, resolve } = staticApp()
		await app.fetch(raw("//assets//app.js"), {})
		expect(resolve).toHaveBeenCalledWith(expect.anything(), "/app.js")
	})
})

describe("ipRestrict: spoofing and canonicalization", () => {
	function guarded(opts: Parameters<typeof ipRestrict>[0], trust: false | number | string[] = false) {
		const app = honey<{}>().trustProxy(trust).use(ipRestrict(opts))
		app.get("/admin").handler((ctx) => ctx.res.text("ok", "admin"))
		return app
	}

	it("client-sent forwarding headers do not satisfy an allow list without a trusted proxy", async () => {
		const app = guarded({ allowList: ["127.0.0.1"] })
		for (const header of ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "true-client-ip", "forwarded"]) {
			const value = header === "forwarded" ? "for=127.0.0.1" : "127.0.0.1"
			const res = await app.fetch(raw("/admin", { headers: { [header]: value }, peer: "203.0.113.9" }), {})
			expect(res.status, header).toBe(403)
		}
	})

	it("a deny list cannot be skipped by omitting headers or sending garbage", async () => {
		const app = guarded({ denyList: ["203.0.113.0/24"] }, 1)
		expect((await app.fetch(raw("/admin"), {})).status).toBe(403)
		expect(
			(await app.fetch(raw("/admin", { headers: { "x-forwarded-for": "garbage" }, peer: "10.0.0.1" }), {})).status,
		).toBe(403)
	})

	it("prepending entries to X-Forwarded-For does not move the client position", async () => {
		const app = guarded({ denyList: ["203.0.113.9"] }, 1)
		const res = await app.fetch(
			raw("/admin", { headers: { "x-forwarded-for": "127.0.0.1, 203.0.113.9" }, peer: "10.0.0.1" }),
			{},
		)
		expect(res.status).toBe(403)
	})

	for (const spelling of ["::ffff:203.0.113.9", "::FFFF:cb00:7109", "203.0.113.9:4444", "[::ffff:203.0.113.9]:4444"]) {
		it(`deny rule matches the same address written as ${spelling}`, async () => {
			const app = guarded({ denyList: ["203.0.113.9"] }, 1)
			const res = await app.fetch(raw("/admin", { headers: { "x-forwarded-for": spelling }, peer: "10.0.0.1" }), {})
			expect(res.status).toBe(403)
		})
	}

	it("octal- and hex-looking IPv4 spellings are not addresses", async () => {
		const app = guarded({ allowList: ["10.0.0.1"] }, 1)
		for (const spelling of ["010.0.0.1", "0x0a.0.0.1", "10.0.1", "167772161"]) {
			const res = await app.fetch(raw("/admin", { headers: { "x-forwarded-for": spelling }, peer: "10.9.9.9" }), {})
			expect(res.status, spelling).toBe(403)
		}
	})
})
