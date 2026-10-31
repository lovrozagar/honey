/**
 * The ctx's `meta` in `types.gen.d.ts` (bit 22 a): the type the app declares, with the OpenAPI keys it leaves
 * alone, so a service typed with the generated `RouteCtx` takes the handler's own ctx. The tree's literal values
 * stay the sibling `meta` field. Split from type-gen.test.ts at its 500-line cap.
 */
import * as tsMorph from "ts-morph"
import { describe, expect, it } from "vitest"
import type { ExtractedTypes } from "../../extract/extract.ts"
import { extracted, type HoneyApp, type HoneyRoute, honeyDoc, object } from "./__fixtures__/honey-doc.ts"
import { typechecker } from "./__fixtures__/typecheck.ts"
import { generateTypes } from "./type-gen.ts"

const typecheck = typechecker(tsMorph)

const NUMBER = { type: "number" }
const STRING = { type: "string" }

/** generateTypes over `app`, what it reported, and each diagnostic of `consumer` beside its output. */
function check(app: HoneyApp, consumer: string, types: ExtractedTypes | null = null) {
	const reports: string[] = []
	const text = generateTypes({ ...app, extracted: types, report: (m) => reports.push(m) })
	return { diagnostics: typecheck(text, consumer), reports, text }
}

const route = (method: string, pattern: string, rest: Partial<HoneyRoute> = {}): HoneyRoute => ({
	method,
	pattern,
	...rest,
})

/* the meta of each route as the tree carries it: chain, middleware and route meta resolved (O1) */
const META_APP = honeyDoc([
	route("GET", "/health", { meta: { summary: "Health check" } }),
	route("GET", "/orgs", {
		input: { search: object({ limit: NUMBER }) },
		meta: {
			auth: "required",
			operationId: "listOrgs",
			rateLimit: "strict",
			summary: "List orgs",
			tags: ["Organization"],
		},
	}),
	route("POST", "/orgs", {
		input: { json: object({ name: STRING }) },
		meta: { auth: "required", deprecated: true, security: [{ bearerAuth: [] }], summary: "Create org" },
	}),
])

describe("the ctx's meta (bit 22 a)", () => {
	/* bit 22 a: the ctx's meta is the app's declared type, so a handler's own ctx is assignable to a function
	   typed with the generated ctx; the literal values stay the sibling meta field */
	it("types the ctx's meta from the extracted declared type, the literals left in meta", () => {
		const declared = '{ readonly auth?: "public" | "required"; readonly rateLimit?: "default" | "strict" }'
		const types = extracted({ env: "{}", meta: declared })
		/* `live` is the handler's own meta: the declared keys at their declared types, the OpenAPI keys widened */
		const consumer = `declare const live: ${declared} & { readonly operationId?: string; readonly tags?: string[] }
declare const generated: RouteCtx<"/orgs", "get">["meta"]
const intoGenerated: RouteCtx<"/orgs", "get">["meta"] = live
expectType<Equal<(typeof generated)["auth"], "public" | "required" | undefined>>()
expectType<Equal<RouteMeta<"/orgs", "get">, { auth: "required"; operationId: "listOrgs"; rateLimit: "strict"; summary: "List orgs"; tags: ["Organization"] }>>()
void intoGenerated`
		expect(check(META_APP, consumer, types).diagnostics).toEqual([])
	})
})

describe("the ctx's meta and a declared key (bit 22 a)", () => {
	/* a consumer may type an OpenAPI key its own way; the handler holds that type, so the ctx must not intersect
	   honey's over it */
	it("leaves out an OpenAPI key the declared meta redefines", () => {
		const declared = "{ readonly security?: readonly { readonly scheme: string }[] }"
		const types = extracted({ env: "{}", meta: declared })
		const consumer = `declare const live: ${declared}
const intoGenerated: RouteCtx<"/orgs", "get">["meta"] = live
expectType<Equal<(typeof intoGenerated)["security"], readonly { readonly scheme: string }[] | undefined>>()`
		expect(check(META_APP, consumer, types).diagnostics).toEqual([])
	})

	it("falls back to the tree's literal meta in the ctx when nothing was extracted", () => {
		const consumer = `declare const widened: { summary: string }
const literal: RouteCtx<"/health", "get">["meta"] = { summary: "Health check" }
// @ts-expect-error the fallback is the tree's literal, which a widened string does not satisfy
const notLiteral: RouteCtx<"/health", "get">["meta"] = widened
void literal
void notLiteral`
		expect(check(META_APP, consumer).diagnostics).toEqual([])
	})

	// v0: 3e07faac56
	it("types chain meta per route, a route's own value overriding the chain's", () => {
		const app = honeyDoc([
			route("GET", "/test", { meta: { security: "jwt", tags: "Auth" } }),
			route("POST", "/test", { meta: { security: "jwt", tags: "Override" } }),
		])
		const consumer = `expectType<Equal<RouteMeta<"/test", "get">, { security: "jwt"; tags: "Auth" }>>()
expectType<Equal<RouteMeta<"/test", "post">, { security: "jwt"; tags: "Override" }>>()`
		expect(check(app, consumer, extracted({ env: "{}" })).diagnostics).toEqual([])
	})

	// v0: 2717e15bd2
	it("types invalidate beside deprecated, operationId and tags, and a meta-less route as {}", () => {
		const meta = { deprecated: true, invalidate: ["GET /v1/users"], operationId: "user.create", tags: "users" }
		const app = honeyDoc([route("GET", "/v1/users"), route("POST", "/v1/users", { meta })])
		const consumer = `expectType<Equal<RouteMeta<"/v1/users", "post">, { deprecated: true; invalidate: ["GET /v1/users"]; operationId: "user.create"; tags: "users" }>>()
expectType<Equal<RouteMeta<"/v1/users", "get">, {}>>()`
		expect(check(app, consumer).diagnostics).toEqual([])
	})

	// v0: eecb2cdc81
	it("types invalidate as a literal string tuple", () => {
		const app = honeyDoc([
			route("GET", "/v1/users"),
			route("GET", "/v1/users/:id"),
			route("POST", "/v1/users", { meta: { invalidate: ["GET /v1/users", "GET /v1/users/:id"] } }),
		])
		const consumer = `expectType<Equal<RouteMeta<"/v1/users", "post">["invalidate"], ["GET /v1/users", "GET /v1/users/:id"]>>()`
		expect(check(app, consumer).diagnostics).toEqual([])
	})
})
