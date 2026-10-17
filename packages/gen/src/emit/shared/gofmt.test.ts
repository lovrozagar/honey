import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { goCacheDir, gofmtPath, withGo } from "../go/__fixtures__/go-env.ts"
import { formatFiles } from "./format.ts"
import { gofmtFormatter } from "./gofmt.ts"

const UNFORMATTED = "package sdk\nfunc  Add(a int,b int) int{ return a+b }\n"
const FORMATTED = "package sdk\n\nfunc Add(a int, b int) int { return a + b }\n"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()

describe("gofmtFormatter: the Go post-pass (R2)", () => {
	it.skipIf(!GO)("formats a Go file with the pinned gofmt and leaves any other file as it is", async () => {
		const files = await formatFiles(
			{ "a.go": UNFORMATTED, "go.mod": "module x\n" },
			{ go: gofmtFormatter(gofmtPath()) },
		)
		expect(files).toEqual({ "a.go": FORMATTED, "go.mod": "module x\n" })
	})

	it.skipIf(!GO)("reports a file gofmt cannot parse as an error, naming it", async () => {
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

	it("answers with its stderr when the binary closes its input and exits later", async () => {
		/* the write fails while the binary still runs: the pipe error is ignored, the exit status answers */
		const dir = mkdtempSync(join(goCacheDir("tmp"), "gofmt-closes-"))
		const bin = join(dir, "gofmt")
		writeFileSync(bin, "#!/bin/sh\nexec 0<&-\necho closed >&2\nsleep 1\nexit 3\n", { mode: 0o755 })
		try {
			const source = `package sdk\n// ${"x".repeat(1 << 22)}\n`
			const { code, errors } = await gofmtFormatter(bin)("big.go", source, {
				printWidth: 120,
				semi: false,
				useTabs: true,
			})
			expect([code === source, errors]).toEqual([true, ["closed"]])
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})
