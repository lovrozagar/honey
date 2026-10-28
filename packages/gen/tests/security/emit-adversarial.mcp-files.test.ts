/**
 * The MCP server's file arguments against hostile values (bit 21 c), the runtime's own modules run in process.
 * A path: read only inside the hard root after every symlink resolves, so `..` chains, absolute paths outside, a
 * symlink or a chain of them out (a last link or a directory), and a directory swapped for a link out between the check
 * and the open (device and inode compared) are refused. Only a regular file is read: a directory, a FIFO, a socket, a
 * device, a /proc file whose size lies. A file is read to its size and no byte more, past the cap refused, one that
 * grows mid-read refused. A path is never percent-decoded; a NUL byte names no file. No refusal names a path. Inline
 * data: canonical base64 alone (no padding fault, whitespace, data: URI or base64url), decoded to its declared size,
 * its digest checked, the call's inline bytes capped together. The race and the growth are made deterministic through
 * the reader's Disk seam, never a hook in production code. A file argument's schema and a prototype-named key in a
 * file are the emitter's files.test.ts's: this file reaches the runtime alone, as the gen mutation harness requires.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { open, realpath, stat } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { fileOf, type Read } from "../../src/runtime/mcp/files.ts"
import { type Disk, fileReader } from "../../src/runtime/mcp/reader.ts"
import { SPAWN_TIMEOUT } from "../../src/gen/__fixtures__/spawn-timeout.ts"

const HOME = join(process.env.HOME ?? "", ".cache/honey-tmp/gen-mcp")
const NODE_DISK: Disk = { open, realpath, stat }

/** A fresh tree: the root with its files, links, FIFO and socket, and a directory outside it holding secrets. */
function tree() {
	mkdirSync(HOME, { recursive: true })
	const base = mkdtempSync(join(HOME, "files-"))
	const [root, outside] = [join(base, "root"), join(base, "outside")]
	for (const dir of [root, outside, join(root, "dir"), join(root, "swap"), join(outside, "swap")])
		mkdirSync(dir, { recursive: true })
	writeFileSync(join(root, "a.txt"), "abc")
	writeFileSync(join(root, "four.txt"), "abcd")
	writeFileSync(join(root, "two.txt"), "ab")
	writeFileSync(join(root, "100%2e.txt"), "literal")
	writeFileSync(join(root, "swap", "b.txt"), "in")
	writeFileSync(join(outside, "secret.txt"), "secret")
	writeFileSync(join(outside, "swap", "b.txt"), "out")
	symlinkSync(join(outside, "secret.txt"), join(root, "out-file"))
	symlinkSync(outside, join(root, "out-dir"))
	symlinkSync(join(root, "chain-2"), join(root, "chain-1"))
	symlinkSync(join(outside, "secret.txt"), join(root, "chain-2"))
	symlinkSync(join(root, "a.txt"), join(root, "in-link"))
	spawnSync("mkfifo", [join(root, "fifo")])
	return { base, outside, root }
}

let made: ReturnType<typeof tree>
const socket = createServer()
beforeAll(async () => {
	made = tree()
	await new Promise<void>((listening) => socket.listen(join(made.root, "sock"), listening))
}, SPAWN_TIMEOUT)
afterAll(() => new Promise<void>((closed) => socket.close(() => closed())))

/** What reading `path` under `root` (capped at `max`, through `disk`) gives: its text, or the rule that refused it. */
async function readOf(path: string, root = made.root, max = 1000, disk = NODE_DISK): Promise<string> {
	const read = fileReader(root, max, disk) as Read
	try {
		return `read ${new TextDecoder().decode(await read(path))}`
	} catch (error) {
		return (error as Error).message
	}
}

describe("a path stays inside the hard root, after every symlink (R7)", () => {
	it.each([
		["a.txt", "read abc"],
		["dir/../a.txt", "read abc"],
		["in-link", "read abc"],
		["../outside/secret.txt", "leaves the file root"],
		["dir/../../outside/secret.txt", "leaves the file root"],
		["../../../../../../../../etc/passwd", "leaves the file root"],
		["/etc/passwd", "leaves the file root"],
		["out-file", "leaves the file root"],
		["out-dir/secret.txt", "leaves the file root"],
		["chain-1", "leaves the file root"],
		["/dev/zero", "leaves the file root"],
		["/proc/self/environ", "leaves the file root"],
		["", "leaves the file root"],
		["100%2e.txt", "read literal"],
		["%2e%2e/outside/secret.txt", "names no file under the file root"],
		["..%2foutside%2fsecret.txt", "names no file under the file root"],
		["a.txt\0../../outside/secret.txt", "names no file under the file root"],
		["missing.txt", "names no file under the file root"],
	])("reads %j as %j", async (path, outcome) => {
		expect(await readOf(path)).toBe(outcome)
	})

	it("refuses an absolute path outside the root and reads one inside it", async () => {
		expect([await readOf(join(made.outside, "secret.txt")), await readOf(join(made.root, "a.txt"))]).toEqual([
			"leaves the file root",
			"read abc",
		])
	})

	it("takes the root itself from realpath: a root reached through a link holds what its target holds", async () => {
		const linked = join(made.base, "root-link")
		symlinkSync(made.root, linked)
		expect([await readOf("a.txt", linked), await readOf("../outside/secret.txt", linked)]).toEqual([
			"read abc",
			"leaves the file root",
		])
	})

	it("has no reader for a root that is no directory, or none at all", () => {
		expect([fileReader(join(made.root, "a.txt"), 1), fileReader(join(made.base, "none"), 1)]).toEqual([
			undefined,
			undefined,
		])
	})
})

describe("only a regular file is read, opened and checked by its descriptor", () => {
	it.each([
		["dir", "is no regular file"],
		["fifo", "is no regular file"],
		["sock", "is no regular file"],
	])("refuses %s: %s", async (path, outcome) => {
		expect(await readOf(path)).toBe(outcome)
	})

	it("refuses a device, a /proc file whose size lies, and standard input under the root /", async () => {
		const stdin = await readOf("/dev/stdin", "/")
		expect([await readOf("/dev/zero", "/"), await readOf("/proc/self/environ", "/")]).toEqual([
			"is no regular file",
			"changed while it was read",
		])
		/* whatever this worker's stdin is (a pipe resolves to no file, a device or terminal is none), it is never read */
		expect(["names no file under the file root", "is no regular file"]).toContain(stdin)
		expect(["names no file under the file root", "is no regular file"]).toContain(await readOf("/proc/self/fd/0", "/"))
	})

	it("refuses a directory swapped for a link out between realpath and the open: not the file it checked", async () => {
		const swapping: Disk = {
			...NODE_DISK,
			open: (async (path: string, flags: number) => {
				renameSync(join(made.root, "swap"), join(made.base, "swapped-out"))
				symlinkSync(join(made.outside, "swap"), join(made.root, "swap"))
				return open(path, flags)
			}) as Disk["open"],
		}
		expect(await readOf("swap/b.txt", made.root, 1000, swapping)).toBe("changed while it was opened")
	})

	it("refuses a last link swapped in between realpath and the open: it is never followed", async () => {
		writeFileSync(join(made.root, "last.txt"), "in")
		const swapping: Disk = {
			...NODE_DISK,
			open: (async (path: string, flags: number) => {
				renameSync(join(made.root, "last.txt"), join(made.base, "last-out.txt"))
				symlinkSync(join(made.outside, "secret.txt"), join(made.root, "last.txt"))
				return open(path, flags)
			}) as Disk["open"],
		}
		expect(await readOf("last.txt", made.root, 1000, swapping)).toBe("is no regular file")
	})

	it("names no path in any refusal", async () => {
		const refusals = await Promise.all(
			["../outside/secret.txt", "out-dir/secret.txt", "fifo", "missing.txt"].map((p) => readOf(p)),
		)
		expect(refusals.filter((refusal) => refusal.includes(made.base) || refusal.includes("/"))).toEqual([])
	})
})

describe("a file is read within its cap, to exactly its size", () => {
	it("reads a file at the cap and one under it, and refuses one a byte past it", async () => {
		expect([
			await readOf("a.txt", made.root, 3),
			await readOf("two.txt", made.root, 3),
			await readOf("four.txt", made.root, 3),
		]).toEqual(["read abc", "read ab", "is past the 3-byte file cap"])
	})

	it("refuses a file that grows past the cap once its descriptor's size was read", async () => {
		writeFileSync(join(made.root, "grows.txt"), "abc")
		const growing: Disk = {
			...NODE_DISK,
			open: (async (path: string, flags: number) => {
				const handle = await open(path, flags)
				const sized = handle.stat.bind(handle)
				handle.stat = (async () => {
					const size = await sized()
					appendFileSync(path, "x".repeat(4096))
					return size
				}) as typeof handle.stat
				return handle
			}) as Disk["open"],
		}
		expect(await readOf("grows.txt", made.root, 3, growing)).toBe("changed while it was read")
	})
})

/** A FileInput for `bytes`, its size and digest true unless overridden. */
const inline = (bytes: Uint8Array, more: Record<string, unknown> = {}) => ({
	data: Buffer.from(bytes).toString("base64"),
	digest: { algorithm: "sha-256", value: createHash("sha256").update(bytes).digest("base64url") },
	id: "f1",
	mimeType: "text/plain",
	size: bytes.length,
	...more,
})

const ABC = new TextEncoder().encode("abc")

/** A call's files with nothing uploaded, read or fetched. */
const NONE = { signal: new AbortController().signal, taken: new Map<object, Uint8Array>() }

/** A reader giving `abc` for any path. */
const read: Read = async () => ABC

/** What `fileOf` makes of `file` with `cap` inline bytes left: its text, or the rule that refused it. */
async function inlineOf(file: Record<string, unknown>, cap = 1000): Promise<string> {
	const part = await fileOf(file, NONE, { cap, left: cap })
	return typeof part === "string" ? part : `${part.name ?? "-"} ${part.type} ${new TextDecoder().decode(part.bytes)}`
}

describe("inline data is canonical base64, its declared size, its digest", () => {
	it("takes a whole FileInput, its name and type kept", async () => {
		expect([await inlineOf(inline(ABC, { name: "a.txt" })), await inlineOf(inline(new Uint8Array(0)))]).toEqual([
			"a.txt text/plain abc",
			"- text/plain ",
		])
	})

	it.each([
		["a size one more", { size: 4 }, "data does not decode to its size"],
		["a size one less", { size: 2 }, "data does not decode to its size"],
		["a missing pad", { data: "YWJjZA=" }, "data is not base64"],
		["no padding", { data: "YWJjZA" }, "data is not base64"],
		["too much padding", { data: "YWJj====" }, "data is not base64"],
		["pad bits set", { data: "YWJjZB==" }, "data is not base64"],
		["a newline", { data: "YWJj\n" }, "data is not base64"],
		["a space inside", { data: "YW Jj" }, "data is not base64"],
		["a data: URI", { data: "data:text/plain;base64,YWJj" }, "data is not base64"],
		["base64url", { data: "-_-_" }, "data is not base64"],
		[
			"another file's digest",
			{ digest: { algorithm: "sha-256", value: createHash("sha256").update("abd").digest("base64url") } },
			"data does not match its digest",
		],
		[
			"a padded digest",
			{ digest: { algorithm: "sha-256", value: `${createHash("sha256").update(ABC).digest("base64url")}=` } },
			"data does not match its digest",
		],
		[
			"a standard-base64 digest",
			{ digest: { algorithm: "sha-256", value: createHash("sha256").update(ABC).digest("base64") } },
			"data does not match its digest",
		],
		["no data", { data: undefined }, "has no data, and no upload is served here"],
	])("refuses %s", async (_, more, outcome) => {
		expect(await inlineOf(inline(ABC, more))).toBe(outcome)
	})

	it("holds the call's inline bytes to the cap: at it taken, a byte past it refused", async () => {
		expect([await inlineOf(inline(ABC), 3), await inlineOf(inline(ABC), 2)]).toEqual([
			"- text/plain abc",
			"is past the 2 inline bytes a call may carry",
		])
	})

	it("refuses a path where no reader is, and reads one where it is, under its base name", async () => {
		const [refused, taken] = [
			await fileOf({ path: "a/b.txt" }, NONE, { cap: 1, left: 1 }),
			await fileOf({ path: "a/b.txt" }, { ...NONE, read }, { cap: 1, left: 1 }),
		]
		expect([refused, typeof taken === "string" ? taken : [taken.name, taken.type]]).toEqual([
			"is a path, which only the stdio server reads",
			["b.txt", "application/octet-stream"],
		])
	})
})
