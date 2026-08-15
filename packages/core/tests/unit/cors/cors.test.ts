import { describe, expect, it } from "vitest"
import { cors } from "../../../src/cors.ts"

function makeReq(origin?: string, method = "GET", acRequestMethod?: string): Request {
	const headers: Record<string, string> = {}
	if (origin) headers.origin = origin
	if (acRequestMethod) headers["access-control-request-method"] = acRequestMethod
	return new Request("http://localhost/test", { headers, method })
}

async function runCors(
	req: Request,
	options?: Parameters<typeof cors>[0],
	handlerResponse?: Response,
): Promise<Response> {
	const mw = cors(options)
	return mw(
		{ req } as Parameters<typeof mw>[0],
		(() => Promise.resolve(handlerResponse ?? new Response("ok"))) as Parameters<typeof mw>[1],
	)
}

describe("cors — defaults", () => {
	it("* origin in response", async () => {
		const res = await runCors(makeReq("http://example.com"))
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
	})
})

describe("cors — origin matching", () => {
	it("specific origin string: matching → headers", async () => {
		const res = await runCors(makeReq("http://example.com"), { origin: "http://example.com" })
		expect(res.headers.get("access-control-allow-origin")).toBe("http://example.com")
	})

	it("specific origin string: non-matching → no CORS headers", async () => {
		const res = await runCors(makeReq("http://other.com"), { origin: "http://example.com" })
		expect(res.headers.get("access-control-allow-origin")).toBeNull()
	})

	it("origin array: matching one → headers", async () => {
		const res = await runCors(makeReq("http://b.com"), { origin: ["http://a.com", "http://b.com"] })
		expect(res.headers.get("access-control-allow-origin")).toBe("http://b.com")
	})

	it("dynamic origin function: returns true → headers", async () => {
		const res = await runCors(makeReq("http://dynamic.com"), {
			origin: (o) => o.includes("dynamic"),
		})
		expect(res.headers.get("access-control-allow-origin")).toBe("http://dynamic.com")
	})

	it("dynamic origin: Vary: Origin auto-added", async () => {
		const res = await runCors(makeReq("http://dynamic.com"), {
			origin: () => true,
		})
		expect(res.headers.get("vary")).toContain("Origin")
	})
})

describe("cors — preflight", () => {
	it("OPTIONS with AC-Request-Method → 204 with CORS headers", async () => {
		const res = await runCors(makeReq("http://example.com", "OPTIONS", "POST"), { origin: "*" })
		expect(res.status).toBe(204)
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
		expect(res.headers.get("access-control-allow-methods")).toBeTruthy()
	})

	it("correct allow-methods list", async () => {
		const res = await runCors(makeReq("http://example.com", "OPTIONS", "POST"), {
			methods: ["GET", "POST"],
			origin: "*",
		})
		expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST")
	})

	it("correct allow-headers list", async () => {
		const res = await runCors(makeReq("http://example.com", "OPTIONS", "POST"), {
			headers: ["Authorization", "Content-Type"],
			origin: "*",
		})
		expect(res.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type")
	})

	it("max-age from config", async () => {
		const res = await runCors(makeReq("http://example.com", "OPTIONS", "POST"), {
			maxAge: 3600,
			origin: "*",
		})
		expect(res.headers.get("access-control-max-age")).toBe("3600")
	})
})

describe("cors — credentials", () => {
	it("credentials true → AC-Allow-Credentials", async () => {
		const res = await runCors(makeReq("http://example.com"), {
			credentials: true,
			origin: "http://example.com",
		})
		expect(res.headers.get("access-control-allow-credentials")).toBe("true")
	})
})

describe("cors — expose headers", () => {
	it("exposeHeaders set", async () => {
		const res = await runCors(makeReq("http://example.com"), {
			exposeHeaders: ["X-Total-Count"],
			origin: "*",
		})
		expect(res.headers.get("access-control-expose-headers")).toBe("X-Total-Count")
	})
})

describe("cors — no origin header", () => {
	it("no Origin → no CORS headers", async () => {
		const res = await runCors(makeReq())
		expect(res.headers.get("access-control-allow-origin")).toBeNull()
	})
})

describe("cors — Vary header on static origin", () => {
	it("preflight with static origin includes Vary: Origin", async () => {
		const res = await runCors(makeReq("http://example.com", "OPTIONS", "POST"), {
			origin: "http://example.com",
		})
		const vary = res.headers.get("vary") ?? ""
		expect(vary).toContain("Origin")
	})

	it("actual request with static origin includes Vary: Origin", async () => {
		const res = await runCors(makeReq("http://example.com"), {
			origin: "http://example.com",
		})
		const vary = res.headers.get("vary") ?? ""
		expect(vary).toContain("Origin")
	})

	it("wildcard origin does NOT set Vary", async () => {
		const res = await runCors(makeReq("http://example.com"), { origin: "*" })
		expect(res.headers.get("vary")).toBeNull()
	})
})

describe("cors — simple request", () => {
	it("CORS headers on actual response", async () => {
		const res = await runCors(
			makeReq("http://example.com"),
			{ origin: "*" },
			new Response("data", { headers: { "x-custom": "val" } }),
		)
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
		expect(res.headers.get("x-custom")).toBe("val")
	})
})
