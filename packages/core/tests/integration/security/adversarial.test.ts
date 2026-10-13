/**
 * The in-process adversarial suite (F1, 00-rules "Security gate"): hostile inputs driven through
 * `app.fetch`, each a failing input first and the guard that answers it second. Every middleware
 * bit adds its cases; the mutation harness reruns this file with each guard disabled and requires
 * it to go red.
 */
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { guardNamed } from "../../structure/mutation-harness.ts"

const REPO = resolve(import.meta.dirname, "../../../../..")

const mutant = guardNamed(process.env.HONEY_MUTANT)
if (mutant !== undefined) {
	vi.doMock(resolve(REPO, mutant.module), async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>()
		return { ...original, ...mutant.disable(original) }
	})
}

/* the app under test is v0 until the cutover swap (H21); each bit retargets its cases as v1 lands */
const { honey } = (await import(resolve(REPO, "_v0/src/index.ts"))) as typeof import("../../../../../_v0/src/index.ts")

function filesApp() {
	return honey()
		.get("/files/:name")
		.handler((ctx) => ctx.res.json("ok", { name: ctx.params.name }))
}

async function fetchPath(path: string): Promise<Response> {
	return filesApp().fetch(new Request(`http://app.test${path}`), {})
}

describe("adversarial: scope bypass via path normalization", () => {
	it("serves an ordinary param", async () => {
		const res = await fetchPath("/files/report")
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ name: "report" })
	})

	it("rejects an encoded / before it can reach a param", async () => {
		expect((await fetchPath("/files/x%2F..%2Fsecret")).status).toBe(400)
		expect((await fetchPath("/files/x%2f..%2fsecret")).status).toBe(400)
	})

	it("rejects an encoded \\ the same way", async () => {
		expect((await fetchPath("/files/a%5Cb")).status).toBe(400)
	})

	it("resolves dot segments before matching, so they never escape the route", async () => {
		expect((await fetchPath("/files/../admin")).status).toBe(404)
	})
})
