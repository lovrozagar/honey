import { describe, expect, expectTypeOf, it } from "vitest"
import { honey } from "../routing/app.ts"
import { compileMetaSpec, type HoneyMetaSpec, type MetaSpecConfig } from "./meta-spec.ts"
import { mergeMetaSpec, metaSpecOf, resolvedStrictness } from "./meta-spec-merge.ts"
import { MetaSpecDiagnostics } from "./meta-spec-validate.ts"

describe("resolvedStrictness: what a policy runs with", () => {
	it("is error once declared, what it says when it says, and off without a policy", () => {
		expect([resolvedStrictness({}), resolvedStrictness({ strict: "warn" }), resolvedStrictness(null)]).toEqual([
			"error",
			"warn",
			"off",
		])
	})
})

describe("mergeMetaSpec: a mounted sub-app's policy under its parent's", () => {
	// v0: 7482301e43
	// v0: eff8a5bab5
	it("fills gaps from the sub, lets the parent win a disagreement and records it", () => {
		const merged = mergeMetaSpec(
			{ meta: { a: "x-parent" }, profiles: { p: { include: ["x-a"] } }, schema: { s: { key: "x-s" } } },
			{ meta: { a: "x-sub", b: "x-b" }, profiles: { p: {}, q: {} }, schema: { s: { key: "x-t" } } },
		)
		expect(merged).toEqual({
			conflicts: [
				{ key: "a", resolution: "parent", section: "meta" },
				{ key: "s", resolution: "parent", section: "schema" },
				{ key: "p", resolution: "parent", section: "profiles" },
			],
			meta: { a: "x-parent", b: "x-b" },
			profiles: { p: { include: ["x-a"] }, q: {} },
			schema: { s: { key: "x-s" } },
			strict: "error",
		})
	})

	// v0: 174f3e1bbe
	// v0: 3b118d8a4c
	// v0: 3bf88269c2
	// v0: 5ed48f22e0
	// v0: e586a69bb7
	it("lets a sub's false win over anything, keeps a parent's false, and sees no conflict in one shared entry", () => {
		const shared = { key: "x-shared" }
		const merged = mergeMetaSpec(
			{ meta: { leak: "x-leak", mine: false, shared }, strict: "warn" },
			{ meta: { leak: false, mine: "x-mine", shared }, strict: "off" },
		)
		expect([merged?.meta, merged?.conflicts, merged?.strict]).toEqual([
			{ leak: false, mine: false, shared },
			[
				{ key: "leak", resolution: "hidden", section: "meta" },
				{ key: "mine", resolution: "parent", section: "meta" },
			],
			"warn",
		])
		expect([mergeMetaSpec(null, { meta: {} }), mergeMetaSpec({ meta: {} }, null)]).toEqual([{ meta: {} }, { meta: {} }])
		/* a sub's strict: "off" never downgrades a parent that left strict at its default */
		expect(mergeMetaSpec({ meta: {} }, { meta: {}, strict: "off" })?.strict).toBe("error")
	})
})

describe("mergeMetaSpec: conflicts, once compiled", () => {
	it("reports each conflict once compiled, as a warning that says which side won", () => {
		const diagnostics = new MetaSpecDiagnostics()
		compileMetaSpec(
			{
				conflicts: [
					{ key: "leak", resolution: "hidden", section: "meta" },
					{ key: "a", resolution: "parent", section: "meta" },
				],
			},
			diagnostics,
		)
		expect(diagnostics.list.map(({ code, level, message }) => [code, level, message.split(":")[0]])).toEqual([
			["SUBAPP_ENTRY_CONFLICT", "warn", 'meta."leak"'],
			["SUBAPP_ENTRY_CONFLICT", "warn", 'meta."a"'],
		])
	})
})

describe("app.metaSpec(): the policy an app declares and the ones it mounts", () => {
	// v0: 6784b8254a
	// v0: 7781260304
	it("merges every mounted sub-app's policy, whether declared before or after the mount, and leaves the sub's own alone", () => {
		const sub = honey<{}>()
		sub.get("/s").handler((ctx) => ctx.res.text("ok", "ok"))
		const app = honey<{}>()
		app.route("/v1", sub)
		app.metaSpec({ meta: { a: "x-parent" } })
		sub.metaSpec({ meta: { a: "x-sub", b: "x-b" } })
		expect([metaSpecOf(app)?.meta, metaSpecOf(sub), metaSpecOf(honey<{}>())]).toEqual([
			{ a: "x-parent", b: "x-b" },
			{ meta: { a: "x-sub", b: "x-b" } },
			null,
		])
	})

	// v0: c796a9bd41
	it("refuses a second declaration, and types an entry for every key the app's meta adds", () => {
		const app = honey<{}>().meta<{ team: string }>()
		app.metaSpec({ meta: { team: "x-team" } })
		expect(() => app.metaSpec({})).toThrow("metaSpec() was already called on this app")
		expectTypeOf<HoneyMetaSpec<{ summary?: string; team: string }>>().toExtend<{ meta?: { team: unknown } }>()
		// @ts-expect-error team has no entry
		const missing: HoneyMetaSpec<{ team: string }> = { meta: {} }
		expect(missing).toEqual({ meta: {} })
		const config: MetaSpecConfig = { meta: { any: "x-any" } }
		expect(config.meta).toEqual({ any: "x-any" })
	})
})
