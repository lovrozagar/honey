/**
 * The emitted adapter compiles in a consumer's project (bit 22, leaf 5.2). An emitted file lands in the
 * consumer's own tree and inherits their compiler flags, so the flag set here is the one
 * `tests/e2e/strict-consumer/tsconfig.json` uses — every strictness flag we could plausibly meet.
 *
 * It writes under `packages/gen/.tmp/`, inside the repository and gitignored, NOT under
 * `~/.cache/honey-tmp` like the behavior fixture: `@tanstack/query-core` is a devDependency of this package,
 * so only a project inside the workspace resolves it, and a type-only import that silently failed to
 * resolve would make this leg prove nothing. The leg asserts it resolved.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"
import type { OpenApiDocument } from "../../ir/build.ts"
import { generateSdk } from "./sdk.ts"

const GEN = resolve(import.meta.dirname, "../../..")

const STRICT = {
	compilerOptions: {
		exactOptionalPropertyTypes: true,
		module: "ESNext",
		moduleResolution: "bundler",
		noEmit: true,
		noFallthroughCasesInSwitch: true,
		noImplicitOverride: true,
		noImplicitReturns: true,
		noPropertyAccessFromIndexSignature: true,
		noUncheckedIndexedAccess: true,
		noUnusedLocals: true,
		noUnusedParameters: true,
		skipLibCheck: true,
		strict: true,
		target: "ESNext",
		types: [],
		verbatimModuleSyntax: true,
	},
	include: ["./**/*.ts"],
}

const json = () => ({ content: { "application/json": { schema: { type: "object" } } }, description: "" })
const param = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })

const document = {
	info: { title: "Shop", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/orgs": {
			get: { operationId: "org.list", responses: { 200: json() } },
			post: { operationId: "org.create", responses: { 201: json() }, "x-invalidate": ["GET /orgs"] },
		},
		"/orgs/{org_id}": {
			get: { operationId: "org.get", parameters: [param("org_id")], responses: { 200: json() } },
			patch: {
				operationId: "org.update",
				parameters: [param("org_id")],
				responses: { 200: json() },
				"x-invalidate": ["GET /orgs", "GET /orgs/{org_id}"],
			},
		},
		"/orgs/{org_id}/members": {
			get: {
				operationId: "org.member.list",
				parameters: [param("org_id"), { in: "query", name: "limit", schema: { type: "integer" } }],
				responses: { 200: json() },
			},
		},
	},
} as unknown as OpenApiDocument

/* a consumer's own module: the shapes anyrow's ~40 call sites use, so this fails if one of them breaks */
const consumer = `import { Shop } from "./shop.client.gen"
import { createQueryHelpers } from "./shop.tanstack-query.gen"

const sdk = new Shop({ baseURL: "https://example.test" })
const helpers = createQueryHelpers(() => sdk)

export const listOptions = helpers.query.org.list()
export const oneOptions = helpers.query.org.get({ reqOptions: { req: { params: { org_id: "o1" } } } })
export const nested = helpers.query.org.member.list({ reqOptions: { req: { params: { org_id: "o1" } } } })
export const fresh = helpers.query.org.list({ queryProps: { staleTime: 0 } })
export const create = helpers.mutation.org.create()
export const update = helpers.mutation.org.update()
export const listKey = helpers.queryKey.org.list()
export const oneKey = helpers.queryKey.org.get({ params: { org_id: "o1" } })

/* search belongs in the key, so the typed request has to accept it on both the read and its key builder */
export const page = helpers.query.org.member.list({
	reqOptions: { req: { params: { org_id: "o1" }, search: { limit: 20 } } },
})
export const pageKey = helpers.queryKey.org.member.list({ params: { org_id: "o1" }, search: { limit: 20 } })
export const paged = helpers.infiniteQuery.org.member.list({
	buildReqOptions: (limit: number) => ({ req: { params: { org_id: "o1" }, search: { limit } } }),
	getNextPageParam: () => null,
	initialPageParam: 20,
})
`

/** The project written out, and what `tsc` says about it: `""` when it is clean. */
function checked(extra: string): { diagnostics: string; dir: string } {
	const dir = join(GEN, ".tmp/tanstack-query-typecheck")
	rmSync(dir, { force: true, recursive: true })
	mkdirSync(dir, { recursive: true })
	const { files } = generateSdk(document as unknown as Record<string, unknown>, {
		name: "Shop",
		stem: "shop",
		tanstackQuery: true,
	})
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
	writeFileSync(join(dir, "consumer.ts"), `${consumer}${extra}`)
	writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify(STRICT, null, "\t")}\n`)
	const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc")
	try {
		execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], { encoding: "utf8" })
		return { diagnostics: "", dir }
	} catch (error) {
		return { diagnostics: String((error as { stdout?: string }).stdout ?? error), dir }
	}
}

describe("the emitted adapter compiles in a consumer's project (bit 22, G-strict)", () => {
	it("type-checks under every strictness flag, with query-core resolved", { timeout: SPAWN_TIMEOUT }, () => {
		const { diagnostics, dir } = checked("")
		/* the import must really resolve: a missing package would otherwise read as a clean run */
		const resolved = createRequire(join(dir, "consumer.ts")).resolve("@tanstack/query-core/package.json")
		expect(resolved).toContain("@tanstack/query-core")
		expect(diagnostics).toBe("")
	})

	it(
		"is not a hollow check: the surfaces refuse what the service map says they are not",
		{ timeout: SPAWN_TIMEOUT },
		() => {
			/* a clean run proves nothing unless a wrong call is refused, so each mutant must red */
			expect(checked("\nexport const bad = helpers.query.org.create()\n").diagnostics).toContain(
				"Property 'create' does not exist",
			)
			expect(checked("\nexport const bad = helpers.mutation.org.list()\n").diagnostics).toContain(
				"Property 'list' does not exist",
			)
			expect(checked("\nexport const bad = helpers.query.org.get()\n").diagnostics).toContain(
				"Expected 1 arguments, but got 0",
			)
		},
	)
})
