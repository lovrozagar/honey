import { describe, expect, it } from "vitest"
import { HoneyRes } from "../../../src/response.ts"

describe("HoneyRes — custom headers + cookies branches", () => {
	const res = new HoneyRes()
	const opts = {
		cookies: { token: { httpOnly: true, value: "abc" } },
		headers: { "x-req-id": "42" },
	}

	it("binary() with custom headers + cookies", async () => {
		const data = new Uint8Array([1, 2, 3])
		const response = res.binary("ok", data, opts)
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("application/octet-stream")
		expect(response.headers.get("x-req-id")).toBe("42")
		expect(response.headers.get("set-cookie")).toContain("token=abc")
		const buf = new Uint8Array(await response.arrayBuffer())
		expect(buf).toEqual(data)
	})

	it("csv() with custom headers + cookies", async () => {
		const response = res.csv("ok", "a,b\n1,2", opts)
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8")
		expect(response.headers.get("x-req-id")).toBe("42")
		expect(response.headers.get("set-cookie")).toContain("token=abc")
		expect(await response.text()).toBe("a,b\n1,2")
	})

	it("html() with custom headers + cookies", async () => {
		const response = res.html("ok", "<p>hi</p>", opts)
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
		expect(response.headers.get("x-req-id")).toBe("42")
		expect(response.headers.get("set-cookie")).toContain("token=abc")
		expect(await response.text()).toBe("<p>hi</p>")
	})
})
