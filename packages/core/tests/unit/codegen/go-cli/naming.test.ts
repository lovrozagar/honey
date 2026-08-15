import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { generateGoCLI } from "../../../../src/codegen-go-cli.ts"

function loadFixture(name: string): Record<string, unknown> {
	const url = new URL(`../fixtures/go-cli/${name}.json`, import.meta.url)
	return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>
}

/* ── Tier 8: naming (kebab-case, Go safe idents, dot-split depth cap) ── */

describe("go-cli codegen — Tier 8: naming", () => {
	it("[#48] camelCase resource apiKey → command name api-key", () => {
		const spec = {
			openapi: "3.1.0",
			info: { title: "T", version: "1.0.0" },
			paths: {
				"/keys": {
					get: {
						operationId: "apiKey.list",
						responses: { "200": { description: "OK" } },
					},
				},
			},
		}
		const result = generateGoCLI(spec, { binaryName: "acme" })
		const root = result.files["cmd/root.go"]
		expect(root).toMatch(/Use:\s*"api-key"|"api-key"/)
	})

	it("[#49] camelCase action listArticles → subcommand list-articles", () => {
		const spec = {
			openapi: "3.1.0",
			info: { title: "T", version: "1.0.0" },
			paths: {
				"/articles": {
					get: {
						operationId: "articles.listArticles",
						responses: { "200": { description: "OK" } },
					},
				},
			},
		}
		const result = generateGoCLI(spec, { binaryName: "acme" })
		const articles = result.files["cmd/articles.go"]
		expect(articles).toMatch(/Use:\s*"list-articles"/)
	})

	it("[#50] Go-keyword resource type → cmd Use stays \"type\", Go var is typeCmd-safe (type_Cmd)", () => {
		const reservedSpec = loadFixture("go-reserved")
		const result = generateGoCLI(reservedSpec, { binaryName: "acme" })
		const allSrc = Object.values(result.files).join("\n")
		expect(allSrc).toMatch(/Use:\s*"type"/)
	})

	it("[#51] dot-chained 3-segment extract.table.stream → cmd path `extract table-stream`", () => {
		const spec = {
			openapi: "3.1.0",
			info: { title: "T", version: "1.0.0" },
			paths: {
				"/extract/table/stream": {
					get: {
						operationId: "extract.table.stream",
						responses: { "200": { description: "OK" } },
					},
				},
			},
		}
		const result = generateGoCLI(spec, { binaryName: "acme" })
		const extract = result.files["cmd/extract.go"]
		expect(extract).toMatch(/Use:\s*"table-stream"/)
	})

	it("[#52] dot-chained 4-segment foo.a.b.c → cmd path `foo a-b-c`", () => {
		const nestedSpec = loadFixture("nested-resource")
		const result = generateGoCLI(nestedSpec, { binaryName: "acme" })
		const foo = result.files["cmd/foo.go"]
		expect(foo).toMatch(/Use:\s*"a-b-c"/)
	})

	it("[#53] collision check: two ops that would collapse to identical cmd path → generator throws naming both opIds", () => {
		const spec = {
			openapi: "3.1.0",
			info: { title: "T", version: "1.0.0" },
			paths: {
				"/foo/bar-baz": {
					get: {
						operationId: "foo.bar-baz",
						responses: { "200": { description: "OK" } },
					},
				},
				"/foo/bar/baz": {
					get: {
						operationId: "foo.bar.baz",
						responses: { "200": { description: "OK" } },
					},
				},
			},
		}
		expect(() => generateGoCLI(spec, { binaryName: "acme" })).toThrowError(
			/foo\.bar-baz.*foo\.bar\.baz|foo\.bar\.baz.*foo\.bar-baz/,
		)
	})

	it("[#54] snake_case action list_users → subcommand list-users", () => {
		const spec = {
			openapi: "3.1.0",
			info: { title: "T", version: "1.0.0" },
			paths: {
				"/users": {
					get: {
						operationId: "users.list_users",
						responses: { "200": { description: "OK" } },
					},
				},
			},
		}
		const result = generateGoCLI(spec, { binaryName: "acme" })
		const users = result.files["cmd/users.go"]
		expect(users).toMatch(/Use:\s*"list-users"/)
	})

	it("[#51] regression guard: extract.table.stream → cmd path `extract table-stream`", () => {
		/* T45: explicit re-run of existing #51 — must still pass after IR refactor */
		const spec = {
			info: { title: "T", version: "1.0.0" },
			openapi: "3.1.0",
			paths: {
				"/extract/table/stream": {
					get: {
						operationId: "extract.table.stream",
						responses: { "200": { description: "OK" } },
					},
				},
			},
		}
		const result = generateGoCLI(spec, { binaryName: "acme" })
		const extract = result.files["cmd/extract.go"]
		expect(extract).toMatch(/Use:\s*"table-stream"/)
	})

	it("[#52] regression guard: foo.a.b.c → cmd path `foo a-b-c`", () => {
		/* T46: explicit re-run of existing #52 — must still pass after IR refactor */
		const nestedSpec = loadFixture("nested-resource")
		const result = generateGoCLI(nestedSpec, { binaryName: "acme" })
		const foo = result.files["cmd/foo.go"]
		expect(foo).toMatch(/Use:\s*"a-b-c"/)
	})

	it("[#55] mixed depth CLI: users.list and users.profile.update produce list and profile-update subcommands", () => {
		/* T47: RED — IR-based parse must emit profile-update for 3-seg op */
		const spec = {
			info: { title: "T", version: "1.0.0" },
			openapi: "3.1.0",
			paths: {
				"/users": {
					get: {
						operationId: "users.list",
						responses: { "200": { description: "OK" } },
					},
				},
				"/users/profile": {
					patch: {
						operationId: "users.profile.update",
						responses: { "200": { description: "OK" } },
					},
				},
			},
		}
		const result = generateGoCLI(spec, { binaryName: "acme" })
		const users = result.files["cmd/users.go"]
		expect(users).toBeDefined()
		expect(users).toMatch(/Use:\s*"list"/)
		expect(users).toMatch(/Use:\s*"profile-update"/)
	})

	it("[#56] collision throws via IR validator with both opIds named", () => {
		/* T48: RED — IR validator not yet wired; currently no throw */
		const spec = {
			info: { title: "T", version: "1.0.0" },
			openapi: "3.1.0",
			paths: {
				"/users": {
					post: {
						operationId: "users.create",
						responses: { "200": { description: "OK" } },
					},
				},
				"/users/draft": {
					post: {
						operationId: "users.create.draft",
						responses: { "200": { description: "OK" } },
					},
				},
			},
		}
		expect(() => generateGoCLI(spec, { binaryName: "acme" })).toThrow(
			/operationId conflict.*users\.create.*users\.create\.draft|operationId conflict.*users\.create\.draft.*users\.create/,
		)
	})
})
