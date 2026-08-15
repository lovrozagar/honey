import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { generateGoCLI } from "../../../../src/codegen-go-cli.ts"

function loadFixture(name: string): Record<string, unknown> {
	const url = new URL(`../fixtures/go-cli/${name}.json`, import.meta.url)
	return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>
}

/* ── Tier 2: path params as named flags ── */

describe("go-cli codegen — Tier 2: path params", () => {
	const crudSpec = loadFixture("crud")
	const reservedSpec = loadFixture("go-reserved")

	it("[#9] /users/{id} → usersGetCmd registers a StringVar flag named \"id\"", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const users = result.files["cmd/users.go"]
		expect(users).toMatch(/usersGetCmd\.Flags\(\)\.StringVar\([^)]*"id"[^)]*\)/)
	})

	it("[#10] {id} flag is marked required on usersGetCmd", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const users = result.files["cmd/users.go"]
		expect(users).toContain(`usersGetCmd.MarkFlagRequired("id")`)
	})

	it("[#11] snake_case path param {project_id} → --project-id flag + projectID Go var", () => {
		const spec = {
			openapi: "3.1.0",
			info: { title: "T", version: "1.0.0" },
			paths: {
				"/projects/{project_id}": {
					get: {
						operationId: "projects.get",
						parameters: [
							{
								in: "path",
								name: "project_id",
								required: true,
								schema: { type: "string" },
							},
						],
						responses: { "200": { description: "OK" } },
					},
				},
			},
		}
		const result = generateGoCLI(spec, { binaryName: "acme" })
		const projects = result.files["cmd/projects.go"]
		expect(projects).toContain(`"project-id"`)
		expect(projects).toContain("projectID")
	})

	it("[#12] multi-param path /orgs/{org_id}/projects/{project_id}/tables/{table_id} → 3 required flags + url.PathEscape per segment", () => {
		const spec = {
			openapi: "3.1.0",
			info: { title: "T", version: "1.0.0" },
			paths: {
				"/orgs/{org_id}/projects/{project_id}/tables/{table_id}": {
					get: {
						operationId: "tables.get",
						parameters: [
							{ in: "path", name: "org_id", required: true, schema: { type: "string" } },
							{ in: "path", name: "project_id", required: true, schema: { type: "string" } },
							{ in: "path", name: "table_id", required: true, schema: { type: "string" } },
						],
						responses: { "200": { description: "OK" } },
					},
				},
			},
		}
		const result = generateGoCLI(spec, { binaryName: "acme" })
		const tables = result.files["cmd/tables.go"]
		expect(tables).toContain(`MarkFlagRequired("org-id")`)
		expect(tables).toContain(`MarkFlagRequired("project-id")`)
		expect(tables).toContain(`MarkFlagRequired("table-id")`)
		expect(tables).toContain("url.PathEscape(orgID)")
		expect(tables).toContain("url.PathEscape(projectID)")
		expect(tables).toContain("url.PathEscape(tableID)")
	})

	it("[#13] path/body field collision (both \"id\") → path flag wins, body prop becomes --body-id", () => {
		const spec = {
			openapi: "3.1.0",
			info: { title: "T", version: "1.0.0" },
			paths: {
				"/things/{id}": {
					put: {
						operationId: "things.replace",
						parameters: [
							{ in: "path", name: "id", required: true, schema: { type: "string" } },
						],
						requestBody: {
							required: true,
							content: {
								"application/json": {
									schema: {
										type: "object",
										required: ["id", "name"],
										properties: {
											id: { type: "string" },
											name: { type: "string" },
										},
									},
								},
							},
						},
						responses: { "200": { description: "OK" } },
					},
				},
			},
		}
		const result = generateGoCLI(spec, { binaryName: "acme" })
		const things = result.files["cmd/things.go"]
		expect(things).toContain(`"id"`)
		expect(things).toContain(`"body-id"`)
	})

	it("[#14] reserved Go keyword path param {type} → Go var type_, flag name stays --type", () => {
		const result = generateGoCLI(reservedSpec, { binaryName: "acme" })
		const file = result.files["cmd/goKeywords.go"] ?? result.files["cmd/go-keywords.go"]
		expect(file).toBeDefined()
		const src = file as string
		expect(src).toContain(`"type"`)
		expect(src).toMatch(/\btype_\b/)
	})
})
