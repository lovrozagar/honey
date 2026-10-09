import type { IncomingMessage } from "node:http"
import { describe, expect, it } from "vitest"
import { nodeRequestUrl } from "../../../src/node-request.ts"

function incoming(url: string, host: string | undefined, opts: { encrypted?: boolean; httpVersion?: string } = {}) {
	return {
		headers: host === undefined ? {} : { host },
		httpVersion: opts.httpVersion ?? "1.1",
		socket: { encrypted: opts.encrypted },
		url,
	} as unknown as IncomingMessage
}

describe("nodeRequestUrl", () => {
	it("joins scheme, Host and an origin-form target", () => {
		expect(nodeRequestUrl(incoming("/a/b?x=1", "api.example.com"))).toBe("http://api.example.com/a/b?x=1")
		expect(nodeRequestUrl(incoming("//admin", "h:8080"))).toBe("http://h:8080//admin")
	})

	it("takes the scheme from the socket's TLS state", () => {
		expect(nodeRequestUrl(incoming("/", "h", { encrypted: true }))).toBe("https://h/")
	})

	it("parses targets that need it the way URL parsing does, never as a host", () => {
		expect(nodeRequestUrl(incoming("/a\\b", "h"))).toBe("http://h/a/b")
		expect(nodeRequestUrl(incoming("/a/../b", "h"))).toBe("http://h/b")
		expect(nodeRequestUrl(incoming("//evil.example/../x", "h"))).toBe("http://h//x")
	})

	it("uses the authority of an absolute-form target", () => {
		expect(nodeRequestUrl(incoming("http://other:81/files/x?q", "h"))).toBe("http://other:81/files/x?q")
		expect(nodeRequestUrl(incoming("HTTPS://other/x", "h"))).toBe("http://other/x")
		expect(nodeRequestUrl(incoming("http://u:p@other/x", "h"))).toBeNull()
		expect(nodeRequestUrl(incoming("ftp://other/x", "h"))).toBeNull()
	})

	it("rejects other target forms", () => {
		expect(nodeRequestUrl(incoming("*", "h"))).toBeNull()
		expect(nodeRequestUrl(incoming("other:443", "h"))).toBeNull()
	})

	it("rejects a Host that is not host[:port]", () => {
		for (const host of ["x/admin/secret", "evil.com/admin?", "a b", "h:99999", "h?", "h#x", "", "h:", "-h", "user@h"]) {
			expect(nodeRequestUrl(incoming("/", host)), host).toBeNull()
		}
		for (const host of ["h", "h:65535", "[::1]", "[::1]:80", "API.Example.com.", "10.0.0.1:3000"]) {
			expect(nodeRequestUrl(incoming("/", host)), host).not.toBeNull()
		}
	})

	it("needs a Host on HTTP/1.1, not on HTTP/1.0", () => {
		expect(nodeRequestUrl(incoming("/", undefined))).toBeNull()
		expect(nodeRequestUrl(incoming("/", undefined, { httpVersion: "1.0" }))).toBe("http://localhost/")
	})
})
