import { describe, expect, it } from "vitest"
import { requestToCurl } from "../../../src/request-to-curl.ts"

describe("requestToCurl", () => {
	it("serializes a request into curl without consuming the original body", async () => {
		const request = new Request("https://example.com/api/users?active=true", {
			body: JSON.stringify({ name: "O'Reilly" }),
			headers: {
				"content-type": "application/json",
				"x-test": "it's-set",
			},
			method: "POST",
		})

		const curl = await requestToCurl(request)

		expect(curl).toBe(
			"curl -X POST -H 'content-type: application/json' -H 'x-test: it'\\''s-set' --data-raw '{\"name\":\"O'\\''Reilly\"}' 'https://example.com/api/users?active=true'",
		)
		expect(await request.text()).toBe("{\"name\":\"O'Reilly\"}")
	})

	it("supports caller-defined header filtering", async () => {
		const request = new Request("https://example.com", {
			headers: {
				authorization: "Bearer secret",
				"cf-ray": "abc123",
				"x-test": "ok",
			},
		})

		const curl = await requestToCurl(request, {
			excludeHeader: (name) => name === "authorization" || name.startsWith("cf-"),
		})

		expect(curl).toBe("curl -X GET -H 'x-test: ok' 'https://example.com/'")
	})
})
