import { describe, expect, it } from "vitest"
import { requestToCurl, shellQuote } from "./request-to-curl.ts"

describe("requestToCurl(): a request as a shell command that reproduces it", () => {
	// v0: 29e2c71317
	it("every word quoted, the body included, and the original body left unread", async () => {
		const request = new Request("https://example.com/api/users?active=true", {
			body: JSON.stringify({ name: "O'Reilly" }),
			headers: { "content-type": "application/json", "x-test": "it's-set" },
			method: "POST",
		})
		const command = await requestToCurl(request)
		expect([command, await request.text()]).toEqual([
			"curl -X 'POST' -H 'content-type: application/json' -H 'x-test: it'\\''s-set' --data-raw '{\"name\":\"O'\\''Reilly\"}' 'https://example.com/api/users?active=true'",
			'{"name":"O\'Reilly"}',
		])
	})

	it("faithful by default: credentials are kept, since a redacted command cannot reproduce the request", async () => {
		const command = await requestToCurl(
			new Request("https://example.com/", { headers: { authorization: "Bearer t0ken" } }),
		)
		expect(command).toBe("curl -X 'GET' -H 'authorization: Bearer t0ken' 'https://example.com/'")
	})

	// v0: 0097495177
	it("excludeHeader leaves out the headers the caller names", async () => {
		const request = new Request("https://example.com", {
			headers: { authorization: "Bearer secret", "cf-ray": "abc123", "x-test": "ok" },
		})
		const command = await requestToCurl(request, {
			excludeHeader: (name) => name === "authorization" || name.startsWith("cf-"),
		})
		expect(command).toBe("curl -X 'GET' -H 'x-test: ok' 'https://example.com/'")
	})
})

describe("shellQuote(): one shell word", () => {
	// v0: 156500283e
	it("single quotes, an embedded quote closed and escaped", () => {
		expect([shellQuote("GET"), shellQuote("it's")]).toEqual(["'GET'", "'it'\\''s'"])
	})

	// v0: 8585d47c7c
	it("a control character switches to ANSI-C quoting, so a pasted command or a log line cannot be split", () => {
		expect([shellQuote("a\nb"), shellQuote("x\r\n\u001b[31m'\\"), shellQuote("del\u007f")]).toEqual([
			"$'a\\x0ab'",
			"$'x\\x0d\\x0a\\x1b[31m\\'\\\\'",
			"$'del\\x7f'",
		])
	})
})
