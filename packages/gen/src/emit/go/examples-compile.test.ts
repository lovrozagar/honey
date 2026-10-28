/**
 * The docs' Go example (docs/examples/go/example.go) builds and vets against an SDK generated from the docs' API, and
 * every Go block on a docs page is a verbatim excerpt of it (bit 20).
 */
import { describe, expect, it } from "vitest"
import { allBlocks, docsDocument, exampleOf, strayExcerpts } from "../shared/__fixtures__/docs-blocks.ts"
import { compileGo } from "./__fixtures__/compiled.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { generateGoSdk } from "./sdk.ts"

const GO = withGo()
const SLOW = { timeout: 600_000 }
const program = exampleOf("go", "example.go")

describe("the docs' Go example", () => {
	it("is where every Go block on a docs page comes from", () => {
		expect(strayExcerpts(allBlocks(), "go", program)).toEqual([])
	})

	it("reports a Go block the example does not hold", () => {
		const block = { at: "fixture.md:3", code: 'fmt.Println("elsewhere")\n', info: "go" }
		expect(strayExcerpts([block], "go", program)).toEqual(["fixture.md:3"])
	})

	// v0: 2ef25d029e
	it.skipIf(!GO)("builds and vets against the generated SDK", SLOW, () => {
		const built = compileGo(generateGoSdk(docsDocument()).files, { main: program })
		expect([built.built, built.vet, built.built ? "" : built.stderr]).toEqual([true, [], ""])
	})
})
