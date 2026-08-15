import { describe, expect, it } from "vitest"
import { HoneyRes, serializeCookie } from "../../../src/response.ts"

describe("HoneyRes", () => {
	const res = new HoneyRes()

	describe("json", () => {
		it("returns Response with application/json content-type", async () => {
			const response = res.json("ok", { id: 1 })
			expect(response).toBeInstanceOf(Response)
			expect(response.status).toBe(200)
			expect(response.headers.get("content-type")).toBe("application/json")
			expect(await response.json()).toEqual({ id: 1 })
		})

		it("maps status key to correct HTTP status code", () => {
			expect(res.json("created", {}).status).toBe(201)
			expect(res.json("not_found", {}).status).toBe(404)
			expect(res.json("internal_server_error", {}).status).toBe(500)
		})

		it("applies custom headers from options", () => {
			const response = res.json("ok", {}, { headers: { "x-custom": "val" } })
			expect(response.headers.get("x-custom")).toBe("val")
		})

		it("applies cookies from options", () => {
			const response = res.json(
				"ok",
				{},
				{
					cookies: { session: { httpOnly: true, value: "abc123" } },
				},
			)
			const cookie = response.headers.get("set-cookie")
			expect(cookie).toContain("session=abc123")
			expect(cookie).toContain("HttpOnly")
		})
	})

	describe("text", () => {
		it("returns Response with text/plain content-type and status from key", async () => {
			const response = res.text("ok", "hello")
			expect(response).toBeInstanceOf(Response)
			expect(response.status).toBe(200)
			expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
			expect(await response.text()).toBe("hello")
		})

		it("maps status key to HTTP status code", () => {
			expect(res.text("created", "done").status).toBe(201)
			expect(res.text("accepted", "queued").status).toBe(202)
		})
	})

	describe("html", () => {
		it("returns Response with text/html content-type and status from key", async () => {
			const response = res.html("ok", "<h1>hi</h1>")
			expect(response).toBeInstanceOf(Response)
			expect(response.status).toBe(200)
			expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
			expect(await response.text()).toBe("<h1>hi</h1>")
		})
	})

	describe("xml", () => {
		it("returns Response with application/xml content-type", async () => {
			const response = res.xml("ok", "<root><item>1</item></root>")
			expect(response).toBeInstanceOf(Response)
			expect(response.status).toBe(200)
			expect(response.headers.get("content-type")).toBe("application/xml")
			expect(await response.text()).toBe("<root><item>1</item></root>")
		})
	})

	describe("csv", () => {
		it("returns Response with text/csv content-type", async () => {
			const response = res.csv("ok", "name,age\nAlice,30")
			expect(response).toBeInstanceOf(Response)
			expect(response.status).toBe(200)
			expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8")
			expect(await response.text()).toBe("name,age\nAlice,30")
		})
	})

	describe("binary", () => {
		it("returns Response with application/octet-stream content-type", async () => {
			const data = new Uint8Array([1, 2, 3])
			const response = res.binary("ok", data)
			expect(response).toBeInstanceOf(Response)
			expect(response.status).toBe(200)
			expect(response.headers.get("content-type")).toBe("application/octet-stream")
			const buf = new Uint8Array(await response.arrayBuffer())
			expect(buf).toEqual(data)
		})
	})

	describe("noContent", () => {
		it("returns 204 with null body", () => {
			const response = res.noContent()
			expect(response).toBeInstanceOf(Response)
			expect(response.status).toBe(204)
			expect(response.body).toBeNull()
		})
	})

	describe("redirect", () => {
		it("returns 302 with location header by default", () => {
			const response = res.redirect("/new")
			expect(response).toBeInstanceOf(Response)
			expect(response.status).toBe(302)
			expect(response.headers.get("location")).toBe("/new")
		})

		it("supports custom status via opts", () => {
			const response = res.redirect("/new", { status: 307 })
			expect(response.status).toBe(307)
		})
	})

	describe("raw", () => {
		it("returns the response as TypedResponse", async () => {
			const plain = new Response("proxied", { status: 200 })
			const response = res.raw(plain)
			expect(response).toBeInstanceOf(Response)
			expect(response.status).toBe(200)
			expect(await response.text()).toBe("proxied")
		})
	})

	describe("sse", () => {
		it("returns Response with text/event-stream content-type", () => {
			const response = res.sse(async (stream) => {
				await stream.send({ data: "hello", event: "msg" })
				stream.close()
			})
			expect(response).toBeInstanceOf(Response)
			expect(response.headers.get("content-type")).toBe("text/event-stream")
			expect(response.headers.get("cache-control")).toBe("no-cache")
		})

		it("multiline data split into multiple data: lines", async () => {
			const response = res.sse(async (stream) => {
				await stream.send({ data: "line1\nline2\nline3", event: "msg" })
				stream.close()
			})
			const text = await response.text()
			expect(text).toContain("data: line1\n")
			expect(text).toContain("data: line2\n")
			expect(text).toContain("data: line3\n")
			/* must NOT have a single data: with raw newlines */
			expect(text).not.toContain("data: line1\nline2")
		})

		it("event name with newline throws", async () => {
			let caught = false
			const response = res.sse(async (stream) => {
				try {
					await stream.send({ data: "x", event: "bad\nevent" })
				} catch {
					caught = true
				}
				stream.close()
			})
			await response.text()
			expect(caught).toBe(true)
		})

		it("event id with newline throws", async () => {
			let caught = false
			const response = res.sse(async (stream) => {
				try {
					await stream.send({ data: "x", event: "ok", id: "bad\nid" })
				} catch {
					caught = true
				}
				stream.close()
			})
			await response.text()
			expect(caught).toBe(true)
		})

		it("negative retry → retry line not emitted", async () => {
			const response = res.sse(async (stream) => {
				await stream.send({ data: "x", event: "msg", retry: -500 })
				stream.close()
			})
			const text = await response.text()
			expect(text).not.toContain("retry:")
		})

		it("NaN retry → retry line not emitted", async () => {
			const response = res.sse(async (stream) => {
				await stream.send({ data: "x", event: "msg", retry: NaN })
				stream.close()
			})
			const text = await response.text()
			expect(text).not.toContain("retry:")
		})

		it("Infinity retry → retry line not emitted", async () => {
			const response = res.sse(async (stream) => {
				await stream.send({ data: "x", event: "msg", retry: Infinity })
				stream.close()
			})
			const text = await response.text()
			expect(text).not.toContain("retry:")
		})

		it("valid retry → emitted and floored", async () => {
			const response = res.sse(async (stream) => {
				await stream.send({ data: "x", event: "msg", retry: 3000 })
				stream.close()
			})
			const text = await response.text()
			expect(text).toContain("retry: 3000\n")
		})

		it("fractional retry → floored to integer", async () => {
			const response = res.sse(async (stream) => {
				await stream.send({ data: "x", event: "msg", retry: 1500.7 })
				stream.close()
			})
			const text = await response.text()
			expect(text).toContain("retry: 1500\n")
		})

		it("zero retry → valid (immediate reconnect)", async () => {
			const response = res.sse(async (stream) => {
				await stream.send({ data: "x", event: "msg", retry: 0 })
				stream.close()
			})
			const text = await response.text()
			expect(text).toContain("retry: 0\n")
		})

		it("CRLF and CR in data also split correctly", async () => {
			const response = res.sse(async (stream) => {
				await stream.send({ data: "a\r\nb\rc", event: "msg" })
				stream.close()
			})
			const text = await response.text()
			expect(text).toContain("data: a\n")
			expect(text).toContain("data: b\n")
			expect(text).toContain("data: c\n")
		})
	})

	describe("cookie serialization", () => {
		it("encodes special characters in cookie value", () => {
			const cookie = serializeCookie("msg", { value: "hello world" })
			/* space is not a valid cookie-octet — must be percent-encoded */
			expect(cookie).not.toContain("hello world")
			expect(cookie).toContain("hello%20world")
		})

		it("encodes semicolons in cookie value", () => {
			const cookie = serializeCookie("data", { value: "a;b" })
			expect(cookie).not.toContain("a;b")
			expect(cookie).toContain("a%3Bb")
		})

		it("preserves safe cookie-octet characters", () => {
			const cookie = serializeCookie("token", { value: "abc123-_.~" })
			expect(cookie).toBe("token=abc123-_.~")
		})
	})

	describe("cookie name validation", () => {
		it("valid name → no error", () => {
			expect(() => serializeCookie("valid_name", { value: "x" })).not.toThrow()
		})

		it("valid name with special chars → no error", () => {
			expect(() => serializeCookie("also-valid.name", { value: "x" })).not.toThrow()
		})

		it("space in name → throws", () => {
			expect(() => serializeCookie("bad name", { value: "x" })).toThrow()
		})

		it("semicolon in name → throws", () => {
			expect(() => serializeCookie("bad;name", { value: "x" })).toThrow()
		})

		it("equals in name → throws", () => {
			expect(() => serializeCookie("bad=name", { value: "x" })).toThrow()
		})

		it("tab in name → throws", () => {
			expect(() => serializeCookie("bad\tname", { value: "x" })).toThrow()
		})

		it("empty name → throws", () => {
			expect(() => serializeCookie("", { value: "x" })).toThrow()
		})

		it("comma in name → throws", () => {
			expect(() => serializeCookie("bad,name", { value: "x" })).toThrow()
		})
	})

	describe("cookie expires validation", () => {
		it("valid Date → Expires header present", () => {
			const cookie = serializeCookie("s", { expires: new Date("2030-01-01"), value: "x" })
			expect(cookie).toContain("Expires=")
			expect(cookie).not.toContain("Invalid Date")
		})

		it("invalid Date → throws", () => {
			expect(() => serializeCookie("s", { expires: new Date("invalid"), value: "x" })).toThrow()
		})
	})

	describe("cookie path/domain injection prevention", () => {
		it("path with semicolon → throws", () => {
			expect(() => serializeCookie("s", { path: "/; Secure; HttpOnly", value: "x" })).toThrow()
		})

		it("path with CRLF → throws", () => {
			expect(() => serializeCookie("s", { path: "/\r\nX-Injected: yes", value: "x" })).toThrow()
		})

		it("domain with semicolon → throws", () => {
			expect(() => serializeCookie("s", { domain: "evil.com; Path=/", value: "x" })).toThrow()
		})

		it("domain with CRLF → throws", () => {
			expect(() =>
				serializeCookie("s", { domain: "evil.com\r\nX-Injected: yes", value: "x" }),
			).toThrow()
		})

		it("path with normal value → no error", () => {
			expect(() => serializeCookie("s", { path: "/api/v1", value: "x" })).not.toThrow()
		})

		it("domain with normal value → no error", () => {
			expect(() => serializeCookie("s", { domain: ".example.com", value: "x" })).not.toThrow()
		})
	})

	describe("cookie prefix validation", () => {
		it("__Host- with secure + path=/ → valid", () => {
			expect(() =>
				serializeCookie("__Host-session", { path: "/", secure: true, value: "abc" }),
			).not.toThrow()
		})

		it("__Host- without secure → throws", () => {
			expect(() => serializeCookie("__Host-session", { value: "abc" })).toThrow("__Host-")
		})

		it("__Host- with domain → throws", () => {
			expect(() =>
				serializeCookie("__Host-session", {
					domain: "example.com",
					secure: true,
					value: "abc",
				}),
			).toThrow("__Host-")
		})

		it("__Host- with path=/api → throws", () => {
			expect(() =>
				serializeCookie("__Host-session", { path: "/api", secure: true, value: "abc" }),
			).toThrow("__Host-")
		})

		it("__Host- with no path → auto-sets /", () => {
			const cookie = serializeCookie("__Host-session", { secure: true, value: "abc" })
			expect(cookie).toContain("Path=/")
		})

		it("__Secure- with secure → valid", () => {
			expect(() => serializeCookie("__Secure-token", { secure: true, value: "xyz" })).not.toThrow()
		})

		it("__Secure- without secure → throws", () => {
			expect(() => serializeCookie("__Secure-token", { value: "xyz" })).toThrow("__Secure-")
		})

		it("normal cookie name → no prefix validation", () => {
			expect(() => serializeCookie("session", { value: "abc" })).not.toThrow()
		})
	})

	describe("stream", () => {
		it("returns Response with streaming body", async () => {
			const response = res.stream(async (writable) => {
				const writer = writable.getWriter()
				await writer.write(new TextEncoder().encode("chunk"))
				await writer.close()
			})
			expect(response).toBeInstanceOf(Response)
			expect(await response.text()).toBe("chunk")
		})

		it("callback error closes the writable stream", async () => {
			const response = res.stream(async () => {
				throw new Error("stream callback failed")
			})
			/* stream should be closed, not left dangling */
			const text = await response.text()
			/* closed stream produces empty body — not a hanging request */
			expect(text).toBe("")
		})
	})

	describe("generate", () => {
		it("sync generator → response body has all chunks", async () => {
			function* gen() {
				yield "a"
				yield "b"
				yield "c"
			}
			const response = res.generate(gen())
			expect(response).toBeInstanceOf(Response)
			expect(await response.text()).toBe("abc")
		})

		it("async generator → response body has all chunks", async () => {
			async function* gen() {
				yield "line1\n"
				yield "line2\n"
			}
			const response = res.generate(gen())
			expect(await response.text()).toBe("line1\nline2\n")
		})

		it("generator that throws → stream closed", async () => {
			async function* gen() {
				yield "ok\n"
				throw new Error("gen failed")
			}
			const response = res.generate(gen())
			const text = await response.text()
			/* at least the first chunk should be written before error */
			expect(text).toContain("ok\n")
		})

		it("empty generator → empty body", async () => {
			async function* gen() {
				/* yields nothing */
			}
			const response = res.generate(gen())
			expect(await response.text()).toBe("")
		})

		it("custom content-type", async () => {
			async function* gen() {
				yield "{}\n"
			}
			const response = res.generate(gen(), { contentType: "application/x-ndjson" })
			expect(response.headers.get("content-type")).toBe("application/x-ndjson")
		})

		it("default content-type is application/octet-stream", async () => {
			async function* gen() {
				yield "x"
			}
			const response = res.generate(gen())
			expect(response.headers.get("content-type")).toBe("application/octet-stream")
		})

		it("consumer: NDJSON streaming", async () => {
			async function* gen() {
				for (let i = 0; i < 5; i++) {
					yield `${JSON.stringify({ id: i })}\n`
				}
			}
			const response = res.generate(gen(), { contentType: "application/x-ndjson" })
			const text = await response.text()
			const lines = text.trim().split("\n")
			expect(lines).toHaveLength(5)
			expect(JSON.parse(lines[0])).toEqual({ id: 0 })
			expect(JSON.parse(lines[4])).toEqual({ id: 4 })
		})

		it("consumer: large dataset yields all received", async () => {
			async function* gen() {
				for (let i = 0; i < 1000; i++) {
					yield `row-${i}\n`
				}
			}
			const response = res.generate(gen())
			const text = await response.text()
			const lines = text.trim().split("\n")
			expect(lines).toHaveLength(1000)
			expect(lines[999]).toBe("row-999")
		})
	})
})
