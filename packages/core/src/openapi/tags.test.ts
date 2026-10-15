import { describe, expect, it } from "vitest"
import { honey } from "../routing/app.ts"
import { SILENT, type Logger } from "../telemetry/logger.ts"
import { generateOpenApi } from "./generate.ts"

const INFO = { title: "T", version: "1" }

/** A logger that keeps each warning's message. */
function recording(): { logger: Logger; warnings: string[] } {
	const warnings: string[] = []
	const warn = (first: unknown, second?: unknown) =>
		void warnings.push(String(typeof first === "string" ? first : second))
	return { logger: { ...SILENT, warn }, warnings }
}

/** Routes tagged Users, then Orders and Users, then Admin, and one untagged. */
function tagged() {
	const app = honey<{}>()
	app
		.get("/users")
		.meta({ operationId: "listUsers", tags: "Users" })
		.handler((c) => c.res.text("ok", "ok"))
	app
		.get("/users/:id/orders")
		.meta({ operationId: "listUserOrders", tags: ["Orders", "Users"] })
		.handler((c) => c.res.text("ok", "ok"))
	app
		.post("/zz/admin")
		.meta({ tags: ["Admin"] })
		.handler((c) => c.res.text("ok", "ok"))
	app.get("/health").handler((c) => c.res.text("ok", "ok"))
	return app
}

describe("tags: the ones operations name, in the order they are first named", () => {
	it("lists each tag an operation names once, first-seen, and none for an untagged document", () => {
		const bare = honey<{}>()
		bare.get("/a").handler((c) => c.res.text("ok", "ok"))
		expect([generateOpenApi(tagged(), { info: INFO }).tags, generateOpenApi(bare, { info: INFO }).tags]).toEqual([
			[{ name: "Users" }, { name: "Orders" }, { name: "Admin" }],
			undefined,
		])
	})

	it("merges the declared metadata by name, never adds a tag no operation names, and warns of it", () => {
		const { logger, warnings } = recording()
		const doc = generateOpenApi(tagged(), {
			info: INFO,
			logger,
			tags: [
				{ description: "Admin only", name: "Admin", "x-displayName": "Administration" },
				{ name: "Billing" },
				{
					description: "People",
					externalDocs: { description: "Guide", url: "https://docs.example.com/users" },
					name: "Users",
				},
			],
		})
		expect([doc.tags, warnings]).toEqual([
			[
				{
					description: "People",
					externalDocs: { description: "Guide", url: "https://docs.example.com/users" },
					name: "Users",
				},
				{ name: "Orders" },
				{ description: "Admin only", name: "Admin", "x-displayName": "Administration" },
			],
			[expect.stringMatching(/\[honey:openapi\] UNUSED_TAG: tag "Billing" is declared but no operation names it/)],
		])
	})

	it("keeps each operation's tags and operationId as written: grouping is the operations' own", () => {
		const doc = generateOpenApi(tagged(), { info: INFO, tags: [{ description: "People", name: "Users" }] })
		const op = (path: string, method = "get") => doc.paths[path]?.[method] as Record<string, unknown>
		expect([
			[op("/users").tags, op("/users").operationId],
			[op("/users/{id}/orders").tags, op("/users/{id}/orders").operationId],
			op("/health").tags,
		]).toEqual([[["Users"], "listUsers"], [["Orders", "Users"], "listUserOrders"], undefined])
	})

	it("refuses a tag declared twice, and writes the document's own externalDocs last", () => {
		const twice = () =>
			generateOpenApi(tagged(), { info: INFO, tags: [{ name: "Users" }, { description: "again", name: "Users" }] })
		const doc = generateOpenApi(tagged(), {
			externalDocs: { url: "https://docs.example.com" },
			info: INFO,
		})
		expect(twice).toThrow(/INVALID_TAG.*tag "Users" is declared twice/s)
		expect([doc.externalDocs, Object.keys(doc).at(-1)]).toEqual([{ url: "https://docs.example.com" }, "externalDocs"])
	})
})
