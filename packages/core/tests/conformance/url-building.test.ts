import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { HTTPClient } from "../../src/client/http.ts"

type Vector = {
	base: string
	error?: string
	expect?: string
	name: string
	params?: Record<string, string>
	path: string
	search?: Record<string, unknown>
}

const { vectors } = JSON.parse(readFileSync(new URL("./vectors/url-building.json", import.meta.url), "utf8")) as {
	vectors: Vector[]
}

describe("conformance: URL building (client/*)", () => {
	for (const v of vectors) {
		it(v.name, () => {
			const http = new HTTPClient({ baseURL: v.base })
			const build = () => http.buildUrl(v.path, { params: v.params, search: v.search })
			if (v.error !== undefined) expect(build).toThrow(v.error)
			else expect(build()).toBe(v.expect)
		})
	}
})
