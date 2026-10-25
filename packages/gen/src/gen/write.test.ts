/**
 * A target's files written under its directory (bit 19 h1, carry-in #2): written only when they differ, through a
 * temp file renamed over each; a sha256 manifest; a regeneration deleting only what the last one listed, this one did
 * not emit, and nobody edited; every path confined and no symlink followed; no manifest, no deletion.
 */
import { createHash } from "node:crypto"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { MANIFEST, writeFileIfChanged, writeTarget } from "./write.ts"

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

/** A fresh directory for one leg. */
function scratch(): string {
	const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gen-write-"))
	dirs.push(dir)
	return dir
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
const ino = (path: string) => statSync(path).ino
/** A file's text, or null once it is gone. */
const contentOf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null)
const manifestOf = (dir: string) => (JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as { files: object }).files

describe("a generated file written only when its bytes differ (bit 19 h1)", () => {
	// v0: 38a7b3f64a — v1 (Q6): no checksum header; a file whose bytes differ from what this run emits is rewritten
	// v0: 4e331df29a — v1 (Q6): a truncated generated file is rewritten from what this run emits
	it("rewrites a truncated or conflict-marked file to exactly what this run emits", () => {
		const out = scratch()
		const text = "export const a = 1\nexport const b = 2\n"
		writeTarget(out, { "routes.gen.ts": text })
		const seen = []
		for (const damaged of ["export const a = 1\n", text.replace("b = 2", "<<<<<<< HEAD\nb = 3\n=======")]) {
			writeFileSync(join(out, "routes.gen.ts"), damaged)
			seen.push([writeTarget(out, { "routes.gen.ts": text }).written, readFileSync(join(out, "routes.gen.ts"), "utf8")])
		}
		expect(seen).toEqual([
			[["routes.gen.ts"], text],
			[["routes.gen.ts"], text],
		])
	})

	// v0: 5b67025e02
	it("does not touch an identical file", () => {
		const path = join(scratch(), "x.gen.ts")
		writeFileIfChanged(path, "x")
		const before = ino(path)
		expect([writeFileIfChanged(path, "x"), ino(path) === before]).toEqual([false, true])
	})

	// v0: 2aad3ab78f
	it("writes through a temp file renamed over the old one and leaves none behind", () => {
		const dir = scratch()
		writeFileIfChanged(join(dir, "a.txt"), "one")
		const before = ino(join(dir, "a.txt"))
		writeFileIfChanged(join(dir, "a.txt"), "two")
		expect([readdirSync(dir), readFileSync(join(dir, "a.txt"), "utf8"), ino(join(dir, "a.txt")) === before]).toEqual([
			["a.txt"],
			"two",
			false,
		])
	})

	// v0: 0c435ba6bd — v1 (Q6): a written document gains no top-level key (no in-file marker at all)
	it("writes a JSON document byte for byte, no key added", () => {
		const out = scratch()
		const doc = `${JSON.stringify({ info: { title: "T" }, openapi: "3.1.0" })}\n`
		writeTarget(out, { "openapi.json": doc })
		expect(readFileSync(join(out, "openapi.json"), "utf8")).toBe(doc)
	})
})

describe("a regeneration deletes only the stale files the last one wrote (bit 19 h1)", () => {
	// v0: 4837c0d5c0
	it("deletes what the previous run wrote and this one did not; never a file it never listed", () => {
		const out = scratch()
		writeTarget(out, { "cmd/root.go": "root", "cmd/users.go": "users", "go.mod": "mod" })
		writeFileSync(join(out, "README.md"), "hand-written")
		const second = writeTarget(out, { "cmd/root.go": "root", "go.mod": "mod" })
		expect({
			deleted: second.deleted,
			manifest: manifestOf(out),
			readme: contentOf(join(out, "README.md")),
			users: existsSync(join(out, "cmd/users.go")),
		}).toEqual({
			deleted: ["cmd/users.go"],
			manifest: { "cmd/root.go": sha256("root"), "go.mod": sha256("mod") },
			readme: "hand-written",
			users: false,
		})
	})

	// v0: 536b66b01d — v1: the ghost a removed resource left (a Go CLI's command file) goes with the next run
	it("leaves no ghost file for a removed operation", () => {
		const out = scratch()
		writeTarget(out, { "cmd/owners_cmds.go": "owners", "cmd/pets_cmds.go": "pets" })
		writeTarget(out, { "cmd/pets_cmds.go": "pets" })
		expect(readdirSync(join(out, "cmd"))).toEqual(["pets_cmds.go"])
	})

	// v0: 47f905c707
	it("removes the directories a deleted file leaves empty", () => {
		const out = scratch()
		writeTarget(out, { "pkg/__init__.py": "", "pkg/resources/users.py": "u" })
		writeTarget(out, { "pkg/__init__.py": "" })
		expect([existsSync(join(out, "pkg/resources")), existsSync(join(out, "pkg"))]).toEqual([false, true])
	})

	// v0: 830b6a4fa0
	it("does not rewrite unchanged files", () => {
		const out = scratch()
		writeTarget(out, { "src/lib.rs": "lib" })
		const before = ino(join(out, "src/lib.rs"))
		expect([writeTarget(out, { "src/lib.rs": "lib" }).written, ino(join(out, "src/lib.rs")) === before]).toEqual([
			[],
			true,
		])
	})
})

describe("a regeneration keeps what it cannot safely delete (bit 19 h1)", () => {
	// v0: 0e84e508c7
	it("goes on when the user deleted a stale file's directory", () => {
		const out = scratch()
		writeTarget(out, { "main.go": "package main\n", "models/x.go": "package models\n" })
		rmSync(join(out, "models"), { force: true, recursive: true })
		expect(() => writeTarget(out, { "main.go": "package main\n" })).not.toThrow()
		expect([manifestOf(out), existsSync(join(out, "models"))]).toEqual([{ "main.go": sha256("package main\n") }, false])
	})

	it("keeps a stale file edited since it was generated, and names it", () => {
		const out = scratch()
		writeTarget(out, { "a.ts": "a", "b.ts": "b" })
		writeFileSync(join(out, "b.ts"), "b, edited")
		const second = writeTarget(out, { "a.ts": "a" })
		expect([second.kept, contentOf(join(out, "b.ts"))]).toEqual([["b.ts"], "b, edited"])
	})

	it("deletes nothing without a manifest", () => {
		const out = scratch()
		writeFileSync(join(out, "old.ts"), "old")
		expect([writeTarget(out, { "new.ts": "new" }).deleted, existsSync(join(out, "old.ts"))]).toEqual([[], true])
	})

	it("reads a manifest whose files are no object as none, deleting nothing", () => {
		const kept = ['{"files":["old.ts"]}', '{"files":null}', '{"files":"old.ts"}', "not json"].map((manifest) => {
			const out = scratch()
			writeFileSync(join(out, "old.ts"), "old")
			writeFileSync(join(out, MANIFEST), manifest)
			return [writeTarget(out, { "new.ts": "new" }).deleted, existsSync(join(out, "old.ts"))]
		})
		expect(kept).toEqual(Array.from({ length: 4 }, () => [[], true]))
	})
})

describe("every path stays under the target's directory, no symlink followed (bit 19 h1)", () => {
	// v0: cd0a0e0c3e
	it("refuses a path that escapes the directory, writing nothing", () => {
		const root = scratch()
		const out = join(root, "cli")
		expect(() => writeTarget(out, { "../escaped.go": "x" })).toThrow(/escapes/)
		expect(() => writeTarget(out, { "/etc/passwd": "x" })).toThrow(/escapes/)
		expect(readdirSync(root)).toEqual([])
	})

	it("refuses a symlink in a written path and never deletes through one", () => {
		const out = scratch()
		const elsewhere = scratch()
		writeFileSync(join(elsewhere, "keep.txt"), "theirs")
		mkdirSync(join(out, "real"))
		symlinkSync(elsewhere, join(out, "link"))
		expect(() => writeTarget(out, { "link/keep.txt": "ours" })).toThrow(/symlink/)
		writeFileSync(
			join(out, MANIFEST),
			JSON.stringify({ files: { "../x": sha256("x"), "link/keep.txt": sha256("theirs") } }),
		)
		const run = writeTarget(out, { "real/a.ts": "a" })
		expect([run.deleted, run.kept.sort(), readFileSync(join(elsewhere, "keep.txt"), "utf8")]).toEqual([
			[],
			["../x", "link/keep.txt"],
			"theirs",
		])
	})
})
