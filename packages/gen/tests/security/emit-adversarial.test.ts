/**
 * Gen's adversarial suite: spec text an emitter must never let become source. A string literal
 * carrying a line or paragraph separator, a BOM or NUL; property names and enum values that read as
 * code; names whose order depends on the machine; a webhook verify helper that compares the
 * signature by value, so its timing leaks how much of a forged one is right. Each is a failing input first and the property
 * that answers it second; the gen mutation harness reruns this directory with each guard disabled.
 */
import { resolve } from "node:path"
import { Project } from "ts-morph"
import { describe, expect, it, vi } from "vitest"
import { guardNamed } from "../structure/mutation-harness.ts"

const REPO = resolve(import.meta.dirname, "../../../..")

const mutant = guardNamed(process.env.HONEY_MUTANT)
if (mutant !== undefined) {
	vi.doMock(resolve(REPO, mutant.module), async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>()
		return { ...original, ...mutant.disable(original) }
	})
}

/* imported after the mock, so a mutant reaches every module that uses it */
const { commentProblem, failures, literalProblem, TARGETS } = (await import(
	resolve(REPO, "packages/gen/src/emit/shared/__fixtures__/escape-oracle.ts")
)) as typeof import("../../src/emit/shared/__fixtures__/escape-oracle.ts")
const { irToTs } = (await import(
	resolve(REPO, "packages/gen/src/emit/shared/type-emitter.ts")
)) as typeof import("../../src/emit/shared/type-emitter.ts")
const { schemaToIR } = (await import(
	resolve(REPO, "packages/gen/src/ir/schema.ts")
)) as typeof import("../../src/ir/schema.ts")
const { verifyHelper, WEBHOOK_LANGUAGES } = (await import(
	resolve(REPO, "packages/gen/src/emit/shared/webhooks.ts")
)) as typeof import("../../src/emit/shared/webhooks.ts")

/** The TypeScript of a JSON Schema, as an emitter writes it. */
const typeOf = (schema: Record<string, unknown>) => irToTs(schemaToIR(schema))

/** `type T = <text>` parsed and checked: its syntax errors, its member names and its union's literal values. */
function compiled(text: string): { errors: string[]; members: string[]; values: unknown[] } {
	const project = new Project({ compilerOptions: { strict: true }, useInMemoryFileSystem: true })
	const file = project.createSourceFile("/t.ts", `export type T = ${text}\n`)
	const type = file.getTypeAliasOrThrow("T").getType()
	return {
		errors: file.getPreEmitDiagnostics().map((d) => String(d.getMessageText())),
		members: type.getProperties().map((p) => p.getName()),
		values: type.isUnion() ? type.getUnionTypes().map((t) => t.getLiteralValue()) : [],
	}
}

describe("gen adversarial: a string literal", () => {
	it("never carries U+2028, U+2029, NEL, the BOM or NUL raw, nor an escape its target cannot read", () => {
		const texts = ["a b", "a b", "a\u0085b", "﻿bom", "nul\0", "\u007f", 'q"\\']
		const problems = TARGETS.flatMap((target) =>
			texts.flatMap((text) => {
				const found = literalProblem(target, text)
				return found === null ? [] : [`${target} ${JSON.stringify(text)}: ${found}`]
			}),
		)
		expect(problems).toEqual([])
	})

	it("holds over the F2 fuzz, every target and comment form", () => {
		const fuzzed = [
			...TARGETS.flatMap((target, at) => failures(21 + at, (text) => literalProblem(target, text), 2_000)),
			...failures(29, commentProblem, 2_000),
		]
		expect(fuzzed).toEqual([])
	})
})

describe("gen adversarial: names in emitted source", () => {
	it("orders fields by code unit, the same whatever order the spec lists them in", () => {
		const names = ["b", "_", "B", "a", "Z"]
		const emit = (order: readonly string[]) =>
			typeOf({ properties: Object.fromEntries(order.map((n) => [n, { type: "string" }])), type: "object" })
		const outputs = [names, names.toReversed(), ["Z", "a", "B", "_", "b"]].map(emit)
		expect(new Set(outputs).size).toBe(1)
		expect(outputs[0]).toBe("{ B?: string; Z?: string; _?: string; a?: string; b?: string }")
	})
})

describe("gen adversarial: spec text never becomes source", () => {
	it("keeps property names and enum values that read as code as data", () => {
		const keys = ['"; process.exit(1); "', "*/", "a-b", "x y", "constructor", "${x}"]
		const values = ['"; process.exit(1) //', "*/ evil /*", "${x}", "`"]
		const object = compiled(
			typeOf({ properties: Object.fromEntries(keys.map((k) => [k, { type: "number" }])), type: "object" }),
		)
		const union = compiled(typeOf({ enum: values }))
		expect([object.errors, [...object.members].sort(), union.errors, [...union.values].sort()]).toEqual([
			[],
			[...keys].sort(),
			[],
			[...values].sort(),
		])
	})
})

/* a digest compared by value: an operator, an equality method or a byte-wise library compare */
const VALUE_COMPARE =
	/\b(?:expected|given)\b\s*(?:===?|!==?|\.equals\(|\.SequenceEqual\()|(?:===?|!==?)\s*\b(?:expected|given)\b|bytes\.Equal|Arrays\.equals|memcmp/

describe("emit adversarial: webhook signatures", () => {
	it.each(WEBHOOK_LANGUAGES)("%s's verify helper never compares the digest by value", (language) => {
		expect(VALUE_COMPARE.exec(verifyHelper(language))?.[0] ?? null).toBeNull()
	})
})

/* the TS emitters and the emitted client, imported after the mock so every guard reaches them */
const { generateSdk } = (await import(
	resolve(REPO, "packages/gen/src/emit/ts/sdk.ts")
)) as typeof import("../../src/emit/ts/sdk.ts")
const { generateTypes } = (await import(
	resolve(REPO, "packages/gen/src/emit/ts/type-gen.ts")
)) as typeof import("../../src/emit/ts/type-gen.ts")
const { emittedApp, emittedRouteTree, recordingFetch } = (await import(
	resolve(REPO, "packages/gen/src/emit/ts/__fixtures__/emitted.ts")
)) as typeof import("../../src/emit/ts/__fixtures__/emitted.ts")
const { honeyDoc } = (await import(
	resolve(REPO, "packages/gen/src/emit/ts/__fixtures__/honey-doc.ts")
)) as typeof import("../../src/emit/ts/__fixtures__/honey-doc.ts")
const { treeOf } = (await import(
	resolve(REPO, "packages/gen/src/emit/ts/__fixtures__/tree-data.ts")
)) as typeof import("../../src/emit/ts/__fixtures__/tree-data.ts")

const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "" } }
const docOf = (paths: Record<string, unknown>) => ({ info: { title: "T", version: "1" }, openapi: "3.1.0", paths })

/** The syntax errors of `text` as a TS module. */
function syntaxErrors(text: string): string[] {
	const project = new Project({ useInMemoryFileSystem: true })
	const file = project.createSourceFile("/m.ts", text)
	return file
		.getPreEmitDiagnostics()
		.filter((d) => d.getCategory() === 1 && d.getCode() < 2000)
		.map((d) => String(d.getMessageText()))
}

/** generateTypes over `app` with nothing extracted. */
const typesOf = (app: ReturnType<typeof honeyDoc>) => generateTypes({ ...app, extracted: null, report: () => {} })

describe("gen adversarial: the TS SDK emitter", () => {
	// v0: 0e4ec405fe
	it("never reaches Object.prototype with an operationId of __proto__.x or constructor.y", () => {
		generateSdk(
			docOf({
				"/c": { get: { operationId: "constructor.y", responses: OK } },
				"/p": { get: { operationId: "__proto__.polluted", responses: OK } },
			}),
			{ name: "SDK" },
		)
		expect([({} as Record<string, unknown>).polluted, ({} as Record<string, unknown>).y]).toEqual([
			undefined,
			undefined,
		])
	})

	// v0: 1436545498
	it("refuses an SDK name or stem that is not safe in source", () => {
		const doc = docOf({ "/a": { get: { operationId: "a", responses: OK } } })
		expect(() => generateSdk(doc, { name: "My SDK" })).toThrow(/identifier/)
		expect(() => generateSdk(doc, { name: "SDK", stem: '../x"' })).toThrow(/file name/)
	})
})

describe("gen adversarial: generateTypes and generateRouteTree keep spec text as data", () => {
	// v0: 5fd4c0bc30
	it("keeps a route-tree meta key that reads as code a string key, no statement injected", async () => {
		const key = 'k"]: 1 }; globalThis.injected = 1; const z = { ["x'
		const { routes } = await emittedRouteTree(treeOf([["GET", "/m", { mt: { [key]: true } }]]))
		const meta = (routes as Record<string, { mt?: Record<string, unknown> }>)["GET /m"]?.mt
		expect([meta, (globalThis as { injected?: unknown }).injected]).toEqual([{ [key]: true }, undefined])
	})

	// v0: a9fc43d983
	it("writes a hyphenated path param as a quoted key, and the file parses", () => {
		const text = typesOf(honeyDoc([{ method: "GET", pattern: "/users/:user-id" }]))
		expect([syntaxErrors(text), text.includes('"user-id": string')]).toEqual([[], true])
	})

	// v0: ba5748a9eb
	it("writes error keys holding - and . as quoted keys, and the file parses", () => {
		const errors = { "rate-limited": { status: 429 }, "user.not_found": { status: 404 } }
		const text = typesOf(honeyDoc([{ errors, method: "GET", pattern: "/u" }]))
		expect([syntaxErrors(text), text.includes('"rate-limited"'), text.includes('"user.not_found"')]).toEqual([
			[],
			true,
			true,
		])
	})

	// v0: fb7413b2c0
	it("keeps enum values with quotes, backslashes, newlines and U+2028 exact, and the file parses", () => {
		const values = ['a"b', "C:\\temp", "line\nbreak", "sep\u2028x"]
		const input = {
			search: { properties: { kind: { enum: values, type: "string" } }, required: ["kind"], type: "object" },
		}
		const text = typesOf(honeyDoc([{ input, method: "GET", pattern: "/kinds" }]))
		const union = compiled(text.match(/kind: ([^;}]+)/)?.[1] ?? "never")
		expect([syntaxErrors(text), [...union.values].sort()]).toEqual([[], [...values].sort()])
	})
})

describe("gen adversarial: an adversarial app compiles under strict", () => {
	// v0: 88a8924ee0
	it("types.gen.d.ts and the SDK files compile together, the augmentation narrowing selectors", async () => {
		const { typechecker } = (await import(
			resolve(REPO, "packages/gen/src/emit/ts/__fixtures__/typecheck.ts")
		)) as typeof import("../../src/emit/ts/__fixtures__/typecheck.ts")
		const tsMorph = await import("ts-morph")
		const kinds = { properties: { kind: { enum: ['a"b', "x\ny"], type: "string" } }, type: "object" }
		const app = honeyDoc([
			{ input: { search: kinds }, method: "GET", pattern: "/users/:user-id" },
			{ errors: { "rate-limited": { status: 429 } }, method: "POST", pattern: "/state" },
			{ method: "GET", pattern: "/files/*path" },
			{ method: "GET", pattern: "/then" },
		])
		const { files } = generateSdk(app.document, { name: "AdvSDK", stem: "adv" })
		const consumer = `import type { RouteSelectorOf } from "@lovrozagar/honey"
import type { RouteSelector } from "./types.gen"
import { AdvSDK } from "./adv.index.gen.ts"
expectType<Equal<RouteSelectorOf, RouteSelector>>()
expectType<"GET /users/:user-id" extends RouteSelectorOf ? true : false>()
expectType<"GET /no-such-route" extends RouteSelectorOf ? false : true>()
void new AdvSDK({ baseURL: "https://x" })`
		expect(typechecker(tsMorph)(typesOf(app), consumer, files)).toEqual([])
	})
})

type Api = { get(path: string, input?: object): Promise<{ error?: { message?: string } | null }> }

/** The emitted app front's `createClient`. */
const appFront = async () => ((await emittedApp()) as unknown as { createClient: (config: object) => Api }).createClient

describe("gen adversarial: the emitted TS runtime", () => {
	it("drops the auth header, cookies and configured headers on a cross-origin redirect hop", async () => {
		const { calls, fetch } = recordingFetch((request) =>
			request.url.startsWith("https://a.test")
				? new Response(null, { headers: { location: "https://b.test/x" }, status: 307 })
				: Response.json({}),
		)
		const createClient = await appFront()
		const headers = { authorization: "Bearer s3cret", cookie: "sid=1", "x-custom": "1" }
		await createClient({ baseURL: "https://a.test", fetch, headers, redirect: "follow" }).get("/start")
		const hop = calls[1]
		expect([
			calls.length,
			hop?.url,
			["authorization", "cookie", "x-custom"].map((name) => hop?.headers.get(name)),
		]).toEqual([2, "https://b.test/x", [null, null, null]])
	})

	it("never lets a path param add, drop or climb a segment", async () => {
		const { calls, fetch } = recordingFetch()
		const createClient = await appFront()
		const api = createClient({ baseURL: "https://a.test/v1", fetch })
		await api.get("/files/:id", { params: { id: "../admin" } })
		await api.get("/files/:id", { params: { id: "a/b" } })
		const climbed = await api.get("/files/:id", { params: { id: ".." } }).then(
			() => "sent",
			() => "refused",
		)
		expect([calls.map((r) => new URL(r.url).pathname), climbed]).toEqual([
			["/v1/files/..%2Fadmin", "/v1/files/a%2Fb"],
			"refused",
		])
	})

	it("keeps the query and the auth header out of every onLog entry and error message", async () => {
		const entries: unknown[] = []
		const { fetch } = recordingFetch((request) =>
			request.url.includes("/denied") ? Response.json({ message: "no access" }, { status: 401 }) : Response.json({}),
		)
		const createClient = await appFront()
		const api = createClient({
			baseURL: "https://a.test",
			fetch,
			headers: { authorization: "Bearer s3cret" },
			onLog: (e: unknown) => entries.push(e),
		})
		const search = { search: { api_key: "k3y" } }
		await api.get("/ok", search)
		const denied = await api.get("/denied", search)
		const seen = JSON.stringify([entries, denied.error])
		expect([seen.includes("s3cret"), seen.includes("k3y"), seen.includes("api_key")]).toEqual([false, false, false])
	})
})
