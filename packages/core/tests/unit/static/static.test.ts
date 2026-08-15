import { describe, expect, it, vi } from "vitest"
import { staticFiles } from "../../../src/static.ts"

type TestCtx = { req: Request }

function makeCtx(method: string, path: string): TestCtx {
	return { req: new Request(`http://localhost${path}`, { method }) }
}

/** raw ctx that preserves literal URL string (no Request normalization) */
function makeRawCtx(method: string, rawUrl: string): TestCtx {
	return {
		req: { method, url: rawUrl, headers: new Headers() } as unknown as Request,
	}
}

function makeNext() {
	const fn = vi.fn(() => Promise.resolve(new Response("next")))
	return fn as typeof fn & (() => Promise<Response>)
}

describe("staticFiles", () => {
	it("only intercepts paths starting with prefix", async () => {
		const resolve = vi.fn()
		const mw = staticFiles({ prefix: "/assets", resolve })
		const next = makeNext()

		await mw(makeCtx("GET", "/other/file.js"), next)

		expect(resolve).not.toHaveBeenCalled()
		expect(next).toHaveBeenCalled()
	})

	it("passes through for non-GET/HEAD methods", async () => {
		const resolve = vi.fn()
		const mw = staticFiles({ resolve })
		const next = makeNext()

		for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
			await mw(makeCtx(method, "/file.js"), next)
		}

		expect(resolve).not.toHaveBeenCalled()
		expect(next).toHaveBeenCalledTimes(4)
	})

	it("strips prefix before passing path to resolve", async () => {
		const resolve = vi.fn(() => new Response("ok"))
		const mw = staticFiles({ prefix: "/assets", resolve })
		const next = makeNext()

		await mw(makeCtx("GET", "/assets/js/app.js"), next)

		expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ req: expect.any(Request) }), "/js/app.js")
	})

	it("falls through when resolve returns null", async () => {
		const resolve = vi.fn(() => null)
		const mw = staticFiles({ resolve })
		const next = makeNext()

		const res = await mw(makeCtx("GET", "/missing.js"), next)

		expect(next).toHaveBeenCalled()
		expect(await res.text()).toBe("next")
	})

	it("short-circuits when resolve returns a Response", async () => {
		const resolve = vi.fn(() => new Response("file content"))
		const mw = staticFiles({ resolve })
		const next = makeNext()

		const res = await mw(makeCtx("GET", "/index.html"), next)

		expect(next).not.toHaveBeenCalled()
		expect(await res.text()).toBe("file content")
	})

	it("applies static headers record to response", async () => {
		const resolve = vi.fn(() => new Response("ok"))
		const mw = staticFiles({
			resolve,
			headers: {
				"cache-control": "public, max-age=31536000",
				"x-custom": "val",
			},
		})
		const next = makeNext()

		const res = await mw(makeCtx("GET", "/file.css"), next)

		expect(res.headers.get("cache-control")).toBe("public, max-age=31536000")
		expect(res.headers.get("x-custom")).toBe("val")
	})

	it("calls headers function with filePath", async () => {
		const resolve = vi.fn(() => new Response("ok"))
		const headersFn = vi.fn((filePath: string) => ({
			"x-file": filePath,
		}))
		const mw = staticFiles({ resolve, headers: headersFn })
		const next = makeNext()

		await mw(makeCtx("GET", "/img/logo.png"), next)

		expect(headersFn).toHaveBeenCalledWith("/img/logo.png")
	})

	it("applies rewritePath before passing to resolve", async () => {
		const resolve = vi.fn(() => new Response("ok"))
		const mw = staticFiles({
			resolve,
			rewritePath: (p) => `/dist${p}`,
		})
		const next = makeNext()

		await mw(makeCtx("GET", "/app.js"), next)

		expect(resolve).toHaveBeenCalledWith(expect.anything(), "/dist/app.js")
	})

	it("falls through on path traversal attempts", async () => {
		const resolve = vi.fn()
		const mw = staticFiles({ resolve })
		const next = makeNext()

		/* raw URLs bypass Request constructor normalization — simulates runtimes that pass raw paths */
		await mw(makeRawCtx("GET", "http://localhost/../etc/passwd"), next)
		await mw(makeRawCtx("GET", "http://localhost/foo/../../bar"), next)
		await mw(makeRawCtx("GET", "http://localhost/foo/%2e%2e/bar"), next)

		expect(resolve).not.toHaveBeenCalled()
		expect(next).toHaveBeenCalledTimes(3)
	})

	it("matches all paths when no prefix is set", async () => {
		const resolve = vi.fn(() => new Response("ok"))
		const mw = staticFiles({ resolve })
		const next = makeNext()

		await mw(makeCtx("GET", "/any/path/file.js"), next)

		expect(resolve).toHaveBeenCalledWith(expect.anything(), "/any/path/file.js")
	})

	it("works with HEAD method", async () => {
		const resolve = vi.fn(() => new Response("ok"))
		const mw = staticFiles({ resolve })
		const next = makeNext()

		await mw(makeCtx("HEAD", "/file.js"), next)

		expect(resolve).toHaveBeenCalled()
		expect(next).not.toHaveBeenCalled()
	})

	it("handles async resolve function", async () => {
		const resolve = vi.fn(() => Promise.resolve(new Response("async file")))
		const mw = staticFiles({ resolve })
		const next = makeNext()

		const res = await mw(makeCtx("GET", "/async.js"), next)

		expect(await res.text()).toBe("async file")
		expect(next).not.toHaveBeenCalled()
	})
})
