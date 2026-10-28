/**
 * The provisional file-uploads extension behind its modules (bit 21 c, R5): the keyword marking a file argument is named
 * by emit/mcp/files.ts alone in all of gen (the schema), the extension's identifier by runtime/mcp/files.ts alone (the
 * values), so a change to the extension's draft stays in those two modules and their legs, which take the shape from
 * them. Every file git would see is read: tracked, and new ones not ignored.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const GEN = resolve(import.meta.dirname, "../..")
/* built, so this file names neither */
const KEYWORD = ["x", "mcp", "file"].join("-")
const IDENTIFIER = ["io.modelcontextprotocol", "files"].join("/")

/** Every file git would see in gen that holds `text`. */
function naming(text: string): string[] {
	return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
		cwd: GEN,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	})
		.split("\0")
		.filter((file) => file !== "" && readFileSync(join(GEN, file), "latin1").includes(text))
}

describe("the file-uploads extension's two modules", () => {
	it("names the extension's file keyword in emit/mcp/files.ts and nowhere else in gen", () => {
		expect(naming(KEYWORD)).toEqual(["src/emit/mcp/files.ts"])
	})

	it("names the extension's identifier in runtime/mcp/files.ts and nowhere else in gen", () => {
		expect(naming(IDENTIFIER)).toEqual(["src/runtime/mcp/files.ts"])
	})
})
