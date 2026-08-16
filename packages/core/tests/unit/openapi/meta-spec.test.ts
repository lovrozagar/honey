import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { generateOpenApi, normalizeSecurity } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"

const INFO = { title: "Test", version: "1.0" }

type Op = Record<string, unknown>

function op(spec: Awaited<ReturnType<typeof generateOpenApi>>, path: string, method = "get"): Op {
	return spec.paths[path]?.[method] as Op
}

/* ---- byte-identical output for a no-policy app ---- */

describe("built-in policy (no metaSpec declared)", () => {
	/** The pre-policy mapping, reimplemented verbatim — the compatibility oracle. */
	function legacyOperation(meta: Record<string, unknown>): Op {
		const operation: Op = {}
		if (meta.summary) operation.summary = meta.summary
		if (meta.description) operation.description = meta.description
		if (meta.tags) operation.tags = typeof meta.tags === "string" ? [meta.tags] : meta.tags
		if (meta.deprecated) operation.deprecated = meta.deprecated
		if (meta.operationId) operation.operationId = meta.operationId
		if (meta.security) operation.security = normalizeSecurity(meta.security)
		const inv = meta.invalidate
		if (Array.isArray(inv) && inv.length > 0) operation["x-invalidate"] = inv
		if (meta.mcp === true) operation["x-mcp"] = true
		return operation
	}

	const metas: Record<string, unknown>[] = [
		{},
		{ summary: "s" },
		{ description: "d", summary: "s" },
		{ summary: "s", tags: "one" },
		{ tags: ["a", "b"] },
		{ deprecated: true, operationId: "opId", summary: "s" },
		{ security: "jwt" },
		{ security: [{ apiKey: ["read"] }] },
		{ invalidate: ["GET /users"] },
		{ invalidate: [] },
		{ mcp: false },
		{ mcp: true },
		{ internal: true, summary: "s" },
		{
			deprecated: true,
			description: "d",
			internal: true,
			invalidate: ["GET /a", "GET /b"],
			mcp: true,
			operationId: "op",
			security: ["jwt", "apiKey"],
			summary: "s",
			tags: ["x"],
		},
	]

	it("emits the same keys, values and key order as the pre-policy generator", async () => {
		for (const [i, meta] of metas.entries()) {
			const app = honey<{}>()
			app
				.get(`/r${i}`)
				.meta(meta as never)
				.handler((c) => c.res.json("ok", { ok: true }))
			const spec = await generateOpenApi(app as never, { info: INFO })
			const actual = { ...op(spec, `/r${i}`) }
			delete actual.responses
			expect(JSON.stringify(actual), `meta #${i}`).toBe(JSON.stringify(legacyOperation(meta)))
		}
	})

	it("keeps the WS mapping a strict subset (no deprecated/security/x-invalidate/x-mcp)", async () => {
		const app = honey<{}>()
		app
			.ws("/live")
			.meta({
				deprecated: true,
				description: "d",
				invalidate: ["GET /users"],
				mcp: true,
				operationId: "live",
				security: "jwt",
				summary: "s",
				tags: "sockets",
			} as never)
			.handler({ message: () => {} })
		const spec = await generateOpenApi(app as never, { info: INFO })
		const operation = op(spec, "/live")
		expect(Object.keys(operation)).toEqual([
			"x-websocket",
			"summary",
			"description",
			"tags",
			"operationId",
			"responses",
		])
	})

	it("does not enforce totality when no policy is declared", async () => {
		const app = honey<{}>()
		app
			.get("/a")
			.meta({ whateverInternalKey: "x" } as never)
			.handler((c) => c.res.json("ok", {}))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/a")).not.toHaveProperty("whateverInternalKey")
	})
})

/* ---- totality ---- */

type AppMeta = {
	permissions?: string[]
	rateLimit?: "ai" | "login"
	worker?: "extract" | "saas"
}

function totalityApp(strict: "error" | "off" | "warn" | undefined) {
	const app = honey<{}>().meta<AppMeta>()
	app.metaSpec({ meta: { permissions: "x-permissions" }, strict })
	app
		.get("/a")
		.meta({ permissions: ["read"], rateLimit: "ai" })
		.handler((c) => c.res.json("ok", {}))
	return app
}

describe("totality", () => {
	it("strict defaults to error once a policy is declared", async () => {
		await expect(generateOpenApi(totalityApp(undefined) as never, { info: INFO })).rejects.toThrow(/MISSING_ENTRY/)
	})

	it("names the unmapped key and the route, and suggests `false`", async () => {
		await expect(generateOpenApi(totalityApp("error") as never, { info: INFO })).rejects.toThrow(
			/meta key "rateLimit" \(first seen on GET \/a\).*`false`/s,
		)
	})

	it('strict: "warn" warns once and still generates', async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const spec = await generateOpenApi(totalityApp("warn") as never, { info: INFO })
		expect(op(spec, "/a")["x-permissions"]).toEqual(["read"])
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0][0]).toMatch(/MISSING_ENTRY.*rateLimit/)
		warn.mockRestore()
	})

	it('strict: "off" is silent', async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		await generateOpenApi(totalityApp("off") as never, { info: INFO })
		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})

	it("reports an unmapped key once, not once per route", async () => {
		const app = honey<{}>().meta<AppMeta>()
		app.metaSpec({ meta: {}, strict: "error" })
		for (const p of ["/a", "/b", "/c"]) {
			app
				.get(p)
				.meta({ worker: "saas" })
				.handler((c) => c.res.json("ok", {}))
		}
		const err = await generateOpenApi(app as never, { info: INFO }).catch((e: Error) => e)
		expect((err as Error).message).toMatch(/1 policy error/)
	})
})

/* ---- hiding ---- */

describe("hidden keys", () => {
	it("`false` keeps the key out of every profile", async () => {
		const app = honey<{}>().meta<{ captcha?: string; worker?: string }>()
		app.metaSpec({
			meta: { captcha: false, worker: false },
			profiles: { internal: {} },
		})
		app
			.get("/a")
			.meta({ captcha: "turnstile", worker: "saas" })
			.handler((c) => c.res.json("ok", {}))

		for (const profile of [undefined, "internal"]) {
			const spec = await generateOpenApi(app as never, { info: INFO, profile })
			const keys = JSON.stringify(op(spec, "/a"))
			expect(keys).not.toMatch(/turnstile|worker|captcha/)
		}
	})

	it("built-in `internal` stays hidden and does not trip totality", async () => {
		const app = honey<{}>()
		app.metaSpec({ meta: {}, strict: "error" })
		app
			.get("/a")
			.meta({ internal: true })
			.handler((c) => c.res.json("ok", {}))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/a")).not.toHaveProperty("internal")
	})
})

/* ---- entry forms ---- */

describe("entry forms", () => {
	it("verbatim, transformed, standard-field and conditional entries", async () => {
		const RPS = { ai: 1, login: 5 } as const
		const app = honey<{}>().meta<{
			blurb?: string
			permissions?: string[]
			rateLimit?: "ai" | "login"
		}>()
		app.metaSpec({
			meta: {
				blurb: { key: "summary" },
				permissions: "x-permissions",
				/* aliasing a standard field from another meta key requires hiding the built-in */
				summary: false,
				rateLimit: {
					key: "x-rate-limit",
					map: (v) => (v === "login" ? undefined : { category: v, rps: RPS[v] }),
				},
			},
		})
		app
			.get("/a")
			.meta({ blurb: "list things", permissions: ["read"], rateLimit: "ai" })
			.handler((c) => c.res.json("ok", {}))
		app
			.get("/b")
			.meta({ rateLimit: "login" })
			.handler((c) => c.res.json("ok", {}))

		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/a").summary).toBe("list things")
		expect(op(spec, "/a")["x-permissions"]).toEqual(["read"])
		expect(op(spec, "/a")["x-rate-limit"]).toEqual({ category: "ai", rps: 1 })
		/* map returned undefined → omitted, silently */
		expect(op(spec, "/b")).not.toHaveProperty("x-rate-limit")
	})

	it("`on` restricts an entry to http or ws operations", async () => {
		const app = honey<{}>().meta<{ tenant?: string }>()
		app.metaSpec({ meta: { tenant: { key: "x-tenant", on: "http" } } })
		app
			.get("/a")
			.meta({ tenant: "orgId" })
			.handler((c) => c.res.json("ok", {}))
		app
			.ws("/live")
			.meta({ tenant: "orgId" } as never)
			.handler({ message: () => {} })
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/a")["x-tenant"]).toBe("orgId")
		expect(op(spec, "/live")).not.toHaveProperty("x-tenant")
	})

	it('`on: "ws"` restricts an entry to websocket operations', async () => {
		const app = honey<{}>().meta<{ channel?: string }>()
		app.metaSpec({ meta: { channel: { key: "x-channel", on: "ws" } } })
		app
			.get("/a")
			.meta({ channel: "c" })
			.handler((c) => c.res.json("ok", {}))
		app
			.ws("/live")
			.meta({ channel: "c" } as never)
			.handler({ message: () => {} })
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/a")).not.toHaveProperty("x-channel")
		expect(op(spec, "/live")["x-channel"]).toBe("c")
	})

	it("an expand returning undefined contributes nothing", async () => {
		const app = honey<{}>().meta<{ entity?: string }>()
		app.metaSpec({ meta: { entity: { expand: (v) => (v === "skip" ? undefined : { "x-entity": v }) } } })
		app
			.get("/skip")
			.meta({ entity: "skip" })
			.handler((c) => c.res.json("ok", {}))
		app
			.get("/keep")
			.meta({ entity: "user" })
			.handler((c) => c.res.json("ok", {}))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/skip")).not.toHaveProperty("x-entity")
		expect(op(spec, "/keep")["x-entity"]).toBe("user")
	})

	it("an expand producing an invalid target key fails the build", async () => {
		const app = honey<{}>().meta<{ entity?: string }>()
		app.metaSpec({ meta: { entity: { expand: (v) => ({ notAnExtension: v }) } } })
		app
			.get("/a")
			.meta({ entity: "user" })
			.handler((c) => c.res.json("ok", {}))
		await expect(generateOpenApi(app as never, { info: INFO })).rejects.toThrow(/UNKNOWN_FIELD/)
	})

	it("two expand entries writing one key at the same rank fail the build", async () => {
		/* `expand` targets are only known once it runs, so this is caught per operation
		   rather than at compile time — same verdict either way */
		const app = honey<{}>().meta<{ a?: string; b?: string }>()
		app.metaSpec({
			meta: {
				a: { expand: (v) => ({ "x-dup": v }) },
				b: { expand: (v) => ({ "x-dup": v }) },
			},
		})
		app
			.get("/a")
			.meta({ a: "one", b: "two" })
			.handler((c) => c.res.json("ok", {}))
		await expect(generateOpenApi(app as never, { info: INFO })).rejects.toThrow(/DUPLICATE_TARGET/)
	})

	it("meta.extensions passes through verbatim and outranks policy entries", async () => {
		const app = honey<{}>().meta<{ tenant?: string }>()
		app.metaSpec({ meta: { tenant: "x-tenant" } })
		app
			.get("/a")
			.meta({ extensions: { "x-tenant": "override", "x-vendor-new": 1 }, tenant: "orgId" })
			.handler((c) => c.res.json("ok", {}))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/a")["x-tenant"]).toBe("override")
		expect(op(spec, "/a")["x-vendor-new"]).toBe(1)
	})
})

describe("meta.extensions guards", () => {
	it("rejects a non-extension key", async () => {
		const app = honey<{}>()
		app.metaSpec({ meta: {} })
		app
			.get("/a")
			.meta({ extensions: { summary: "sneaky" } as never })
			.handler((c) => c.res.json("ok", {}))
		await expect(generateOpenApi(app as never, { info: INFO })).rejects.toThrow(/UNKNOWN_FIELD/)
	})

	it("skips undefined values", async () => {
		const app = honey<{}>()
		app.metaSpec({ meta: {} })
		app
			.get("/a")
			.meta({ extensions: { "x-gone": undefined, "x-kept": 1 } })
			.handler((c) => c.res.json("ok", {}))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/a")["x-kept"]).toBe(1)
		expect(op(spec, "/a")).not.toHaveProperty("x-gone")
	})

	it("ignores a non-object extensions value rather than throwing", async () => {
		const app = honey<{}>()
		app.metaSpec({ meta: {} })
		app
			.get("/a")
			.meta({ extensions: ["x-nope"] as never })
			.handler((c) => c.res.json("ok", {}))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(Object.keys(op(spec, "/a"))).toEqual(["responses"])
	})
})

/* ---- profiles ---- */

describe("profiles", () => {
	function profileApp() {
		const app = honey<{}>().meta<{ permissions?: string[]; tenant?: string }>()
		app.metaSpec({
			meta: { permissions: "x-permissions", tenant: "x-tenant" },
			profiles: {
				partner: { include: ["x-tenant"] },
				public: { exclude: ["x-invalidate", "x-tenant"] },
			},
		})
		app
			.get("/a")
			.meta({ invalidate: ["GET /a"], permissions: ["read"], summary: "s", tenant: "orgId" })
			.handler((c) => c.res.json("ok", {}))
		return app
	}

	it("the default profile filters nothing", async () => {
		const spec = await generateOpenApi(profileApp() as never, { info: INFO })
		const o = op(spec, "/a")
		expect(o["x-tenant"]).toBe("orgId")
		expect(o["x-permissions"]).toEqual(["read"])
		expect(o["x-invalidate"]).toEqual(["GET /a"])
	})

	it("exclude drops the listed keys and keeps the rest", async () => {
		const spec = await generateOpenApi(profileApp() as never, { info: INFO, profile: "public" })
		const o = op(spec, "/a")
		expect(o).not.toHaveProperty("x-tenant")
		expect(o).not.toHaveProperty("x-invalidate")
		expect(o["x-permissions"]).toEqual(["read"])
		expect(o.summary).toBe("s")
	})

	it("include allowlists x- keys and leaves standard fields alone", async () => {
		const spec = await generateOpenApi(profileApp() as never, { info: INFO, profile: "partner" })
		const o = op(spec, "/a")
		expect(o["x-tenant"]).toBe("orgId")
		expect(o).not.toHaveProperty("x-permissions")
		expect(o).not.toHaveProperty("x-invalidate")
		expect(o.summary).toBe("s")
	})

	it("two documents from one app differ only by profile", async () => {
		const app = profileApp()
		const internal = await generateOpenApi(app as never, { info: INFO })
		const publicDoc = await generateOpenApi(app as never, { info: INFO, profile: "public" })
		expect(Object.keys(op(internal, "/a"))).toContain("x-tenant")
		expect(Object.keys(op(publicDoc, "/a"))).not.toContain("x-tenant")
	})

	it("an allowlist profile does not leak a tag added later", async () => {
		/* `include` is default-deny: a policy entry added tomorrow is absent from this
		   document until someone adds it to the allowlist on purpose */
		const app = honey<{}>().meta<{ addedLater?: string; tenant?: string }>()
		app.metaSpec({
			meta: { addedLater: "x-added-later", tenant: "x-tenant" },
			profiles: { public: { include: ["x-tenant"] } },
		})
		app
			.get("/a")
			.meta({ addedLater: "oops", extensions: { "x-raw": 1 }, tenant: "orgId" })
			.handler((c) => c.res.json("ok", {}))
		const spec = await generateOpenApi(app as never, { info: INFO, profile: "public" })
		const o = op(spec, "/a")
		expect(o["x-tenant"]).toBe("orgId")
		expect(o).not.toHaveProperty("x-added-later")
		/* the escape hatch is filtered by the same allowlist */
		expect(o).not.toHaveProperty("x-raw")
	})

	it("with both, include applies first and exclude still subtracts", async () => {
		const app = honey<{}>().meta<{ cost?: string; permissions?: string[]; tenant?: string }>()
		app.metaSpec({
			meta: { cost: "x-cost", permissions: "x-permissions", tenant: "x-tenant" },
			profiles: { mixed: { exclude: ["x-cost"], include: ["x-tenant", "x-cost"] } },
		})
		app
			.get("/a")
			.meta({ cost: "low", permissions: ["r"], tenant: "orgId" })
			.handler((c) => c.res.json("ok", {}))
		const spec = await generateOpenApi(app as never, { info: INFO, profile: "mixed" })
		const o = op(spec, "/a")
		expect(o["x-tenant"]).toBe("orgId")
		/* not in include */
		expect(o).not.toHaveProperty("x-permissions")
		/* in include, but exclude wins */
		expect(o).not.toHaveProperty("x-cost")
	})

	it("an undeclared profile fails the build", async () => {
		await expect(generateOpenApi(profileApp() as never, { info: INFO, profile: "typo" })).rejects.toThrow(
			/UNKNOWN_PROFILE/,
		)
	})

	it("entry-level profiles restrict an entry to named documents", async () => {
		const app = honey<{}>().meta<{ tenant?: string }>()
		app.metaSpec({
			meta: { tenant: { key: "x-tenant", profiles: ["internal"] } },
			profiles: { internal: {}, public: {} },
		})
		app
			.get("/a")
			.meta({ tenant: "orgId" })
			.handler((c) => c.res.json("ok", {}))
		const internal = await generateOpenApi(app as never, { info: INFO, profile: "internal" })
		const publicDoc = await generateOpenApi(app as never, { info: INFO, profile: "public" })
		expect(op(internal, "/a")["x-tenant"]).toBe("orgId")
		expect(op(publicDoc, "/a")).not.toHaveProperty("x-tenant")
	})
})

/* ---- schema-derived ---- */

describe("schema-derived entries", () => {
	const User = z
		.object({ id: z.string(), name: z.string() })
		.meta({ entity: { autogenerate: ["id"], deletedAt: true, name: "user", nomutate: ["id"] } })

	const ListQuery = z
		.object({ limit: z.number().optional() })
		.meta({ query: { filter: ["name"], pagination: { defaultLimit: 20, maxLimit: 100 }, sort: ["name"] } })

	function entityApp() {
		const app = honey<{}>()
		app.metaSpec({
			schema: {
				entity: {
					expand: (e: { autogenerate?: string[]; deletedAt?: boolean; name: string; nomutate?: string[] }) => ({
						"x-entity": e.name,
						"x-generated": e.autogenerate,
						"x-immutable": e.nomutate,
						"x-soft-delete": e.deletedAt ? { field: "deletedAt" } : undefined,
					}),
					from: ["output"],
				},
				query: { from: ["input.search"], key: "x-query" },
			},
		})
		app
			.get("/users")
			.input({ search: ListQuery })
			.output({ "application/json": { ok: User } })
			.handler((c) => c.res.json("ok", { id: "1", name: "a" }))
		app.get("/health").handler((c) => c.res.json("ok", {}))
		return app
	}

	it("one schema key fans out to several extensions", async () => {
		const spec = await generateOpenApi(entityApp() as never, { info: INFO })
		const o = op(spec, "/users")
		expect(o["x-entity"]).toBe("user")
		expect(o["x-generated"]).toEqual(["id"])
		expect(o["x-immutable"]).toEqual(["id"])
		expect(o["x-soft-delete"]).toEqual({ field: "deletedAt" })
	})

	it("reads a different key off the search schema", async () => {
		const spec = await generateOpenApi(entityApp() as never, { info: INFO })
		expect((op(spec, "/users")["x-query"] as Record<string, unknown>).sort).toEqual(["name"])
	})

	it("with no `from`, sources are searched in order and the first hit wins", async () => {
		const Out = z.object({ id: z.string() }).meta({ owner: "from-output" })
		const Search = z.object({ q: z.string().optional() }).meta({ owner: "from-search" })
		const app = honey<{}>()
		app.metaSpec({ schema: { owner: "x-owner" } })
		/* output is searched before input.search */
		app
			.get("/both")
			.input({ search: Search })
			.output({ "application/json": { ok: Out } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		/* falls through to input.search when the output does not carry it */
		app
			.get("/search-only")
			.input({ search: Search })
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/both")["x-owner"]).toBe("from-output")
		expect(op(spec, "/search-only")["x-owner"]).toBe("from-search")
	})

	it("routes without the schema key are untouched", async () => {
		const spec = await generateOpenApi(entityApp() as never, { info: INFO })
		expect(Object.keys(op(spec, "/health"))).toEqual(["responses"])
	})

	it("reads through one level of `items` for a list output", async () => {
		const app = honey<{}>()
		app.metaSpec({ schema: { entity: { from: ["output"], key: "x-entity" } } })
		app
			.get("/users")
			.output({ "application/json": { ok: z.array(User) } })
			.handler((c) => c.res.json("ok", []))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/users")["x-entity"]).toEqual({
			autogenerate: ["id"],
			deletedAt: true,
			name: "user",
			nomutate: ["id"],
		})
	})

	it("an array-level key wins over the same key on the item", async () => {
		const Wrapped = z.array(z.object({ id: z.string() }).meta({ entity: "item" })).meta({ entity: "list" })
		const app = honey<{}>()
		app.metaSpec({ schema: { entity: { from: ["output"], key: "x-entity" } } })
		app
			.get("/users")
			.output({ "application/json": { ok: Wrapped } })
			.handler((c) => c.res.json("ok", []))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/users")["x-entity"]).toBe("list")
	})

	it('search: "deep" finds a descriptor inside a pagination envelope', async () => {
		const Envelope = z.object({
			articles: z.array(User),
			count: z.number(),
			hasMore: z.boolean(),
			nextCursor: z.string().nullable(),
		})
		const app = honey<{}>()
		app.metaSpec({ schema: { entity: { from: ["output"], key: "x-entity", search: "deep" } } })
		app
			.get("/articles")
			.output({ "application/json": { ok: Envelope } })
			.handler((c) => c.res.json("ok", {} as never))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect((op(spec, "/articles")["x-entity"] as Record<string, unknown>).name).toBe("user")
	})

	it('search: "root" (the default) does not reach into an envelope', async () => {
		const Envelope = z.object({ articles: z.array(User), count: z.number() })
		const app = honey<{}>()
		app.metaSpec({ schema: { entity: { from: ["output"], key: "x-entity" } } })
		app
			.get("/articles")
			.output({ "application/json": { ok: Envelope } })
			.handler((c) => c.res.json("ok", {} as never))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/articles")).not.toHaveProperty("x-entity")
	})

	it("a deep search prefers the shallowest match", async () => {
		const Inner = z.object({ id: z.string() }).meta({ entity: "inner" })
		const Outer = z.object({ nested: z.object({ deep: Inner }) }).meta({ entity: "outer" })
		const app = honey<{}>()
		app.metaSpec({ schema: { entity: { from: ["output"], key: "x-entity", search: "deep" } } })
		app
			.get("/a")
			.output({ "application/json": { ok: Outer } })
			.handler((c) => c.res.json("ok", {} as never))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/a")["x-entity"]).toBe("outer")
	})

	it("two different descriptors at the same depth fail the build rather than guess", async () => {
		const A = z.object({ id: z.string() }).meta({ entity: "article" })
		const B = z.object({ id: z.string() }).meta({ entity: "author" })
		const app = honey<{}>()
		app.metaSpec({ schema: { entity: { from: ["output"], key: "x-entity", search: "deep" } } })
		app
			.get("/a")
			.output({ "application/json": { ok: z.object({ articles: A, authors: B }) } })
			.handler((c) => c.res.json("ok", {} as never))
		await expect(generateOpenApi(app as never, { info: INFO })).rejects.toThrow(/AMBIGUOUS_SCHEMA_KEY/)
	})

	it("the same descriptor reached twice at one depth is not ambiguous", async () => {
		const app = honey<{}>()
		app.metaSpec({ schema: { entity: { from: ["output"], key: "x-entity", search: "deep" } } })
		app
			.get("/a")
			.output({ "application/json": { ok: z.object({ current: User, previous: User }) } })
			.handler((c) => c.res.json("ok", {} as never))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect((op(spec, "/a")["x-entity"] as Record<string, unknown>).name).toBe("user")
	})

	it("distinguishes `undefined` (unknown → omit) from `null` (explicitly nothing → emit)", async () => {
		/* Load-bearing for publishers that cannot know a fact: a stamp of `null` reaches the
		   document as `null`, which tells a consumer "nothing", not "I don't know". A publisher
		   that means "unknown" must omit the key, or the policy must map it to `undefined`. */
		const Stamped = z.object({ id: z.string() }).meta({ entity: { searchable: null, table: "article" } })
		const app = honey<{}>()
		app.metaSpec({
			schema: {
				entity: {
					expand: (e: { searchable: string[] | null; table: string }) => ({
						"x-entity": e.table,
						/* passed through — a deliberate "nothing" */
						"x-searchable-raw": e.searchable,
						/* normalized — "unknown", so the key never appears */
						"x-searchable-omitted": e.searchable ?? undefined,
					}),
					from: ["output"],
				},
			},
		})
		app
			.get("/articles")
			.output({ "application/json": { ok: Stamped } })
			.handler((c) => c.res.json("ok", {} as never))
		const spec = await generateOpenApi(app as never, { info: INFO })
		const o = op(spec, "/articles")
		expect(o).toHaveProperty("x-searchable-raw", null)
		expect(o).not.toHaveProperty("x-searchable-omitted")
	})

	it("a schema-derived null is filled by route meta, not fought by it", async () => {
		/* the publisher stamps `null` for a fact only the routing layer knows; the route-meta
		   entry sits at a higher rank, so it fills the gap wherever it is present */
		const Stamped = z.object({ id: z.string() }).meta({ entity: { table: "article", tenantColumn: null } })
		const app = honey<{}>().meta<{ tenant?: string }>()
		app.metaSpec({
			meta: { tenant: { key: "x-tenant", map: (v) => ({ column: v }) } },
			schema: {
				entity: {
					expand: (e: { table: string; tenantColumn: string | null }) => ({
						"x-entity": e.table,
						"x-tenant": e.tenantColumn ? { column: e.tenantColumn } : undefined,
					}),
					from: ["output"],
				},
			},
		})
		app
			.get("/known")
			.meta({ tenant: "project_id" })
			.output({ "application/json": { ok: Stamped } })
			.handler((c) => c.res.json("ok", {} as never))
		app
			.get("/unknown")
			.output({ "application/json": { ok: Stamped } })
			.handler((c) => c.res.json("ok", {} as never))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/known")["x-tenant"]).toEqual({ column: "project_id" })
		/* nothing known and nothing stamped → the key is absent, never `null` */
		expect(op(spec, "/unknown")).not.toHaveProperty("x-tenant")
	})

	it("an expand key returning undefined is omitted", async () => {
		const Plain = z.object({ id: z.string() }).meta({ entity: { name: "token" } })
		const app = honey<{}>()
		app.metaSpec({
			schema: {
				entity: {
					expand: (e: { deletedAt?: boolean; name: string }) => ({
						"x-entity": e.name,
						"x-soft-delete": e.deletedAt ? { field: "deletedAt" } : undefined,
					}),
					from: ["output"],
				},
			},
		})
		app
			.get("/tokens")
			.output({ "application/json": { ok: Plain } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/tokens")["x-entity"]).toBe("token")
		expect(op(spec, "/tokens")).not.toHaveProperty("x-soft-delete")
	})
})

/* ---- one reserved key carrying a union (the shape comb publishes) ---- */

describe("several entries reading one reserved key", () => {
	/* comb stamps `x-comb` with a discriminated union: the entity descriptor on the read
	   schema, the query descriptor on the list-query schema. Both must reach one operation. */
	const entityStamp = {
		generated: ["id", "created_at"],
		identity: "id",
		immutable: ["id"],
		kind: "entity",
		name: "article",
		softDelete: "deleted_at",
		tenantColumn: null,
		v: 1,
	}
	const queryStamp = {
		defaultOrder: "created_at.desc",
		filterable: ["title"],
		grammar: "postgrest",
		kind: "query",
		maxLimit: 100,
		searchable: null,
		selectable: ["id", "title"],
		sortable: ["title"],
		stableTiebreak: "id",
		v: 1,
	}

	const Article = z.object({ id: z.string(), title: z.string() }).meta({ "x-comb": entityStamp })
	const Envelope = z.object({
		articles: z.array(Article),
		count: z.number(),
		hasMore: z.boolean(),
		nextCursor: z.string().nullable(),
	})
	const ListQuery = z.object({ cursor: z.string().optional() }).meta({ "x-comb": queryStamp })

	function combApp() {
		const app = honey<{}>()
		app.metaSpec({
			schema: {
				entityFacts: {
					expand: (e: typeof entityStamp) => ({
						"x-entity": e.name,
						"x-generated": e.generated,
						"x-identity": e.identity,
						"x-immutable": e.immutable,
						"x-soft-delete": e.softDelete ?? undefined,
						"x-tenant": e.tenantColumn ?? undefined,
					}),
					from: ["output"],
					match: { kind: "entity" },
					read: "x-comb",
					search: "deep",
					version: { max: 1 },
				},
				queryFacts: {
					expand: (q: typeof queryStamp) => ({
						"x-query": { filter: q.filterable, maxLimit: q.maxLimit, sort: q.sortable },
						"x-searchable": q.searchable ?? undefined,
					}),
					from: ["input.search"],
					match: { kind: "query" },
					read: "x-comb",
					version: { max: 1 },
				},
			},
		})
		app
			.get("/articles")
			.input({ search: ListQuery })
			.output({ "application/json": { ok: Envelope } })
			.handler((c) => c.res.json("ok", {} as never))
		return app
	}

	it("both descriptors reach one operation from one key on different sources", async () => {
		const spec = await generateOpenApi(combApp() as never, { info: INFO })
		const o = op(spec, "/articles")
		expect(o["x-entity"]).toBe("article")
		expect(o["x-identity"]).toBe("id")
		expect(o["x-generated"]).toEqual(["id", "created_at"])
		expect(o["x-soft-delete"]).toBe("deleted_at")
		expect(o["x-query"]).toEqual({ filter: ["title"], maxLimit: 100, sort: ["title"] })
	})

	it("a null the publisher could not determine becomes an absent key, never a null tag", async () => {
		const spec = await generateOpenApi(combApp() as never, { info: INFO })
		const o = op(spec, "/articles")
		expect(o).not.toHaveProperty("x-tenant")
		expect(o).not.toHaveProperty("x-searchable")
	})

	it("an entry skips past a descriptor of the other kind rather than claiming it", async () => {
		/* both entries search every source; each must walk past the other's descriptor */
		const app = honey<{}>()
		app.metaSpec({
			schema: {
				entityFacts: {
					expand: (e: { name: string }) => ({ "x-entity": e.name }),
					match: { kind: "entity" },
					read: "x-comb",
					search: "deep",
				},
				queryFacts: {
					expand: (q: { maxLimit: number }) => ({ "x-max-limit": q.maxLimit }),
					match: { kind: "query" },
					read: "x-comb",
					search: "deep",
				},
			},
		})
		app
			.get("/articles")
			.input({ search: ListQuery })
			.output({ "application/json": { ok: Envelope } })
			.handler((c) => c.res.json("ok", {} as never))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/articles")["x-entity"]).toBe("article")
		expect(op(spec, "/articles")["x-max-limit"]).toBe(100)
	})

	it("a descriptor no entry claims fails the build", async () => {
		const app = honey<{}>()
		app.metaSpec({
			schema: {
				entityFacts: {
					expand: (e: { name: string }) => ({ "x-entity": e.name }),
					from: ["output"],
					match: { kind: "entity" },
					read: "x-comb",
				},
			},
		})
		app
			.get("/a")
			.output({ "application/json": { ok: z.object({ id: z.string() }).meta({ "x-comb": queryStamp }) } })
			.handler((c) => c.res.json("ok", {} as never))
		await expect(generateOpenApi(app as never, { info: INFO })).rejects.toThrow(/DESCRIPTOR_MISMATCH/)
	})

	it("a descriptor from a newer contract fails rather than emitting half a tag", async () => {
		const app = honey<{}>()
		app.metaSpec({
			schema: {
				entityFacts: {
					expand: (e: { name: string }) => ({ "x-entity": e.name }),
					from: ["output"],
					match: { kind: "entity" },
					read: "x-comb",
					version: { max: 1 },
				},
			},
		})
		app
			.get("/a")
			.output({
				"application/json": { ok: z.object({ id: z.string() }).meta({ "x-comb": { ...entityStamp, v: 2 } }) },
			})
			.handler((c) => c.res.json("ok", {} as never))
		await expect(generateOpenApi(app as never, { info: INFO })).rejects.toThrow(/UNSUPPORTED_VERSION.*v2.*up to v1/s)
	})

	it("a descriptor with no version field fails when a version guard is declared", async () => {
		const app = honey<{}>()
		app.metaSpec({
			schema: {
				entityFacts: {
					expand: (e: { name: string }) => ({ "x-entity": e.name }),
					from: ["output"],
					read: "x-comb",
					version: { max: 1 },
				},
			},
		})
		app
			.get("/a")
			.output({
				"application/json": { ok: z.object({ id: z.string() }).meta({ "x-comb": { kind: "entity", name: "a" } }) },
			})
			.handler((c) => c.res.json("ok", {} as never))
		await expect(generateOpenApi(app as never, { info: INFO })).rejects.toThrow(/UNSUPPORTED_VERSION.*no integer/s)
	})

	it("a custom version field name is honored", async () => {
		const app = honey<{}>()
		app.metaSpec({
			schema: {
				facts: {
					expand: (e: { name: string }) => ({ "x-entity": e.name }),
					from: ["output"],
					read: "x-vendor",
					version: { field: "contract", max: 3 },
				},
			},
		})
		app
			.get("/a")
			.output({
				"application/json": { ok: z.object({ id: z.string() }).meta({ "x-vendor": { contract: 4, name: "a" } }) },
			})
			.handler((c) => c.res.json("ok", {} as never))
		await expect(generateOpenApi(app as never, { info: INFO })).rejects.toThrow(/UNSUPPORTED_VERSION.*v4.*up to v3/s)
	})

	it("`read` defaults to the entry name, so existing policies are unaffected", async () => {
		const app = honey<{}>()
		app.metaSpec({ schema: { entity: { from: ["output"], key: "x-entity" } } })
		app
			.get("/a")
			.output({ "application/json": { ok: z.object({ id: z.string() }).meta({ entity: "user" }) } })
			.handler((c) => c.res.json("ok", {} as never))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/a")["x-entity"]).toBe("user")
	})
})

/* ---- precedence ---- */

describe("precedence", () => {
	it("route meta beats schema-derived beats built-in", async () => {
		const User = z.object({ id: z.string() }).meta({ entity: "user-from-schema", note: "schema-note" })
		const app = honey<{}>().meta<{ entity?: string }>()
		app.metaSpec({
			meta: { entity: "x-entity" },
			schema: {
				entity: { from: ["output"], key: "x-entity" },
				note: { from: ["output"], key: "summary" },
			},
		})
		app
			.get("/a")
			.meta({ entity: "user-from-meta", summary: "meta-summary" })
			.output({ "application/json": { ok: User } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		app
			.get("/b")
			.output({ "application/json": { ok: User } })
			.handler((c) => c.res.json("ok", { id: "1" }))

		const spec = await generateOpenApi(app as never, { info: INFO })
		/* route meta wins over the schema */
		expect(op(spec, "/a")["x-entity"]).toBe("user-from-meta")
		/* built-in `summary` is route meta too, so it beats the schema-derived entry */
		expect(op(spec, "/a").summary).toBe("meta-summary")
		/* with no route meta, the schema supplies both */
		expect(op(spec, "/b")["x-entity"]).toBe("user-from-schema")
		expect(op(spec, "/b").summary).toBe("schema-note")
	})

	it("raising precedence does not reorder the emitted keys", async () => {
		const User = z.object({ id: z.string() }).meta({ entity: "e" })
		const app = honey<{}>().meta<{ entity?: string }>()
		app.metaSpec({
			meta: { entity: "x-entity" },
			schema: { entity: { from: ["output"], key: "x-entity" } },
		})
		app
			.get("/a")
			.meta({ entity: "from-meta", summary: "s" })
			.output({ "application/json": { ok: User } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(Object.keys(op(spec, "/a"))).toEqual(["summary", "x-entity", "responses"])
	})

	it("an app entry replaces the built-in for the same meta key", async () => {
		const app = honey<{}>()
		app.metaSpec({ meta: { summary: { key: "summary", map: (v) => `[api] ${String(v)}` } } })
		app
			.get("/a")
			.meta({ summary: "list" })
			.handler((c) => c.res.json("ok", {}))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/a").summary).toBe("[api] list")
	})
})

/* ---- validation of emitted values ---- */

describe("emitted-value validation", () => {
	function validatedApp(rps: unknown) {
		const app = honey<{}>().meta<{ rateLimit?: string }>()
		app.metaSpec({
			meta: {
				rateLimit: {
					key: "x-rate-limit",
					map: (v) => ({ category: v, rps }),
					schema: z.object({ category: z.string(), rps: z.number().int().positive() }),
				},
			},
		})
		app
			.get("/a")
			.meta({ rateLimit: "ai" })
			.handler((c) => c.res.json("ok", {}))
		return app
	}

	it("a valid value is emitted", async () => {
		const spec = await generateOpenApi(validatedApp(3) as never, { info: INFO })
		expect(op(spec, "/a")["x-rate-limit"]).toEqual({ category: "ai", rps: 3 })
	})

	it("an async output schema fails the build — codegen validation is synchronous", async () => {
		/* a Standard Schema whose validate() returns a Promise; honey resolves values
		   synchronously, so it refuses rather than emitting an unvalidated tag */
		const asyncSchema = {
			"~standard": {
				validate: () => Promise.resolve({ value: undefined }),
				vendor: "test",
				version: 1,
			},
		}
		const app = honey<{}>().meta<{ rateLimit?: string }>()
		app.metaSpec({
			meta: { rateLimit: { key: "x-rate-limit", schema: asyncSchema as never } },
		})
		app
			.get("/a")
			.meta({ rateLimit: "ai" })
			.handler((c) => c.res.json("ok", {}))
		await expect(generateOpenApi(app as never, { info: INFO })).rejects.toThrow(/ASYNC_VALIDATION/)
	})

	it("validates the whole record for an expand entry, not one key", async () => {
		const app = honey<{}>()
		app.metaSpec({
			schema: {
				entity: {
					expand: (e: { name: string }) => ({ "x-a": e.name, "x-b": 1 }),
					from: ["output"],
					schema: z.object({ "x-a": z.string(), "x-b": z.string() }),
				},
			},
		})
		app
			.get("/a")
			.output({ "application/json": { ok: z.object({ id: z.string() }).meta({ entity: { name: "u" } }) } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		await expect(generateOpenApi(app as never, { info: INFO })).rejects.toThrow(/INVALID_VALUE/)
	})

	it("a malformed value fails the build instead of shipping", async () => {
		await expect(generateOpenApi(validatedApp("three") as never, { info: INFO })).rejects.toThrow(/INVALID_VALUE/)
	})
})

/* ---- error taxonomy ---- */

describe("policy errors", () => {
	async function generateWith(spec: Parameters<ReturnType<typeof honey<{}>>["metaSpec"]>[0]): Promise<unknown> {
		const app = honey<{}>()
		app.metaSpec(spec)
		app
			.get("/a")
			.meta({ summary: "s" })
			.handler((c) => c.res.json("ok", {}))
		return generateOpenApi(app as never, { info: INFO })
	}

	it("rejects a reserved operation field", async () => {
		await expect(generateWith({ meta: { thing: "responses" } })).rejects.toThrow(/RESERVED_FIELD/)
	})

	it("rejects a field that is neither x- nor a standard field", async () => {
		await expect(generateWith({ meta: { thing: "notAField" } })).rejects.toThrow(/UNKNOWN_FIELD/)
	})

	it("rejects two same-rank entries writing one key", async () => {
		await expect(generateWith({ meta: { a: "x-dup", b: "x-dup" } })).rejects.toThrow(/DUPLICATE_TARGET/)
	})

	it("reports a throwing map instead of emitting a half-built operation", async () => {
		const app = honey<{}>()
		app.metaSpec({
			meta: {
				summary: {
					key: "summary",
					map: () => {
						throw new Error("boom")
					},
				},
			},
		})
		app
			.get("/a")
			.meta({ summary: "s" })
			.handler((c) => c.res.json("ok", {}))
		await expect(generateOpenApi(app as never, { info: INFO })).rejects.toThrow(/MAP_THREW.*boom/s)
	})

	it("collapses one policy mistake repeated across many routes into a single error", async () => {
		const app = honey<{}>().meta<{ entity?: string }>()
		app.metaSpec({ meta: { entity: { expand: (v) => ({ notAnExtension: v }) } } })
		for (const p of ["/a", "/b", "/c", "/d"]) {
			app
				.get(p)
				.meta({ entity: "user" })
				.handler((c) => c.res.json("ok", {}))
		}
		const err = (await generateOpenApi(app as never, { info: INFO }).catch((e: Error) => e)) as Error
		expect(err.message).toMatch(/^\[honey:metaSpec\] 1 policy error/)
	})

	it("truncates a large error list rather than printing hundreds of lines", async () => {
		const app = honey<{}>()
		const meta: Record<string, unknown> = {}
		const routeMeta: Record<string, unknown> = {}
		for (let i = 0; i < 25; i++) {
			meta[`k${i}`] = "notAField"
			routeMeta[`k${i}`] = "v"
		}
		app.metaSpec({ meta })
		app
			.get("/a")
			.meta(routeMeta as never)
			.handler((c) => c.res.json("ok", {}))
		const err = (await generateOpenApi(app as never, { info: INFO }).catch((e: Error) => e)) as Error
		expect(err.message).toMatch(/25 policy error/)
		expect(err.message).toMatch(/… and 5 more/)
		expect(err.message.split("\n").length).toBeLessThan(25)
	})

	it("aggregates errors rather than failing on the first", async () => {
		const err = await generateWith({ meta: { a: "responses", b: "alsoNotAField" } }).catch((e: Error) => e)
		expect((err as Error).message).toMatch(/2 policy error/)
	})

	it("refuses a second metaSpec() call", () => {
		const app = honey<{}>()
		app.metaSpec({ meta: {} })
		expect(() => app.metaSpec({ meta: {} })).toThrow(/already declared/)
	})
})

/* ---- composition ---- */

describe("mounted sub-apps", () => {
	it("a sub-app's own document is unaffected by any parent it is mounted into", async () => {
		/* mount the same instance that we then generate — the merge must not write back */
		const worker = honey<{}>().meta<{ secret?: string }>()
		worker.metaSpec({ meta: { secret: false } })
		worker
			.get("/extract/rows")
			.meta({ secret: "s3cr3t" })
			.handler((c) => c.res.json("ok", {}))

		const gateway = honey<{}>().meta<{ secret?: string }>()
		gateway.metaSpec({ meta: { secret: "x-secret" } })
		gateway.route(worker as never)

		const own = await generateOpenApi(worker as never, { info: INFO })
		expect(JSON.stringify(op(own, "/extract/rows"))).not.toContain("s3cr3t")
		expect(op(own, "/extract/rows")).not.toHaveProperty("x-secret")
	})

	it("a sub-app hiding a key hides it in the aggregate too — the strictest claim survives", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const sub = honey<{}>().meta<{ secret?: string }>()
		sub.metaSpec({ meta: { secret: false } })
		sub
			.get("/extract/rows")
			.meta({ secret: "s3cr3t" })
			.handler((c) => c.res.json("ok", {}))

		const gateway = honey<{}>().meta<{ secret?: string }>()
		gateway.metaSpec({ meta: { secret: "x-secret" } })
		gateway.route(sub as never)

		const spec = await generateOpenApi(gateway as never, { info: INFO })
		expect(JSON.stringify(op(spec, "/extract/rows"))).not.toContain("s3cr3t")
		expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/SUBAPP_ENTRY_CONFLICT.*hides this key/s)
		warn.mockRestore()
	})

	it("any other disagreement resolves to the parent, and says so", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const sub = honey<{}>().meta<{ tenant?: string }>()
		sub.metaSpec({ meta: { tenant: "x-sub-tenant" } })
		sub
			.get("/sub/rows")
			.meta({ tenant: "orgId" })
			.handler((c) => c.res.json("ok", {}))

		const gateway = honey<{}>().meta<{ tenant?: string }>()
		gateway.metaSpec({ meta: { tenant: "x-tenant" } })
		gateway.route(sub as never)

		const spec = await generateOpenApi(gateway as never, { info: INFO })
		expect(op(spec, "/sub/rows")["x-tenant"]).toBe("orgId")
		expect(op(spec, "/sub/rows")).not.toHaveProperty("x-sub-tenant")
		expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/SUBAPP_ENTRY_CONFLICT.*this app's entry wins/s)
		warn.mockRestore()
	})

	it("a policy object shared by both apps is not a conflict", async () => {
		/* the common case: five workers and a gateway importing one policy from a shared
		   package. Identical entries must not produce a warning per key. */
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const shared = { meta: { tenant: "x-tenant" } } as const
		const sub = honey<{}>().meta<{ tenant?: string }>()
		sub.metaSpec(shared)
		sub
			.get("/sub/rows")
			.meta({ tenant: "orgId" })
			.handler((c) => c.res.json("ok", {}))
		const gateway = honey<{}>().meta<{ tenant?: string }>()
		gateway.metaSpec(shared)
		gateway.route(sub as never)

		await generateOpenApi(gateway as never, { info: INFO })
		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})

	it("a parent hiding a key still hides it when a sub wants it emitted", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const sub = honey<{}>().meta<{ secret?: string }>()
		sub.metaSpec({ meta: { secret: "x-secret" } })
		sub
			.get("/extract/rows")
			.meta({ secret: "s3cr3t" })
			.handler((c) => c.res.json("ok", {}))

		const gateway = honey<{}>().meta<{ secret?: string }>()
		gateway.metaSpec({ meta: { secret: false } })
		gateway.route(sub as never)

		const spec = await generateOpenApi(gateway as never, { info: INFO })
		expect(JSON.stringify(op(spec, "/extract/rows"))).not.toContain("s3cr3t")
		expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/SUBAPP_ENTRY_CONFLICT.*this app's entry wins/s)
		warn.mockRestore()
	})

	it("a sub-app's policy fills gaps; the parent wins on conflict", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const sub = honey<{}>()
		sub.metaSpec({ meta: { subKey: "x-sub", tenant: "x-sub-tenant" } })
		sub
			.get("/sub")
			.meta({ subKey: "v", tenant: "t" } as never)
			.handler((c) => c.res.json("ok", {}))

		const app = honey<{}>()
		app.metaSpec({ meta: { tenant: "x-tenant" } })
		app.route(sub as never)

		const spec = await generateOpenApi(app as never, { info: INFO })
		const o = op(spec, "/sub")
		expect(o["x-sub"]).toBe("v")
		expect(o["x-tenant"]).toBe("t")
		expect(o).not.toHaveProperty("x-sub-tenant")
		expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/SUBAPP_ENTRY_CONFLICT/)
		warn.mockRestore()
	})

	it("a route resolves identically standalone and re-mounted behind a gateway", async () => {
		const makeWorker = () => {
			const worker = honey<{}>().meta<{ tenant?: string }>()
			worker.metaSpec({ meta: { tenant: "x-tenant" } })
			worker
				.get("/orgs/:orgId/users")
				.meta({ summary: "List", tenant: "orgId" })
				.handler((c) => c.res.json("ok", {}))
			return worker
		}

		const standalone = await generateOpenApi(makeWorker() as never, { info: INFO })

		const gateway = honey<{}>()
		gateway.route(makeWorker() as never)
		const mounted = await generateOpenApi(gateway as never, { info: INFO })

		expect(JSON.stringify(op(mounted, "/orgs/{orgId}/users"))).toBe(
			JSON.stringify(op(standalone, "/orgs/{orgId}/users")),
		)
	})
})
