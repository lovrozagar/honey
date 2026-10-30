/**
 * The A/B gate's side seam (bit 22 a1): a side is loaded from its own root, two roots are two module graphs, and a
 * relative import inside a side resolves inside that side. The identity legs run over two synthetic roots, so they
 * are deterministic and need no second checkout; the real tree is loaded too, so the namespace shape is head's own.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { baseRootOf, HEAD_ROOT, sideOf } from "./side.ts"

const dirs: string[] = []
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

/**
 * A root holding the smallest honey tree `sideOf` reads, every module tagged `tag`, with `app.ts` importing its
 * sibling `dispatch.ts` by a relative path: the import that must not leave the root.
 */
function root(tag: string): string {
	const dir = mkdtempSync(join(tmpdir(), "honey-side-"))
	dirs.push(dir)
	const src = join(dir, "packages/core/src")
	mkdirSync(join(src, "routing"), { recursive: true })
	mkdirSync(join(src, "middleware"), { recursive: true })
	writeFileSync(
		join(src, "routing/app.ts"),
		`import { finalTable } from "./dispatch.ts"\n` +
			`export const GRAPH = "${tag}"\n` +
			`export class Marker {}\n` +
			`export const honey = () => ({ tag: "${tag}", table: finalTable, marker: Marker })\n`,
	)
	writeFileSync(join(src, "routing/dispatch.ts"), `export const finalTable = () => "${tag}"\n`)
	writeFileSync(join(src, "middleware/middleware.ts"), `export const createMiddleware = () => "${tag}"\n`)
	writeFileSync(join(src, "middleware/cors.ts"), `export const cors = () => "${tag}"\n`)
	writeFileSync(join(src, "middleware/request-id.ts"), `export const requestId = () => "${tag}"\n`)
	writeFileSync(join(src, "middleware/secure-headers.ts"), `export const secureHeaders = () => "${tag}"\n`)
	return dir
}

describe("a side is loaded from its own root", () => {
	it("refuses a root with no honey tree, naming it", async () => {
		const empty = mkdtempSync(join(tmpdir(), "honey-side-"))
		dirs.push(empty)
		await expect(sideOf(empty)).rejects.toThrow(`${empty} holds no packages/core/src/routing/app.ts`)
	})

	it("loads head's own tree, every member a function and the root reported", async () => {
		const head = await sideOf(HEAD_ROOT)
		expect({
			kinds: [head.cors, head.createMiddleware, head.finalTable, head.honey, head.requestId, head.secureHeaders].map(
				(member) => typeof member,
			),
			root: head.root,
		}).toEqual({ kinds: ["function", "function", "function", "function", "function", "function"], root: HEAD_ROOT })
	})

	it("serves a request from head's side, so the namespace is honey's and not a shape", async () => {
		const { honey } = await sideOf(HEAD_ROOT)
		const app = honey()
		app.get("/x").handler((ctx) => ctx.res.text("ok", "k"))
		const res = await app.fetch(new Request("http://bench.local/x"), {})
		expect([res.status, await res.text()]).toEqual([200, "k"])
	})
})

describe("two roots are two module graphs", () => {
	it("gives each side its own members, never the other's", async () => {
		const [a, b] = await Promise.all([sideOf(root("a")), sideOf(root("b"))])
		expect(a.honey).not.toBe(b.honey)
		expect(a.createMiddleware).not.toBe(b.createMiddleware)
		expect(a.finalTable).not.toBe(b.finalTable)
		expect([a.GRAPH, b.GRAPH]).toEqual(["a", "b"])
		expect([a.createMiddleware(), b.createMiddleware()]).toEqual(["a", "b"])
	})

	it("keeps a side's relative import inside its own root, at a depth the loader never names", async () => {
		const [a, b] = await Promise.all([sideOf(root("a")), sideOf(root("b"))])
		/* app.ts imports ./dispatch.ts itself: the value each side's honey() closes over is its own tree's */
		expect([a.honey().table(), b.honey().table()]).toEqual(["a", "b"])
	})

	it("gives each side its own classes, so an instance of one is not the other's", async () => {
		const [a, b] = await Promise.all([sideOf(root("a")), sideOf(root("b"))])
		const marker = a.honey().marker as new () => object
		const other = b.honey().marker as new () => object
		expect(marker).not.toBe(other)
		expect(new marker() instanceof other).toBe(false)
	})

	it("loads one root twice as one graph, so a side costs its load once", async () => {
		const one = root("a")
		const [first, second] = await Promise.all([sideOf(one), sideOf(one)])
		expect(first.honey).toBe(second.honey)
	})
})

describe("the base side's root", () => {
	it("is PERF_BASE_DIR when set, absolute, and undefined when the run measures head alone", () => {
		expect(baseRootOf({})).toBeUndefined()
		expect(baseRootOf({ PERF_BASE_DIR: "" })).toBeUndefined()
		expect(baseRootOf({ PERF_BASE_DIR: "/tmp/base" })).toBe("/tmp/base")
		expect(baseRootOf({ PERF_BASE_DIR: "." })).toBe(process.cwd())
	})
})
