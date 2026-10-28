/**
 * The docs' Java example (docs/examples/java/Example.java) compiles and runs (it returns at once without a base URL)
 * against an SDK generated from the docs' API, and every Java block on a docs page is a verbatim excerpt of it (bit 20).
 */
import { describe, expect, it } from "vitest"
import { allBlocks, docsDocument, exampleOf, strayExcerpts } from "../shared/__fixtures__/docs-blocks.ts"
import { compiledJavaSdk } from "./__fixtures__/compiled.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { generateJavaSdk } from "./sdk.ts"

const JAVA = withJava()
const SLOW = { timeout: 600_000 }
const program = exampleOf("java", "Example.java")

describe("the docs' Java example", () => {
	it("is where every Java block on a docs page comes from", () => {
		expect(strayExcerpts(allBlocks(), "java", program)).toEqual([])
	})

	it("reports a Java block the example does not hold", () => {
		const block = { at: "fixture.md:3", code: "int elsewhere = 1;\n", info: "java" }
		expect(strayExcerpts([block], "java", program)).toEqual(["fixture.md:3"])
	})

	it.skipIf(!JAVA)("compiles and runs against the generated SDK", SLOW, () => {
		const options = { clientName: "KitchenClient", packageName: "com.example.kitchen" }
		const ran = compiledJavaSdk(generateJavaSdk(docsDocument(), options).files).run("Example", program)
		expect([ran.status, ran.status === 0 ? "" : ran.stderr]).toEqual([0, ""])
	})
})
