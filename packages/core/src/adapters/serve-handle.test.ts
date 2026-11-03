import { describe, expect, it } from "vitest"
import { urlOf } from "./serve-handle.ts"

describe("urlOf: where a client on this machine reaches the server", () => {
	it.each([
		["0.0.0.0", "http://127.0.0.1:3000"],
		["::", "http://127.0.0.1:3000"],
		["::1", "http://[::1]:3000"],
		["127.0.0.1", "http://127.0.0.1:3000"],
		["app.internal", "http://app.internal:3000"],
	])("hostname %j is reached at %s", (hostname, url) => {
		expect(urlOf(hostname, 3000)).toBe(url)
	})
})
