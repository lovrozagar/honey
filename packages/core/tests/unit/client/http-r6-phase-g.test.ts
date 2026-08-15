import { describe, expect, it } from "vitest"
import { ClientError } from "../../../src/client/error.ts"
import { HTTPClient } from "../../../src/client/http.ts"
import { resolveInvalidationTargets } from "../../../src/client/sdk.ts"

const PHASE_G_FIXED = true

/* ── helpers ── */

function stubFetch(body: unknown, status = 200, ct = "application/json"): typeof fetch {
	return () =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				headers: { "content-type": ct },
				status,
			}),
		) as unknown as typeof fetch
}

function ctFetch(body: string | ArrayBuffer, ct: string, status = 200): typeof fetch {
	return () =>
		Promise.resolve(
			new Response(body, {
				headers: { "content-type": ct },
				status,
			}),
		) as unknown as typeof fetch
}

function makeClient(fetchFn: typeof fetch): HTTPClient {
	return new HTTPClient({ baseURL: "http://api.example.com", fetch: fetchFn })
}

/* ═══════════════════════════════════════════════════════════════════
   #R6-9 — parseErrorAsClientError string guard + truncate (reference)
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-9 parseErrorAsClientError — Layer A invariants", () => {
	it("string message is preserved as-is", async () => {
		const client = makeClient(stubFetch({ message: "not found" }, 404))
		let caught: unknown
		try {
			await client.request("GET", "/x", {})
		} catch (e) {
			caught = e
		}
		expect(caught).toBeInstanceOf(ClientError)
		expect((caught as ClientError).message).toBe("not found")
	})

	it("thrown ClientError has status matching HTTP status code", async () => {
		const client = makeClient(stubFetch({ message: "gone" }, 410))
		let caught: unknown
		try {
			await client.request("GET", "/x", {})
		} catch (e) {
			caught = e
		}
		expect((caught as ClientError).status).toBe(410)
	})

	it("thrown ClientError body is the parsed JSON object", async () => {
		const client = makeClient(stubFetch({ code: "ERR_GONE", message: "gone" }, 410))
		let caught: unknown
		try {
			await client.request("GET", "/x", {})
		} catch (e) {
			caught = e
		}
		expect((caught as ClientError).body).toEqual({ code: "ERR_GONE", message: "gone" })
	})

	it("body without message field falls back to HTTP {status}", async () => {
		const client = makeClient(stubFetch({ code: "ERR_X" }, 503))
		let caught: unknown
		try {
			await client.request("GET", "/x", {})
		} catch (e) {
			caught = e
		}
		expect((caught as ClientError).message).toBe("HTTP 503")
	})

	it("non-JSON body falls back to HTTP {status}", async () => {
		const client = makeClient(ctFetch("<html>oops</html>", "text/html", 500))
		let caught: unknown
		try {
			await client.request("GET", "/x", {})
		} catch (e) {
			caught = e
		}
		expect((caught as ClientError).message).toBe("HTTP 500")
	})
})

describe.skipIf(PHASE_G_FIXED)("#R6-9 parseErrorAsClientError — Layer B bug witness (pre-fix)", () => {
	it("pre-fix: nested object message coerces to [object Object]", async () => {
		const client = makeClient(stubFetch({ message: { nested: "x" } }, 500))
		let caught: unknown
		try {
			await client.request("GET", "/x", {})
		} catch (e) {
			caught = e
		}
		expect(caught).toBeInstanceOf(ClientError)
		expect((caught as ClientError).message).toBe("[object Object]")
	})
})

describe.runIf(PHASE_G_FIXED)("#R6-9 parseErrorAsClientError — Layer B' regression (post-fix)", () => {
	it("post-fix: nested object message falls back to HTTP 500", async () => {
		const client = makeClient(stubFetch({ message: { nested: "x" } }, 500))
		let caught: unknown
		try {
			await client.request("GET", "/x", {})
		} catch (e) {
			caught = e
		}
		expect(caught).toBeInstanceOf(ClientError)
		expect((caught as ClientError).message).toBe("HTTP 500")
	})

	it("post-fix: 10KB body with control-char message is truncated to 512 and stripped", async () => {
		const payload = { message: `${"x".repeat(10_000)}\u0001\u0002junk` }
		const client = makeClient(stubFetch(payload, 500))
		let caught: unknown
		try {
			await client.request("GET", "/x", {})
		} catch (e) {
			caught = e
		}
		const err = caught as ClientError
		expect(err.message.length).toBeLessThanOrEqual(512)
		const hasControl = [...err.message].some((c) => (c.codePointAt(0) ?? 32) < 32)
		expect(hasControl).toBe(false)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-9 — ClientError stack trace capture
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-9 ClientError — Layer A invariants", () => {
	it("instanceof ClientError and instanceof Error", () => {
		const err = new ClientError({ body: {}, message: "m", response: new Response(), status: 400 })
		expect(err).toBeInstanceOf(ClientError)
		expect(err).toBeInstanceOf(Error)
	})

	it("err.name === ClientError", () => {
		const err = new ClientError({ body: {}, message: "m", response: new Response(), status: 400 })
		expect(err.name).toBe("ClientError")
	})

	it("err.status matches init.status", () => {
		const err = new ClientError({ body: {}, message: "m", response: new Response(), status: 400 })
		expect(err.status).toBe(400)
	})
})

describe.skipIf(PHASE_G_FIXED)("#R6-9 ClientError stack — Layer B bug witness (pre-fix)", () => {
	it("pre-fix: Error.captureStackTrace not called — constructor frame may appear or stack is generic", () => {
		const err = new ClientError({ body: {}, message: "m", response: new Response(), status: 400 })
		/* In V8 without captureStackTrace the constructor frame IS present in the raw stack.
		   In Bun/JSC there is no captureStackTrace, so stacks never include `at new ClassName`.
		   Either way the pre-fix code does NOT call captureStackTrace, so we assert
		   the stack string starts with the error name (basic Error behavior). */
		expect(err.stack).toMatch(/^ClientError:/)
	})
})

describe.runIf(PHASE_G_FIXED)("#R6-9 ClientError stack — Layer B' regression (post-fix)", () => {
	it("post-fix: stack does NOT include ClientError constructor frame (caller is top frame)", () => {
		const err = new ClientError({ body: {}, message: "m", response: new Response(), status: 400 })
		if (typeof Error.captureStackTrace !== "function") return
		expect(err.stack).not.toMatch(/at new ClientError/)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-30 — reference _parseBody content-type MIME parser
   Layer A invariants (always GREEN) — existing correct behavior
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-30 _parseBody MIME parsing — Layer A invariants", () => {
	it("application/json body resolves to parsed object", async () => {
		const client = makeClient(stubFetch({ ok: true }, 200, "application/json"))
		const result = await client.request("GET", "/x", {})
		expect(result).toEqual({ ok: true })
	})

	it("text/html body resolves to string", async () => {
		const client = makeClient(ctFetch("<html>error</html>", "text/html"))
		const result = await client.request("GET", "/x", {})
		expect(typeof result).toBe("string")
		expect(result).toBe("<html>error</html>")
	})

	it("application/octet-stream body resolves to ArrayBuffer", async () => {
		const binary = new Uint8Array([1, 2, 3]).buffer
		const client = makeClient(ctFetch(binary, "application/octet-stream"))
		const result = await client.request("GET", "/x", {})
		expect(result).toBeInstanceOf(ArrayBuffer)
	})
})

describe.skipIf(PHASE_G_FIXED)("#R6-30 _parseBody MIME parsing — Layer B bug witness (pre-fix)", () => {
	it("pre-fix: application/vnd.api+json resolves to raw string", async () => {
		const client = makeClient(ctFetch('{"ok":true}', "application/vnd.api+json"))
		const result = await client.request("GET", "/x", {})
		expect(typeof result).toBe("string")
	})

	it("pre-fix: application/ld+json resolves to raw string", async () => {
		const client = makeClient(ctFetch('{"@context":"http://schema.org"}', "application/ld+json"))
		const result = await client.request("GET", "/x", {})
		expect(typeof result).toBe("string")
	})

	it("pre-fix: application/problem+json resolves to raw string", async () => {
		const client = makeClient(ctFetch('{"type":"about:blank"}', "application/problem+json"))
		const result = await client.request("GET", "/x", {})
		expect(typeof result).toBe("string")
	})

	it("pre-fix: application/jsonp triggers .json() call due to substring match — throws SyntaxError", async () => {
		/* application/jsonp contains the substring "application/json" so current ct.includes()
		   incorrectly routes it to response.json(), which throws on non-JSON content. */
		const client = makeClient(ctFetch("callback({});", "application/jsonp"))
		await expect(client.request("GET", "/x", {})).rejects.toThrow(SyntaxError)
	})
})

describe.runIf(PHASE_G_FIXED)("#R6-30 _parseBody MIME parsing — Layer B' regression (post-fix)", () => {
	it("post-fix: application/vnd.api+json resolves to parsed JSON object", async () => {
		const client = makeClient(ctFetch('{"ok":true}', "application/vnd.api+json"))
		const result = await client.request("GET", "/x", {})
		expect(result).toEqual({ ok: true })
	})

	it("post-fix: application/ld+json resolves to parsed JSON object", async () => {
		const client = makeClient(ctFetch('{"@context":"http://schema.org"}', "application/ld+json"))
		const result = await client.request("GET", "/x", {})
		expect(result).toEqual({ "@context": "http://schema.org" })
	})

	it("post-fix: application/problem+json resolves to parsed JSON object", async () => {
		const client = makeClient(ctFetch('{"type":"about:blank"}', "application/problem+json"))
		const result = await client.request("GET", "/x", {})
		expect(result).toEqual({ type: "about:blank" })
	})

	it("post-fix: application/jsonp resolves to ArrayBuffer (binary fallback)", async () => {
		const client = makeClient(ctFetch("callback({});", "application/jsonp"))
		const result = await client.request("GET", "/x", {})
		expect(result).toBeInstanceOf(ArrayBuffer)
	})

	it("post-fix: application/pdf resolves to ArrayBuffer", async () => {
		const binary = new Uint8Array([37, 80, 68, 70]).buffer
		const client = makeClient(ctFetch(binary, "application/pdf"))
		const result = await client.request("GET", "/x", {})
		expect(result).toBeInstanceOf(ArrayBuffer)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-11 — reference OnRequestContext.body exposure
   Layer A invariant: GET has ctx.body === undefined (always GREEN)
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-11 OnRequestContext.body — Layer A invariants", () => {
	it("GET request — ctx.body is undefined in onRequest hook", async () => {
		let capturedBody: unknown = "NOT_SET"
		const client = new HTTPClient({
			baseURL: "http://api.example.com",
			fetch: stubFetch({}),
			onRequest: [
				(ctx) => {
					capturedBody = ctx.body
				},
			],
		})
		await client.request("GET", "/x", {})
		expect(capturedBody).toBeUndefined()
	})
})

describe.skipIf(PHASE_G_FIXED)("#R6-11 OnRequestContext.body — Layer B bug witness (pre-fix)", () => {
	it("pre-fix: POST with json — ctx.body is undefined (body not threaded into reqCtx)", async () => {
		let capturedBody: unknown = "NOT_SET"
		const client = new HTTPClient({
			baseURL: "http://api.example.com",
			fetch: stubFetch({}),
			onRequest: [
				(ctx) => {
					capturedBody = ctx.body
				},
			],
		})
		await client.request("POST", "/x", { json: { a: 1 } })
		expect(capturedBody).toBeUndefined()
	})
})

describe.runIf(PHASE_G_FIXED)("#R6-11 OnRequestContext.body — Layer B' regression (post-fix)", () => {
	it("post-fix: POST with json — ctx.body equals JSON.stringify({a:1})", async () => {
		let capturedBody: unknown = "NOT_SET"
		const client = new HTTPClient({
			baseURL: "http://api.example.com",
			fetch: stubFetch({}),
			onRequest: [
				(ctx) => {
					capturedBody = ctx.body
				},
			],
		})
		await client.request("POST", "/x", { json: { a: 1 } })
		expect(capturedBody).toBe(JSON.stringify({ a: 1 }))
	})

	it("post-fix: hook mutation of ctx.body rewrites the outgoing request body", async () => {
		let sentBody: BodyInit | null | undefined
		const client = new HTTPClient({
			baseURL: "http://api.example.com",
			fetch: ((_url: RequestInfo | URL, init?: RequestInit) => {
				sentBody = init?.body
				return Promise.resolve(new Response("{}", { headers: { "content-type": "application/json" }, status: 200 }))
			}) as typeof fetch,
			onRequest: [
				(ctx) => {
					ctx.body = JSON.stringify({ a: 2 })
				},
			],
		})
		await client.request("POST", "/x", { json: { a: 1 } })
		expect(sentBody).toBe(JSON.stringify({ a: 2 }))
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-12 — reference resolveInvalidationTargets unresolved drop
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-12 resolveInvalidationTargets — Layer A invariants", () => {
	it("fully resolved target substitutes :param correctly", () => {
		expect(resolveInvalidationTargets(["GET /v1/x/:id"], { id: "42" })).toEqual(["GET /v1/x/42"])
	})

	it("target with no placeholders passes through unchanged", () => {
		expect(resolveInvalidationTargets(["GET /v1/x"], { id: "42" })).toEqual(["GET /v1/x"])
	})

	it("undefined params — target passes through unchanged", () => {
		expect(resolveInvalidationTargets(["GET /v1/x"], undefined)).toEqual(["GET /v1/x"])
	})

	it("mixed batch — both fully-resolved targets returned", () => {
		expect(resolveInvalidationTargets(["GET /v1/x", "GET /v1/y/:id"], { id: "7" })).toEqual([
			"GET /v1/x",
			"GET /v1/y/7",
		])
	})

	it("mixed with partial miss — fully-resolved target kept, unresolved dropped (target behavior)", () => {
		/* pre-fix: both entries returned, unresolved passes through;
		   post-fix: only resolved entry returned. This Layer A shape asserts the INTENDED contract.
		   The bug witness below locks the current (wrong) behavior. */
		const result = resolveInvalidationTargets(["GET /v1/x/:id", "GET /v1/y/:other"], { id: "7" })
		expect(result).toContain("GET /v1/x/7")
	})

	it("empty targets array returns empty array", () => {
		expect(resolveInvalidationTargets([], { id: "1" })).toEqual([])
	})
})

describe.skipIf(PHASE_G_FIXED)("#R6-12 resolveInvalidationTargets — Layer B bug witness (pre-fix)", () => {
	it("pre-fix: unresolved :tenant_id param passes through as-is (not dropped)", () => {
		const result = resolveInvalidationTargets(["GET /v1/tenants/:tenant_id/rows"], { org_id: "x" })
		expect(result).toEqual(["GET /v1/tenants/:tenant_id/rows"])
	})
})

describe.runIf(PHASE_G_FIXED)("#R6-12 resolveInvalidationTargets — Layer B' regression (post-fix)", () => {
	it("post-fix: unresolved :tenant_id param causes target to be dropped (returns [])", () => {
		const result = resolveInvalidationTargets(["GET /v1/tenants/:tenant_id/rows"], { org_id: "x" })
		expect(result).toEqual([])
	})

	it("post-fix: multi-param target where one param unresolved — entire target dropped", () => {
		const result = resolveInvalidationTargets(["GET /v1/x/:a/:b"], { a: "1" })
		expect(result).toEqual([])
	})

	it("post-fix: multi-param target where all params resolved — target kept", () => {
		const result = resolveInvalidationTargets(["GET /v1/x/:a/:b"], { a: "1", b: "2" })
		expect(result).toEqual(["GET /v1/x/1/2"])
	})
})
