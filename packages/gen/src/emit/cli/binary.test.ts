/**
 * Bytes through the CLI (bit 17 phase c, A1): a binary answer piped as it came or written by -o to a file, refused on a
 * terminal and under -i (no mojibake); a binary request streamed from a file or stdin; a multipart body part by part,
 * text, file and repeated file parts; and a text answer, raw on a pipe, its control characters escaped on a terminal.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { goCacheDir, withGo } from "../go/__fixtures__/go-env.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { builtCli, type RunOptions } from "./__fixtures__/built.ts"
import { shop } from "./__fixtures__/shop.ts"
import { generateGoCli } from "./module.ts"

const GO = withGo()
const SLOW = { timeout: 600_000 }

const built = () => builtCli(generateGoCli(shop()).files)
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/** The bytes a `bytes: n` reply sends: byte i is `i & 0xff`. */
const served256 = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => i & 0xff))

/** A fresh directory for files a run reads or writes. */
const scratch = () => mkdtempSync(join(goCacheDir("cli-binary"), "dir-"))

/** One run against a server answering `replies`; the run and what the server received. */
async function call(args: readonly string[], replies: readonly Reply[], options: RunOptions = {}) {
	return served(replies, async (server) => {
		const ran = await built().cli(args, { ...options, env: { SHOP_BASE_URL: server.url, ...options.env } })
		return { ...ran, bodies: server.bodies, hops: server.hops }
	})
}

describe.skipIf(!GO)("a binary answer (phase c, A1)", SLOW, () => {
	it("writes the bytes as they came to a pipe, and to the file -o names with stdout left empty", async () => {
		const file = join(scratch(), "blob.bin")
		const [piped, written] = [
			await call(["files", "get", "blob.bin"], [{ bytes: 256, status: 200 }]),
			await call(["files", "get", "blob.bin", "-o", file], [{ bytes: 256, status: 200 }]),
		]
		expect({
			file: sha256(readFileSync(file)),
			piped: [piped.status, sha256(piped.stdoutBytes)],
			written: [written.status, written.stdoutBytes.length],
		}).toEqual({ file: sha256(served256(256)), piped: [0, sha256(served256(256))], written: [0, 0] })
	})

	it("refuses to write bytes on a terminal, and to wrap them with -i, exit 4", async () => {
		const [terminal, included] = [
			await call(["files", "get", "blob.bin", "-q"], [{ bytes: 256, status: 200 }], { tty: true }),
			await call(["files", "get", "blob.bin", "-i"], [{ bytes: 256, status: 200 }]),
		]
		expect({
			included: [included.status, JSON.parse(included.stderr)],
			terminal: [terminal.status, terminal.stdout],
		}).toEqual({
			included: [4, { error: { kind: "usage", message: "the answer is binary: write it with -o <file>, or pipe it" } }],
			terminal: [4, "shop: the answer is binary: write it with -o <file>, or pipe it\n"],
		})
	})
})

describe.skipIf(!GO)("a binary or multipart request (phase c)", SLOW, () => {
	it("streams a 64 KiB body from the file --data names, as the bytes on disk", async () => {
		const file = join(scratch(), "up.bin")
		const bytes = Buffer.from(Array.from({ length: 65_536 }, (_, i) => (i * 7) & 0xff))
		writeFileSync(file, bytes)
		const ran = await call(["files", "put", "up.bin", "--data", `@${file}`], [{ status: 204 }])
		expect([ran.status, ran.hops[0]?.body.size, ran.hops[0]?.body.sha256]).toEqual([0, 65_536, sha256(bytes)])
	})

	it("sends a multipart body part by part: a text part, a file part, a repeated file part", async () => {
		const dir = scratch()
		for (const [name, text] of [
			["main.txt", "main body"],
			["x1.txt", "first extra"],
			["x2.txt", "second extra"],
		])
			writeFileSync(join(dir, name as string), text as string)
		const args = [
			"--note",
			"hi",
			"--file",
			join(dir, "main.txt"),
			"--extras",
			join(dir, "x1.txt"),
			"--extras",
			join(dir, "x2.txt"),
		]
		const ran = await call(["uploads", "create", ...args], [{ status: 204 }])
		const body = ran.bodies[0]?.toString() ?? ""
		const part = (name: string, file: string, text: string) =>
			body.includes(`name="${name}"; filename="${file}"\r\nContent-Type: application/octet-stream\r\n\r\n${text}\r\n`)
		expect({
			contentType: ran.hops[0]?.body.contentType?.startsWith("multipart/form-data; boundary="),
			extras: [part("extras", "x1.txt", "first extra"), part("extras", "x2.txt", "second extra")],
			file: part("file", "main.txt", "main body"),
			note: body.includes('name="note"\r\n\r\nhi\r\n'),
			status: ran.status,
		}).toEqual({ contentType: true, extras: [true, true], file: true, note: true, status: 0 })
	})
})

describe.skipIf(!GO)("a text answer (phase c)", SLOW, () => {
	it("writes the text as it came to a pipe, and on a terminal with its control characters escaped", async () => {
		const reply: Reply = { status: 200, text: "noted\u001b[2J\u0007 done\n" }
		const [piped, terminal] = [
			await call(["notes", "create", "--data", "x"], [reply]),
			await call(["notes", "create", "--data", "x", "-q"], [reply], { tty: true }),
		]
		expect([piped.stdout, terminal.stdout]).toEqual(["noted\u001b[2J\u0007 done\n", "noted\\x1b[2J\\a done\n"])
	})
})
