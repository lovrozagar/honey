/**
 * An operation without an operationId (bit 16 phase f, item 0): the Java SDK emits it under the IR's derived id
 * (`toIR`'s `deriveOperationIds`, which C#, Go, Python, Rust and TS ask for), a flat id on the client's root, and a
 * derived id another one shares is suffixed exactly as C#'s is. Each e2e app declares no ids, so each one's Java plans
 * must equal C#'s; the collision document compiles in format.test.ts's gating guard (`derived`).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { csharpCallPlans } from "../csharp/sdk.ts"
import { derivedIds } from "./__fixtures__/documents.ts"
import { generateJavaSdk, javaCallPlans } from "./sdk.ts"

/** The five e2e apps, whose emitted documents declare no operationId. */
const APPS = ["compose", "defaults", "gateway", "kitchen", "surface"] as const
const REPO = join(import.meta.dirname, "../../../../..")

/** An e2e app's emitted OpenAPI document. */
const appSpec = (app: string) =>
	JSON.parse(
		readFileSync(join(REPO, `packages/core/tests/e2e/apps/${app}/src/_gen/openapi.gen.json`), "utf8"),
	) as Record<string, unknown>

/** A call-plan map's operation ids, sorted. */
const keys = (plans: Readonly<Record<string, unknown>>) => Object.keys(plans).sort()

describe("generateJavaSdk: an operation without an operationId (item 0)", () => {
	/* new: red before item 0, when Java read no id it was not given and so emitted none of these operations */
	it("emits every e2e app's operations, each under C#'s operation id", () => {
		const seen = Object.fromEntries(APPS.map((app) => [app, keys(javaCallPlans(appSpec(app)))]))
		const want = Object.fromEntries(APPS.map((app) => [app, keys(csharpCallPlans(appSpec(app)))]))
		expect(seen).toEqual(want)
	})

	/* new: the IR's collision suffixes (ir/build.test.ts:42), reached by Java exactly as C# reaches them */
	it("names shared and derived ids as C# does: x, xPost, xPut, xPut2, getRoot, postUsers, deleteUsers2", () => {
		expect(Object.keys(javaCallPlans(derivedIds())).sort()).toEqual(Object.keys(csharpCallPlans(derivedIds())).sort())
		expect(Object.keys(javaCallPlans(derivedIds())).sort()).toEqual([
			"deleteUsers.all",
			"deleteUsers2",
			"getInParamsOrgsMembersByOrgIdAndMemberId",
			"getRoot",
			"postUsers",
			"x",
			"xPost",
			"xPut",
			"xPut2",
		])
	})

	/* new: a flat derived id is a method on the client itself (C#'s root placement) */
	it("puts a flat derived id on the client's root and a dotted one on its resource", () => {
		const plans = javaCallPlans(derivedIds()) as Record<string, { accessors: readonly string[]; method: string }>
		const client = generateJavaSdk(derivedIds()).files["src/main/java/ai/anyrow/AnyrowClient.java"] ?? ""
		expect({
			dotted: [plans["deleteUsers.all"]?.accessors, plans["deleteUsers.all"]?.method],
			root: [plans.getRoot?.accessors, plans.getRoot?.method],
			rootMethod: /^ {2}public .+ getRoot\(GetRootParams params\) \{$/m.test(client),
		}).toEqual({ dotted: [["deleteUsers"], "all"], root: [[], "getRoot"], rootMethod: true })
	})
})
