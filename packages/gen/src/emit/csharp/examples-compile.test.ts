/**
 * The docs' C# example (docs/examples/csharp/Example.cs) compiles with csc against an SDK generated from the docs' API,
 * and every C# block on a docs page is a verbatim excerpt of it (bit 20).
 */
import { describe, expect, it } from "vitest"
import { allBlocks, exampleOf, strayExcerpts } from "../shared/__fixtures__/docs-blocks.ts"
import { compiledCSharp } from "./__fixtures__/compiled.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"

const DOTNET = withDotnet()
const SLOW = { timeout: 600_000 }
const program = exampleOf("csharp", "Example.cs")

describe("the docs' C# example", () => {
	it("is where every C# block on a docs page comes from", () => {
		expect(strayExcerpts(allBlocks(), "csharp", program)).toEqual([])
	})

	it("reports a C# block the example does not hold", () => {
		const block = { at: "fixture.md:3", code: "var elsewhere = 1;\n", info: "csharp" }
		expect(strayExcerpts([block], "csharp", program)).toEqual(["fixture.md:3"])
	})

	it.skipIf(!DOTNET)("compiles against the generated SDK", SLOW, () => {
		expect(compiledCSharp("docs").check(program)).toEqual([])
	})
})
