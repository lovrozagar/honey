import { describe, expect, it, vi } from "vitest"
import { honey } from "../../../src/index.ts"
import { HoneyRes } from "../../../src/response.ts"
import { parseCookies } from "../../../src/validation.ts"

/* ------------------------------------------------------------------ */
/*  P0-1: SSE keepalive timer leak when callback resolves normally    */
/* ------------------------------------------------------------------ */
describe("P0-1: SSE keepalive timer not cleaned on callback resolve", () => {
	it("callback resolves without close() → timer should be cleared", async () => {
		const res = new HoneyRes()
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval")

		const response = res.sse(
			async (_stream) => {
				/* callback resolves immediately without calling stream.close() */
			},
			{ keepalive: 50 },
		)

		/* give callback microtask time to resolve */
		await new Promise((r) => setTimeout(r, 10))

		const timerCleared = clearIntervalSpy.mock.calls.length > 0
		expect(timerCleared).toBe(true)

		clearIntervalSpy.mockRestore()

		/* consume response to avoid dangling stream */
		response.body?.cancel()
	})
})

/* ------------------------------------------------------------------ */
/*  P0-2: SSE client buffer unbounded memory growth                   */
/* ------------------------------------------------------------------ */
describe("P0-2: SSE client parseSSEStream buffer has no size limit", () => {
	it("stream without delimiters grows buffer without bound", async () => {
		const { parseSSEStream } = await import("../../../src/client/sse.ts")

		/* create a stream that sends 2MB of data without any \n\n delimiter */
		const chunk = new TextEncoder().encode(`data: ${"x".repeat(1024)}`)
		let pushed = 0
		const maxBytes = 2 * 1024 * 1024

		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pushed >= maxBytes) {
					controller.close()
					return
				}
				controller.enqueue(chunk)
				pushed += chunk.byteLength
			},
		})

		const events: unknown[] = []
		let errorCaught = false

		try {
			for await (const event of parseSSEStream(stream)) {
				events.push(event)
			}
		} catch {
			errorCaught = true
		}

		expect(errorCaught).toBe(true)
	})
})

/* ------------------------------------------------------------------ */
/*  P1-4: X-Forwarded-For trusted by default                         */
/* ------------------------------------------------------------------ */
describe("P1-4: ipRestrict trusts X-Forwarded-For by default", () => {
	it("spoofed XFF header bypasses allowList", async () => {
		const { ipRestrict } = await import("../../../src/ip-restrict.ts")

		const app = honey()
			.use(ipRestrict({ allowList: ["10.0.0.1"] }))
			.get("/secret")
			.handler((ctx) => ctx.res.json("ok", { access: "granted" }))

		/* attacker spoofs X-Forwarded-For to match allowList */
		const res = await app.fetch(
			new Request("http://localhost/secret", {
				headers: { "x-forwarded-for": "10.0.0.1" },
			}),
			{},
		)

		expect(res.status).toBe(403)
	})
})

/* ------------------------------------------------------------------ */
/*  P1-5: IPv6 CIDR silently degrades to exact match                  */
/* ------------------------------------------------------------------ */
describe("P1-5: IPv6 CIDR rules don't work", () => {
	it("::1/128 in allowList should match request from ::1", async () => {
		const { ipRestrict } = await import("../../../src/ip-restrict.ts")

		const app = honey()
			.use(
				ipRestrict({
					allowList: ["::1/128"],
					getIp: () => "::1",
				}),
			)
			.get("/test")
			.handler((ctx) => ctx.res.text("ok", "allowed"))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})

	it("2001:db8::/32 should match 2001:db8::1", async () => {
		const { ipRestrict } = await import("../../../src/ip-restrict.ts")

		const app = honey()
			.use(
				ipRestrict({
					allowList: ["2001:db8::/32"],
					getIp: () => "2001:db8::1",
				}),
			)
			.get("/test")
			.handler((ctx) => ctx.res.text("ok", "allowed"))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})
})

/* ------------------------------------------------------------------ */
/*  P2-11: Client dual-mode fires two requests                       */
/* ------------------------------------------------------------------ */
describe("P2-11: client dual-mode fires both REST and SSE requests", () => {
	it("for-await triggers SSE AND REST request via microtask", async () => {
		const { createClient } = await import("../../../src/client/index.ts")

		let fetchCount = 0

		/* mock fetch — returns SSE stream so both paths work */
		const originalFetch = globalThis.fetch
		globalThis.fetch = async () => {
			fetchCount++
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("data: hello\n\n"))
						controller.close()
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			)
		}

		try {
			const client = createClient<unknown>({ baseURL: "http://localhost" })
			const getFn = (client as unknown as Record<string, (p: string) => AsyncIterable<unknown>>).get
			const lazy = getFn("/test")

			/* iterate — triggers SSE path */
			const iter = lazy[Symbol.asyncIterator]()
			await iter.next()

			/* let microtask fire */
			await new Promise((r) => setTimeout(r, 50))

			expect(fetchCount).toBe(1)

			await iter.return?.()
		} finally {
			globalThis.fetch = originalFetch
		}
	})
})

/* ------------------------------------------------------------------ */
/*  P2-12: Cookie parsing doesn't strip RFC 6265 quoted values        */
/* ------------------------------------------------------------------ */
describe("P2-12: parseCookies doesn't strip quoted values", () => {
	it('session="abc=def" should parse to abc=def without quotes', () => {
		const result = parseCookies('session="abc=def"')
		expect(result.session).toBe("abc=def")
	})

	it('token="hello world" should strip quotes', () => {
		const result = parseCookies('token="hello world"')
		expect(result.token).toBe("hello world")
	})
})

/* ------------------------------------------------------------------ */
/*  P2-13: Dangerous keys not filtered in cookies                     */
/* ------------------------------------------------------------------ */
describe("P2-13: DANGEROUS_KEYS not filtered in cookies", () => {
	it("constructor key in cookie overwrites Object.constructor", () => {
		const result = parseCookies("constructor=evil")
		expect(result.constructor).toBe(Object)
	})
})
