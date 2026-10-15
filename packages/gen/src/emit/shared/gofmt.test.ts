import { describe, expect, it } from "vitest"
import { goRequired, gofmtPath, hasGo } from "../go/__fixtures__/go-env.ts"
import { formatFiles } from "./format.ts"
import { gofmtFormatter } from "./gofmt.ts"

const UNFORMATTED = "package sdk\nfunc  Add(a int,b int) int{ return a+b }\n"
const FORMATTED = "package sdk\n\nfunc Add(a int, b int) int { return a + b }\n"

/* Go absent passes locally and fails where it is required (CI, the pre-push battery) */
const go = hasGo()

describe("gofmtFormatter: the Go post-pass (R2)", () => {
	it("formats a Go file with the pinned gofmt and leaves any other file as it is", async () => {
		expect(go || !goRequired()).toBe(true)
		if (!go) return
		const files = await formatFiles(
			{ "a.go": UNFORMATTED, "go.mod": "module x\n" },
			{ go: gofmtFormatter(gofmtPath()) },
		)
		expect(files).toEqual({ "a.go": FORMATTED, "go.mod": "module x\n" })
	})

	it("reports a file gofmt cannot parse as an error, naming it", async () => {
		expect(go || !goRequired()).toBe(true)
		if (!go) return
		await expect(
			formatFiles({ "bad.go": "package sdk\nfunc (\n" }, { go: gofmtFormatter(gofmtPath()) }),
		).rejects.toThrow(/could not format bad\.go/)
	})

	it("reports a gofmt it cannot run as an error rather than passing the file through", async () => {
		const { errors } = await gofmtFormatter("/nonexistent/gofmt")("a.go", UNFORMATTED, {
			printWidth: 120,
			semi: false,
			useTabs: true,
		})
		expect(errors.length).toBe(1)
	})
})

describe("gofmtFormatter: a gofmt that stops reading", () => {
	it("answers with its failure when the binary exits before taking the input", async () => {
		const source = `package sdk\n// ${"x".repeat(1 << 22)}\n`
		const { code, errors } = await gofmtFormatter("false")("big.go", source, {
			printWidth: 120,
			semi: false,
			useTabs: true,
		})
		expect([code === source, errors.length]).toEqual([true, 1])
	})
})
