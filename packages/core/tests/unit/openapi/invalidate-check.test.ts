import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { generateOpenApi } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"

const INFO = { title: "Test", version: "1.0" }

type Ctx = { res: { json: (k: "ok", v: unknown) => Response } }
const ok = (c: Ctx): Response => c.res.json("ok", {})

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => {})
	return () => warn.mockRestore()
})

function report(): string {
	return warn.mock.calls.map((c) => String(c[0])).join("\n")
}

describe("mutations with no invalidate", () => {
	it("warns by default, and never blocks", async () => {
		const app = honey<{}>()
		app.post("/tables").handler(ok)
		app.get("/tables").handler(ok)
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(spec.paths["/tables"]).toBeDefined()
		expect(warn).toHaveBeenCalledTimes(1)
		expect(report()).toMatch(/POST\s+\/tables → GET \/tables/)
	})

	it("reports once with a list, not once per operation", async () => {
		const app = honey<{}>()
		for (const n of ["a", "b", "c", "d"]) {
			app.post(`/${n}`).handler(ok)
			app.get(`/${n}`).handler(ok)
		}
		await generateOpenApi(app as never, { info: INFO })
		/* a warning that fires four times gets filtered out of a log; one that lists four gets read */
		expect(warn).toHaveBeenCalledTimes(1)
		expect(report()).toMatch(/4 mutation\(s\)/)
	})

	it("stays silent for a mutation with no read surface", async () => {
		const app = honey<{}>()
		app.post("/auth/logout").handler(ok)
		app.post("/webhooks/stripe").handler(ok)
		app.post("/track/pixel").handler(ok)
		await generateOpenApi(app as never, { info: INFO })
		expect(warn).not.toHaveBeenCalled()
	})

	it("sees an item mutation's collection, not just its own path", async () => {
		const app = honey<{}>()
		app.delete("/tables/:id").handler(ok)
		app.get("/tables").handler(ok)
		await generateOpenApi(app as never, { info: INFO })
		expect(report()).toMatch(/DELETE\s+\/tables\/\{id\} → GET \/tables/)
	})

	it("does not treat a one-segment path as having a collection parent", async () => {
		const app = honey<{}>()
		app.post("/:slug").handler(ok)
		app.get("/").handler(ok)
		await generateOpenApi(app as never, { info: INFO })
		expect(warn).not.toHaveBeenCalled()
	})

	it("stays silent once the mutation declares what it refreshes", async () => {
		const app = honey<{}>()
		app
			.post("/tables")
			.meta({ invalidate: ["GET /tables"] })
			.handler(ok)
		app.get("/tables").handler(ok)
		await generateOpenApi(app as never, { info: INFO })
		expect(warn).not.toHaveBeenCalled()
	})

	it("reads GET routes only as reads — a POST sibling is not a read surface", async () => {
		const app = honey<{}>()
		app.post("/tables").handler(ok)
		app.put("/tables").handler(ok)
		await generateOpenApi(app as never, { info: INFO })
		expect(warn).not.toHaveBeenCalled()
	})
})

describe("recording a deliberate nothing", () => {
	it("`invalidate: null` silences it and emits nothing", async () => {
		const app = honey<{}>()
		app.post("/sessions").meta({ invalidate: null }).handler(ok)
		app.get("/sessions").handler(ok)
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(warn).not.toHaveBeenCalled()
		/* the statement is for the author and this check — it must not reach the document,
		   where an SDK checks `Array.isArray(x-invalidate)` */
		expect(spec.paths["/sessions"]?.post).not.toHaveProperty("x-invalidate")
	})

	it("`invalidate: []` says the same thing", async () => {
		const app = honey<{}>()
		app.post("/sessions").meta({ invalidate: [] }).handler(ok)
		app.get("/sessions").handler(ok)
		await generateOpenApi(app as never, { info: INFO })
		expect(warn).not.toHaveBeenCalled()
	})

	it("absent is not the same as null — that distinction is the whole check", async () => {
		const app = honey<{}>()
		app.post("/sessions").handler(ok)
		app.get("/sessions").handler(ok)
		await generateOpenApi(app as never, { info: INFO })
		expect(warn).toHaveBeenCalledTimes(1)
	})
})

describe("levels", () => {
	it('"off" is silent', async () => {
		const app = honey<{}>()
		app.post("/tables").handler(ok)
		app.get("/tables").handler(ok)
		await generateOpenApi(app as never, { info: INFO, invalidate: "off" })
		expect(warn).not.toHaveBeenCalled()
	})

	it('"error" fails the build, for teams that opt in', async () => {
		const app = honey<{}>()
		app.post("/tables").handler(ok)
		app.get("/tables").handler(ok)
		await expect(generateOpenApi(app as never, { info: INFO, invalidate: "error" })).rejects.toThrow(
			/honey:invalidate.*1 mutation/s,
		)
	})

	it("a document served at runtime never warns", async () => {
		const app = honey<{}>()
		app.post("/tables").handler(ok)
		app.get("/tables").handler(ok)
		app.openapi({ title: "T", version: "1" })
		const res = await app.fetch(new Request("http://x/openapi.json"), {})
		expect(res.status).toBe(200)
		expect(warn).not.toHaveBeenCalled()
	})
})

describe("entity-based detection", () => {
	const stamped = (name: string) => z.object({ id: z.string() }).meta({ "x-comb": { kind: "entity", name, v: 1 } })

	function entityApp() {
		const app = honey<{}>()
		app.metaSpec({
			schema: {
				entityFacts: {
					expand: (e: { name: string }) => ({ "x-entity": e.name }),
					match: { kind: "entity" },
					read: "x-comb",
					search: "deep",
				},
			},
		})
		return app
	}

	it("finds a mutation whose entity is read under an unrelated path", async () => {
		const app = entityApp()
		app
			.post("/admin/provision-table")
			.output({ "application/json": { ok: stamped("table") } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		app
			.get("/v2/tables")
			.output({ "application/json": { ok: stamped("table") } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		await generateOpenApi(app as never, { info: INFO, invalidate: { entityKey: "x-entity" } })
		expect(report()).toMatch(/POST \/admin\/provision-table → GET \/v2\/tables/)
	})

	it("stays silent when nothing reads that entity", async () => {
		const app = entityApp()
		app
			.post("/admin/audit")
			.output({ "application/json": { ok: stamped("auditlog") } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		app
			.get("/v2/tables")
			.output({ "application/json": { ok: stamped("table") } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		await generateOpenApi(app as never, { info: INFO, invalidate: { entityKey: "x-entity" } })
		expect(warn).not.toHaveBeenCalled()
	})

	it("without entityKey the same app is judged on path shape alone", async () => {
		const app = entityApp()
		app
			.post("/admin/provision-table")
			.output({ "application/json": { ok: stamped("table") } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		app
			.get("/v2/tables")
			.output({ "application/json": { ok: stamped("table") } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		await generateOpenApi(app as never, { info: INFO })
		expect(warn).not.toHaveBeenCalled()
	})
})
