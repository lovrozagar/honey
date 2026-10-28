import { describe, expect, it } from "vitest"
import * as z from "zod"
import { type StatusKey, statusKeyToCode } from "../response/status.ts"
import { honey } from "../routing/app.ts"
import { createNode, insertRoute, type RouteEntry, type RouteTree } from "../routing/tree.ts"
import { generateOpenApi } from "./generate.ts"
import { assertTreeOutputKeys } from "./output-keys.ts"

const STATUSES = Object.keys(statusKeyToCode).join(", ")
const INFO = { title: "T", version: "1" }

/** A tree of one `GET /o` route holding `entry`. */
function treeOf(entry: RouteEntry): RouteTree {
	const root = createNode()
	return { meta: {}, root, routes: { [insertRoute(root, "GET", "/o")]: entry }, v: 2 }
}

/** An app whose `GET /o` declares `output`, a JS app's or a cast's: the types refuse a bad key, `.output()` takes it. */
function declaring(output: object, method: "get" | "post" = "get") {
	const app = honey<{}>()
	app[method]("/o")
		.output(output as never)
		.handler((c) => c.res.noContent())
	return app
}

/** Documenting `app`, deferred. */
const documenting = (app: ReturnType<typeof declaring>) => () => generateOpenApi(app, { info: INFO })

describe("generateOpenApi: every output key a media type or a status", () => {
	it("refuses a key that names no status, under a media type, headers or redirect, naming it and every status", () => {
		const refusals = [
			[{ "application/json": { orders: z.string() } }, '"orders" under application/json'],
			[{ "text/plain": { __proto__: null, toString: true } }, '"toString" under text/plain'],
			[{ "application/json": { ok: z.string() }, headers: { 200: z.object({}) } }, '"200" under headers'],
			[{ redirect: { OK: true } }, '"OK" under redirect'],
		] as const
		for (const [output, named] of refusals)
			expect(documenting(declaring(output))).toThrow(`GET /o: .output() key ${named} is none of ${STATUSES}`)
	})

	it("refuses an outer key that is no media type, headers or redirect", () => {
		expect(documenting(declaring({ orders: { ok: z.string() } }, "post"))).toThrow(
			'POST /o: .output() key "orders" is no type/subtype, headers or redirect',
		)
	})

	it("takes every status under any media type, headers and redirect, and a headers or redirect left undefined", () => {
		const statuses = Object.fromEntries(Object.keys(statusKeyToCode).map((key) => [key, true]))
		const declared = [
			{ "image/gif": statuses, headers: { ok: z.object({}) }, redirect: { found: true } },
			{ "application/json": { ok: z.string() }, headers: undefined, redirect: undefined },
		]
		for (const output of declared) expect(documenting(declaring(output))).not.toThrow()
	})
})

describe("generateOpenApi: a response is keyed by its status code, never by a name", () => {
	it("documents every status key .output() takes, as a body, its headers and a redirect, under its code alone", () => {
		const keys = Object.keys(statusKeyToCode) as StatusKey[]
		const app = honey<{}>()
		for (const key of keys)
			app
				.get(`/${key}`)
				.output({
					"application/json": { [key]: z.string() },
					headers: { [key]: z.object({ "x-a": z.string() }) },
					redirect: { [key]: true },
				} as never)
				.handler((c) => c.res.noContent())
		const doc = generateOpenApi(app, { info: INFO })
		const named = keys.map((key) => [key, Object.keys(doc.paths[`/${key}`]?.get?.responses ?? {})])
		expect(named).toEqual(keys.map((key) => [key, [String(statusKeyToCode[key])]]))
	})

	it("documents no answer under a name: a route's or a loaded tree's output is keyed by code and media type", () => {
		const smuggled = [
			{ "application/json": { orders: z.string() } },
			{ "application/json": { ok: z.string() }, headers: { orders: z.object({}) } },
			{ redirect: { orders: true } },
			{ orders: { ok: z.string() } },
		]
		const apps = smuggled.flatMap((out) => [declaring(out), honey<{}>().routeTree(treeOf({ out: out as never }))])
		const named = apps.flatMap((app) => {
			let responses: object
			/* a refused document documents nothing */
			try {
				responses = generateOpenApi(app, { info: INFO }).paths["/o"]?.get?.responses ?? {}
			} catch {
				return []
			}
			return Object.entries(responses).flatMap(([code, response]) => [
				...(/^[1-5][0-9]{2}$/.test(code) ? [] : [code]),
				...Object.keys((response as { content?: object }).content ?? {}).filter((media) => !media.includes("/")),
			])
		})
		expect(named).toEqual([])
	})
})

describe("assertTreeOutputKeys: the tree generation writes", () => {
	it("refuses a route whose output holds a key that names no status, and takes a tree without one", () => {
		expect(() =>
			assertTreeOutputKeys(treeOf({ out: { "application/json": { orders: z.string() } } as never })),
		).toThrow('GET /o: .output() key "orders" under application/json is none of')
		for (const entry of [{ out: { "application/json": { ok: z.string() } } }, { out: null }, {}])
			expect(() => assertTreeOutputKeys(treeOf(entry))).not.toThrow()
	})
})
