import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	OUTPUT_MANIFEST,
	writeFileIfChanged,
	writeGenFile,
	writeGenJsonFile,
	writeOutputDir,
} from "../../../src/gen-write.ts"

const TMP = resolve(import.meta.dirname, "../../../.tmp-gen-write")

beforeEach(() => {
	rmSync(TMP, { force: true, recursive: true })
	mkdirSync(TMP, { recursive: true })
})

afterEach(() => {
	rmSync(TMP, { force: true, recursive: true })
})

describe("generated file writes", () => {
	it("repairs a file whose header checksum matches but whose body is damaged", () => {
		const path = join(TMP, "routes.gen.ts")
		writeGenFile(path, "export const a = 1\nexport const b = 2\n", "honey")
		const good = readFileSync(path, "utf-8")
		/* truncated after the header, and a conflict-marked copy */
		for (const damaged of [good.split("\n")[0] as string, good.replace("b = 2", "<<<<<<< HEAD\nb = 3\n=======")]) {
			writeFileSync(path, damaged)
			expect(writeGenFile(path, "export const a = 1\nexport const b = 2\n", "honey")).toBe(true)
			expect(readFileSync(path, "utf-8")).toBe(good)
		}
	})

	it("does not touch an identical file", async () => {
		const path = join(TMP, "x.gen.ts")
		writeGenFile(path, "x", "honey")
		const before = statSync(path).mtimeMs
		await new Promise((r) => setTimeout(r, 20))
		expect(writeGenFile(path, "x", "honey")).toBe(false)
		expect(statSync(path).mtimeMs).toBe(before)
	})

	it("writes through a temp file and leaves none behind", () => {
		writeFileIfChanged(join(TMP, "a.txt"), "one")
		writeFileIfChanged(join(TMP, "a.txt"), "two")
		expect(readdirSync(TMP)).toEqual(["a.txt"])
		expect(readFileSync(join(TMP, "a.txt"), "utf-8")).toBe("two")
	})

	it("marks JSON documents with an x- extension key, so strict OpenAPI validators accept them", () => {
		const path = join(TMP, "openapi.gen.json")
		writeGenJsonFile(path, { info: { title: "T" }, openapi: "3.1.0" }, "honey")
		const doc = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
		expect(doc["x-generated"]).toMatch(/^honey checksum:/)
		expect(Object.keys(doc).filter((k) => !k.startsWith("x-") && !["info", "openapi"].includes(k))).toEqual([])
	})
})

describe("writeOutputDir", () => {
	it("deletes files the previous run wrote and this run did not", () => {
		const out = join(TMP, "sdk")
		writeOutputDir(out, { "cmd/root.go": "root", "cmd/users.go": "users", "go.mod": "mod" })
		writeFileSync(join(out, "README.md"), "hand-written")
		writeOutputDir(out, { "cmd/root.go": "root", "go.mod": "mod" })
		expect(existsSync(join(out, "cmd/users.go"))).toBe(false)
		expect(existsSync(join(out, "cmd/root.go"))).toBe(true)
		/* never listed, so never deleted */
		expect(readFileSync(join(out, "README.md"), "utf-8")).toBe("hand-written")
		const manifest = JSON.parse(readFileSync(join(out, OUTPUT_MANIFEST), "utf-8")) as { files: string[] }
		expect(manifest.files).toEqual(["cmd/root.go", "go.mod"])
	})

	it("removes directories a deleted file leaves empty", () => {
		const out = join(TMP, "py")
		writeOutputDir(out, { "pkg/resources/users.py": "u", "pkg/__init__.py": "" })
		writeOutputDir(out, { "pkg/__init__.py": "" })
		expect(existsSync(join(out, "pkg/resources"))).toBe(false)
		expect(existsSync(join(out, "pkg"))).toBe(true)
	})

	it("does not rewrite unchanged files", async () => {
		const out = join(TMP, "rs")
		writeOutputDir(out, { "src/lib.rs": "lib" })
		const before = statSync(join(out, "src/lib.rs")).mtimeMs
		await new Promise((r) => setTimeout(r, 20))
		writeOutputDir(out, { "src/lib.rs": "lib" })
		expect(statSync(join(out, "src/lib.rs")).mtimeMs).toBe(before)
	})

	it("refuses paths that escape the output directory", () => {
		const out = join(TMP, "cli")
		expect(() => writeOutputDir(out, { "../escaped.go": "x" })).toThrow(/escapes/)
		expect(() => writeOutputDir(out, { "/etc/passwd": "x" })).toThrow(/escapes/)
		expect(existsSync(join(TMP, "escaped.go"))).toBe(false)
	})
})
