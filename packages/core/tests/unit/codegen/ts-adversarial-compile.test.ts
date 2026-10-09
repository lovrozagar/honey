/**
 * The adversarial corpus for the TypeScript outputs: every generated `types.gen.d.ts` and SDK
 * file is compiled with `tsc --strict`, `skipLibCheck` off, and positive type assertions check
 * that what the files declare actually takes effect (a missed module augmentation compiles
 * silently, so compiling alone cannot catch it).
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { generateOpenApi, generateSDK, generateTypes } from "../../../src/codegen.ts"
import { defineErrors } from "../../../src/errors.ts"
import { honey } from "../../../src/index.ts"

const CORE = join(dirname(fileURLToPath(import.meta.url)), "../../..")
const TSC = join(CORE, "../../node_modules/.bin/tsc")
const DIR = join(CORE, "tests", `.tmp-ts-adversarial-${process.pid}`)

afterAll(() => {
	if (!process.env.KEEP_TMP) rmSync(DIR, { force: true, recursive: true })
})

function adversarialApp() {
	enum Numeric {
		A = 0,
		B = 1,
	}
	const Node: z.ZodType<{ children: unknown[]; name: string }> = z.object({
		get children() {
			return z.array(Node)
		},
		name: z.string(),
	})
	const errors = defineErrors({ "rate-limited": "too_many_requests", "user.not_found": "not_found" })
	const app = honey<{}>().errorFactory(errors)
	app
		.get("/users/:user-id")
		.errors("user.not_found", "rate-limited")
		.meta({ operationId: "users.get", summary: 'quote " and\nnewline' })
		.input({
			headers: z.object({ "x-trace": z.string().optional() }),
			search: z.object({
				big: z.literal(5n).optional(),
				kind: z.enum(['a"b', "c\\d", "line\nbreak"]).optional(),
				n: z.enum(Numeric).optional(),
			}),
		})
		.output({
			"application/json": {
				ok: z.object({
					"@type": z.string(),
					"2fa": z.boolean(),
					both: z.intersection(
						z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
						z.object({ c: z.string() }),
					),
					fns: z.array(z.function()),
					map: z.map(z.string(), z.number()),
					set: z.set(z.string()),
					tree: Node,
					tuple: z.tuple([z.string()], z.number()),
					"x-request-id": z.string(),
				}),
			},
		})
		.handler((c) => c.res.json("ok", {} as never))
	app
		.post("/users")
		.meta({ invalidate: ["GET /users/:user-id"], operationId: "users.create" })
		.input({ json: z.object({ name: z.string() }) })
		.handler((c) => c.res.json("created", {}))
	app.get("/files/*path").handler((c) => c.res.text("ok", "ok"))
	app.get("/star/*").handler((c) => c.res.text("ok", "ok"))
	app
		.post("/chat")
		.meta({ operationId: "chat" })
		.input({ json: z.object({ q: z.string() }) })
		.handler((c) => c.res.sse(async () => {}))
	app
		.get("/state")
		.meta({ operationId: "state.get" })
		.handler((c) => c.res.json("ok", {}))
	app
		.get("/then")
		.meta({ operationId: "then" })
		.handler((c) => c.res.json("ok", {}))
	app.get("/no-id").handler((c) => c.res.json("ok", {}))
	return app
}

function tsc(project: string): string {
	try {
		execFileSync(TSC, ["-p", project], { cwd: CORE, encoding: "utf8", stdio: "pipe" })
		return ""
	} catch (err) {
		const e = err as { code?: string; stderr?: string; stdout?: string }
		/* a compiler that did not run must fail the test, not pass it */
		if (e.code === "ENOENT") throw err
		return `${e.stdout ?? ""}${e.stderr ?? ""}`
	}
}

describe("generated TypeScript compiles under --strict without skipLibCheck", () => {
	it("types.gen.d.ts, the SDK files and the type assertions all compile", { timeout: 120_000 }, async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const app = adversarialApp()
			mkdirSync(join(DIR, "sdk"), { recursive: true })
			writeFileSync(join(DIR, "types.gen.d.ts"), generateTypes(app as never, { inlineEnvType: "{}" }))

			const doc = await generateOpenApi(app as never, { info: { title: "Adversarial", version: "1" } })
			const { files } = generateSDK(doc as never, { name: "AdvSDK", stem: "adv" })
			writeFileSync(join(DIR, "sdk/adv.client.gen.ts"), files.client)
			writeFileSync(join(DIR, "sdk/adv.index.gen.ts"), files.index)
			writeFileSync(join(DIR, "sdk/adv.map.gen.ts"), files.map)
			writeFileSync(join(DIR, "sdk/adv.types.gen.ts"), files.types)

			writeFileSync(
				join(DIR, "assertions.ts"),
				`import type { HoneyCodegen, HoneyMeta } from "@lovrozagar/honey"
import type { RouteSelector, Routes } from "./types.gen.d.ts"
import { AdvSDK } from "./sdk/adv.index.gen.ts"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

/* the augmentation applies: honey's selector type narrows to this app's routes (H39) */
export type _augmented = Expect<Equal<HoneyCodegen["routeSelector"], RouteSelector>>
type Selector = NonNullable<HoneyMeta["invalidate"]>[number]
export type _narrowedIn = Expect<"GET /users/:user-id" extends Selector ? true : false>
export type _narrowedOut = Expect<"GET /no-such-route" extends Selector ? false : true>
export type _hasUser = Expect<"GET /users/:user-id" extends RouteSelector ? true : false>

/* hyphenated params and wildcard names are what ctx.params carries at runtime */
export type _params = Expect<Routes["/users/:user-id"]["get"]["ctx"]["params"] extends { "user-id": string } ? true : false>
export type _wildcard = Expect<Routes["/files/*path"]["get"]["ctx"]["params"] extends { path: string } ? true : false>
export type _star = Expect<Routes["/star/*"]["get"]["ctx"]["params"] extends { "*": string } ? true : false>

/* literals with quotes, backslashes and newlines are the exact strings; numeric enums carry numbers */
type Search = Routes["/users/:user-id"]["get"]["input"]["search"]
export type _kind = Expect<Equal<NonNullable<Search["kind"]>, 'a"b' | "c\\\\d" | "line\\nbreak">>
export type _numeric = Expect<Equal<NonNullable<Search["n"]>, 0 | 1>>
export type _bigint = Expect<Equal<NonNullable<Search["big"]>, 5n>>

/* error keys that are not identifiers */
export type _errors = Expect<Equal<Routes["/users/:user-id"]["get"]["errors"], "rate-limited" | "user.not_found">>

const sdk = new AdvSDK({ baseURL: "https://api.example.com" })
/* members that would collide are renamed; the client's own members keep their types */
export const _state: Record<string, unknown> = sdk.state
export const _dispose: () => void = sdk.dispose
export const _renamed = sdk.state_.get
export const _then = sdk.then_
/* an operation without an operationId is callable under a derived name */
export const _derived = sdk.getNoId
/* a streamed POST takes its body */
export const _chat = () => sdk.chat({ json: { q: "hi" } })
`,
			)
			writeFileSync(join(DIR, "canary.ts"), 'export const canary: number = "not a number"\n')
			writeFileSync(
				join(DIR, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: {
						allowImportingTsExtensions: true,
						customConditions: ["honey-source"],
						exactOptionalPropertyTypes: false,
						lib: ["ESNext", "DOM", "DOM.Iterable"],
						module: "ESNext",
						moduleResolution: "bundler",
						noEmit: true,
						noFallthroughCasesInSwitch: true,
						noImplicitOverride: true,
						noImplicitReturns: true,
						noUncheckedIndexedAccess: true,
						skipLibCheck: false,
						strict: true,
						target: "ESNext",
						types: [],
					},
					files: [
						"canary.ts",
						"types.gen.d.ts",
						"assertions.ts",
						"sdk/adv.client.gen.ts",
						"sdk/adv.types.gen.ts",
						"sdk/adv.map.gen.ts",
					],
				}),
			)
			const output = tsc(join(DIR, "tsconfig.json"))
			/* honey's own sources are covered by `typecheck` and `test:packaging`; only the generated files are judged here */
			const generatedErrors = output
				.split("\n")
				.filter((line) => /(?:^|\/)(?:types\.gen\.d\.ts|assertions\.ts|canary\.ts|sdk\/adv\.)/.test(line.trim()))
			expect(generatedErrors.filter((line) => !line.includes("canary.ts")).join("\n")).toBe("")
			/* the compiler really ran over these files: the deliberate error in the canary is reported */
			expect(output).toContain("canary.ts")
		} finally {
			warn.mockRestore()
		}
	})
})
