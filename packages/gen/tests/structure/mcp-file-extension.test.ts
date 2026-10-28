/**
 * The provisional file-uploads extension behind its modules (bit 21 c, R5): the keyword marking a file argument is named
 * by emit/mcp/files.ts alone in all of gen (the schema; runtime/mcp/files.ts reads the values), so a change to the
 * extension's draft stays in those two modules and their legs, which take the shape from them. Every file git would
 * see is read: tracked, and new ones not ignored.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const GEN = resolve(import.meta.dirname, "../..")
/* built, so this file does not name it */
const KEYWORD = ["x", "mcp", "file"].join("-")

describe("the file-uploads extension's one module", () => {
	it("names the extension's file keyword in emit/mcp/files.ts and nowhere else in gen", () => {
		const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			cwd: GEN,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		})
			.split("\0")
			.filter(Boolean)
		const naming = files.filter((file) => readFileSync(join(GEN, file), "latin1").includes(KEYWORD))
		expect(naming).toEqual(["src/emit/mcp/files.ts"])
	})
})
