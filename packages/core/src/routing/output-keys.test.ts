import { describe, expect, it } from "vitest"
import * as z from "zod"
import { generateOpenApi } from "../openapi/generate.ts"
import { type StatusKey, statusKeyToCode } from "../response/status.ts"
import { honey } from "./app.ts"
import { createNode, insertRoute, type RouteEntry, type RouteTree } from "./tree.ts"

const STATUSES = Object.keys(statusKeyToCode).join(", ")
const INFO = { title: "T", version: "1" }

/** A tree of one `GET /o` route holding `entry`. */
function treeOf(entry: RouteEntry): RouteTree {
	const root = createNode()
	return { meta: {}, root, routes: { [insertRoute(root, "GET", "/o")]: entry }, v: 2 }
}

/** Declaring `output` on `GET /o`, deferred. */
const declare = (output: object) => () =>
	honey<{}>()
		.get("/o")
		.output(output as never)

describe(".output(): every key a media type or a status", () => {
	it("refuses a key that names no status, under a media type, headers or redirect, naming it and every status", () => {
		const refusals = [
			[{ "application/json": { orders: z.string() } }, '"orders" under application/json'],
			[{ "text/plain": { __proto__: null, toString: true } }, '"toString" under text/plain'],
			[{ "application/json": { ok: z.string() }, headers: { 200: z.object({}) } }, '"200" under headers'],
			[{ redirect: { OK: true } }, '"OK" under redirect'],
		] as const
		for (const [output, named] of refusals)
			expect(() =>
				honey<{}>()
					.get("/o")
					.output(output as never),
			).toThrow(`GET /o: .output() key ${named} is none of ${STATUSES}`)
	})

	it("refuses an outer key that is no media type, headers or redirect", () => {
		expect(() =>
			honey<{}>()
				.post("/o")
				.output({ orders: { ok: z.string() } } as never),
		).toThrow('POST /o: .output() key "orders" is no type/subtype, headers or redirect')
	})

	it("takes every status under any media type, headers and redirect, and a headers or redirect left undefined", () => {
		const statuses = Object.fromEntries(Object.keys(statusKeyToCode).map((key) => [key, true]))
		expect(declare({ "image/gif": statuses, headers: { ok: z.object({}) }, redirect: { found: true } })).not.toThrow()
		expect(declare({ "application/json": { ok: z.string() }, headers: undefined, redirect: undefined })).not.toThrow()
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

	it("documents no answer under a name: what .output() or a loaded tree takes is keyed by code and media type", () => {
		const smuggled = [
			{ "application/json": { orders: z.string() } },
			{ "application/json": { ok: z.string() }, headers: { orders: z.object({}) } },
			{ redirect: { orders: true } },
			{ orders: { ok: z.string() } },
		]
		const defined = smuggled.flatMap((out) => {
			const apps = []
			/* a refused declaration leaves nothing to document */
			try {
				const app = honey<{}>()
				app
					.get("/o")
					.output(out as never)
					.handler((c) => c.res.noContent())
				apps.push(app)
			} catch {}
			/* a refused tree leaves nothing to document */
			try {
				apps.push(honey<{}>().routeTree(treeOf({ out: out as never })))
			} catch {}
			return apps
		})
		const named = defined.flatMap((app) =>
			Object.entries(generateOpenApi(app, { info: INFO }).paths["/o"]?.get?.responses ?? {}).flatMap(
				([code, response]) => [
					...(/^[1-5][0-9]{2}$/.test(code) ? [] : [code]),
					...Object.keys((response as { content?: object }).content ?? {}).filter((media) => !media.includes("/")),
				],
			),
		)
		expect(named).toEqual([])
	})
})
