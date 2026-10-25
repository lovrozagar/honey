/**
 * The honey-codegen generate CLI (bit 17 phase h): a usage error is exit 1 with the usage text (and --help names what
 * is not deleted until bit 19); each target written under `<out>/<target>`, its options passed through untouched, so a
 * hostile one is refused by its own generator with that generator's message; a spec that is not JSON refused; the go
 * and cli targets' whole trees, internal/sdk included, through gofmt, found by GOFMT, GOROOT, PATH or beside the real
 * go, and a refusal when there is none; `--watch` regenerating in a fresh child on each change of the spec until
 * stopped, no child left once it ends. Most legs run `main` in process; the bin legs prove the command a user runs,
 * under the Bun package.json pins (never PATH's newest).
 * Every child carries this file's mark, and the last leg fails on any that outlived its leg.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { findGofmt, main } from "./cli.ts"
import { shop } from "./emit/cli/__fixtures__/shop.ts"
import { goCacheDir, gofmtPath, withGo } from "./emit/go/__fixtures__/go-env.ts"
import { usage } from "./gen/args.ts"
import { pinnedBunVersion, withPinnedBun } from "./gen/__fixtures__/pinned-bun.ts"
import { MARK_KEY, markOf, marked, reap } from "./gen/__fixtures__/survivors.ts"

const GO = withGo()
const SLOW = { timeout: 600_000 }
const BIN = resolve(import.meta.dirname, "../bin/honey-codegen.js")
const PINNED_BUN = withPinnedBun()
const MARK = markOf()
const scratch = (name: string) => mkdtempSync(join(goCacheDir("tmp"), `codegen-${name}-`))

/** `document` written as a spec in a fresh dir: the dir, the spec's path, and `<dir>/out`. */
function specDir(document: unknown = shop()): { dir: string; out: string; spec: string } {
	const dir = scratch("spec")
	writeFileSync(join(dir, "spec.json"), typeof document === "string" ? document : JSON.stringify(document))
	return { dir, out: join(dir, "out"), spec: join(dir, "spec.json") }
}

/** `main` run in process with `argv`, over `env` when given (else the process's): its exit code and what it wrote. */
async function run(argv: readonly string[], env?: NodeJS.ProcessEnv) {
	let out = ""
	let err = ""
	const status = await main(argv, { err: (text) => (err += text), out: (text) => (out += text) }, env && { env })
	return { err, out, status }
}

/** Settled once `ready()` holds: a latch on a child's own writes or a watch's own report. */
const until = (ready: () => boolean) =>
	new Promise<void>((settle) => {
		const poll = setInterval(() => {
			if (ready()) {
				clearInterval(poll)
				settle()
			}
		}, 20)
	})

/** The bin run under the pinned Bun with `args`, its environment `env` alone (no Bun handoff). */
const bin = (args: readonly string[], env: NodeJS.ProcessEnv) =>
	spawnSync(PINNED_BUN as string, [BIN, ...args], {
		encoding: "utf8",
		env: { HONEY_NO_BUN_HANDOFF: "1", HOME: scratch("home"), [MARK_KEY]: MARK, ...env },
	})

/** Every file under `dir`, `dir`-relative. */
const filesUnder = (dir: string) =>
	readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
		.sort()

describe("generate's usage (phase h)", () => {
	it("refuses no command and an unknown one, and names what bit 19 deletes", async () => {
		const [none, unknown] = [await run([]), await run(["serve"])]
		expect([none.status, none.out, unknown.status, unknown.err.split("\n")[0]]).toEqual([
			1,
			`${usage()}\n`,
			1,
			'honey-codegen: unknown command "serve"',
		])
		expect(usage()).toContain("none is deleted. A file a removed operation left (a go or cli target's stale")
	})
})

describe("generate's files (phase h)", () => {
	it("writes every SDK target under its own name", async () => {
		const { out, spec } = specDir()
		const targets = ["rust", "python", "csharp", "java"]
		const ran = await run([
			"generate",
			"--spec",
			spec,
			...targets.flatMap((target) => ["--target", target]),
			"--out",
			out,
		])
		const dirs = [...new Set(filesUnder(out).map((name) => name.split("/")[0]))]
		expect([ran.status, dirs.sort()]).toEqual([0, [...targets].sort()])
	})

	it("writes the MCP server under mcp/, its options passed to its generator", async () => {
		const ping = { get: { operationId: "ping", responses: { 204: { description: "none" } }, "x-mcp": true } }
		const { out, spec } = specDir({ ...(shop() as Record<string, unknown>), paths: { "/ping": ping } })
		const ran = await run(["generate", "--spec", spec, "--target", "mcp", "--mcp-name", "kiosk", "--out", out])
		const pkg = JSON.parse(readFileSync(join(out, "mcp", "package.json"), "utf8")) as { bin: Record<string, string> }
		expect([ran.status, pkg.bin, filesUnder(out).includes("mcp/dist/server.js")]).toEqual([
			0,
			{ "kiosk-mcp": "dist/server.js" },
			true,
		])
	})

	it("writes to the process's own output and error when no io is given", async () => {
		expect([await main(["--help"]), await main(["serve"])]).toEqual([0, 1])
	})

	it("writes each target under <out>/<target>, its options passed to its generator untouched", async () => {
		const { out, spec } = specDir()
		const ran = await run(["generate", "--spec", spec, "--target", "ts", "--ts-name", "Shop", "--out", out])
		expect([ran.status, ran.out, filesUnder(out)]).toEqual([
			0,
			`honey-codegen: generated 5 files into ${out}\n`,
			[
				"ts/shop.client.gen.ts",
				"ts/shop.index.gen.ts",
				"ts/shop.map.gen.ts",
				"ts/shop.runtime.gen.ts",
				"ts/shop.types.gen.ts",
			],
		])
	})

	it("refuses a spec that is not JSON, nothing written", async () => {
		const { out, spec } = specDir("openapi: 3.1.0\n")
		const ran = await run(["generate", "--spec", spec, "--target", "ts", "--out", out])
		expect([ran.status, ran.err.startsWith(`honey-codegen: ${spec}: not a JSON document (`), existsSync(out)]).toEqual([
			1,
			true,
			false,
		])
	})
})

describe("the generate report (bit 18 phase d)", () => {
	it("names on stderr each MCP operation no tool serves yet, and still writes the server", async () => {
		const ping = { get: { operationId: "ping", responses: { 204: { description: "none" } }, "x-mcp": true } }
		const parts = { content: { "multipart/form-data": { schema: { properties: {}, type: "object" } } } }
		const upload = {
			post: { operationId: "upload", requestBody: parts, responses: { 204: { description: "none" } }, "x-mcp": true },
		}
		const { out, spec } = specDir({
			...(shop() as Record<string, unknown>),
			paths: { "/ping": ping, "/upload": upload },
		})
		const ran = await run(["generate", "--spec", spec, "--target", "mcp", "--out", out])
		expect([ran.status, ran.err, filesUnder(out).includes("mcp/dist/server.js")]).toEqual([
			0,
			"honey-codegen: mcp: no tool serves upload (a multipart body) yet: skipped\n",
			true,
		])
	})
})

describe.skipIf(!GO)("the go and cli trees through gofmt (phase h)", SLOW, () => {
	it("writes the whole cli and go trees gofmt-clean, the embedded SDK under internal/sdk included", async () => {
		const { out, spec } = specDir()
		const ran = await run(["generate", "--spec", spec, "--target", "cli", "--target", "go", "--out", out], {
			GOFMT: gofmtPath(),
		})
		const listed = spawnSync(gofmtPath(), ["-l", out], { encoding: "utf8" })
		const sdk = filesUnder(out).filter((name) => name.startsWith("cli/internal/sdk/") && name.endsWith(".go"))
		expect([ran.status, listed.status, listed.stdout, sdk.length > 0]).toEqual([0, 0, "", true])
	})

	it("formats with the gofmt GOFMT names, once per Go file", async () => {
		const { dir, out, spec } = specDir()
		const log = join(dir, "calls")
		const wrapper = join(dir, "gofmt-wrapper")
		writeFileSync(wrapper, `#!/bin/sh\necho x >> ${log}\nexec ${gofmtPath()} "$@"\n`, { mode: 0o755 })
		const ran = await run(["generate", "--spec", spec, "--target", "cli", "--out", out], { GOFMT: wrapper })
		const goFiles = filesUnder(out).filter((name) => name.endsWith(".go")).length
		expect([ran.status, readFileSync(log, "utf8").split("\n").filter(Boolean).length]).toEqual([0, goFiles])
	})

	it("refuses the go and cli targets when no gofmt is found, nothing written", async () => {
		const { out, spec } = specDir()
		const ran = await run(["generate", "--spec", spec, "--target", "go", "--out", out], { PATH: "" })
		expect([ran.status, ran.err, existsSync(out)]).toEqual([
			1,
			"honey-codegen: gofmt is required for the go and cli targets (install Go, or set GOFMT)\n",
			false,
		])
	})
})

/* skipped, its title naming the pinned Bun, where that Bun is not found; a failure under HONEY_REQUIRE_TOOLCHAINS */
describe.skipIf(!PINNED_BUN)(`the bin under the pinned Bun ${pinnedBunVersion()} (phase h)`, () => {
	it("prints the usage with exit 1 on a usage error, and exit 0 under --help, through the bin", () => {
		const [wrong, help] = [bin(["generate", "--nope"], {}), bin(["--help"], {})]
		expect([wrong.status, wrong.stderr, help.status, help.stdout]).toEqual([
			1,
			`honey-codegen: unknown option --nope\n\n${usage()}\n`,
			0,
			`${usage()}\n`,
		])
	})

	it("refuses a hostile option through the bin with its generator's own message, nothing written", () => {
		const { out, spec } = specDir()
		const hostile = 'shop"; rm -rf ~; "'
		const ran = bin(["generate", "--spec", spec, "--target", "cli", "--cli-binary-name", hostile, "--out", out], {
			GOFMT: "/nonexistent",
		})
		expect([ran.status, ran.stderr, existsSync(out)]).toEqual([
			1,
			`honey-codegen: Invalid binaryName: ${JSON.stringify(hostile)}\n`,
			false,
		])
	})
})

describe("finding gofmt (phase h)", () => {
	it("takes GOFMT, then GOROOT's, then PATH's, then the one beside the real go, else none", () => {
		const root = scratch("goroot")
		mkdirSync(join(root, "bin"))
		writeFileSync(join(root, "bin", "gofmt"), "", { mode: 0o755 })
		writeFileSync(join(root, "bin", "go"), "", { mode: 0o755 })
		const onPath = scratch("path")
		writeFileSync(join(onPath, "gofmt"), "", { mode: 0o755 })
		const linked = scratch("linked")
		symlinkSync(join(root, "bin", "go"), join(linked, "go"))
		const bare = scratch("bare")
		writeFileSync(join(bare, "go"), "", { mode: 0o755 })
		expect([
			findGofmt({ GOFMT: "/x/gofmt", GOROOT: root, PATH: onPath }),
			findGofmt({ GOROOT: root, PATH: onPath }),
			findGofmt({ GOROOT: "/nonexistent", PATH: onPath }),
			findGofmt({ PATH: linked }),
			findGofmt({ PATH: bare }),
			findGofmt({ PATH: "" }),
			findGofmt({}),
		]).toEqual([
			"/x/gofmt",
			join(root, "bin", "gofmt"),
			join(onPath, "gofmt"),
			join(root, "bin", "gofmt"),
			undefined,
			undefined,
			undefined,
		])
	})
})

describe("generate --watch (phase h)", () => {
	it("refuses --watch in a generation child, nothing written", async () => {
		const { out, spec } = specDir()
		const argv = ["generate", "--spec", spec, "--target", "ts", "--out", out, "--watch"]
		const ran = await run(argv, { ...process.env, [MARK_KEY]: MARK, HONEY_CODEGEN_CHILD: "1" })
		expect([ran.status, ran.err, existsSync(out)]).toEqual([
			1,
			"honey-codegen: --watch is not allowed in a generation child\n",
			false,
		])
	})

	it("generates at start, again in a fresh child on each change, reports a failed run, and ends when stopped", async () => {
		const { out, spec } = specDir()
		const map = join(out, "ts", "shop.map.gen.ts")
		let err = ""
		let stdout = ""
		const holds = (text: string) => until(() => existsSync(map) && readFileSync(map, "utf8").includes(text))
		const stop = new AbortController()
		const argv = ["generate", "--spec", spec, "--target", "ts", "--ts-name", "Shop", "--out", out, "--watch"]
		const watching = main(
			argv,
			{ err: (text) => (err += text), out: (text) => (stdout += text) },
			{ env: { ...process.env, [MARK_KEY]: MARK }, signal: stop.signal },
		)
		await holds("items")
		const changed = shop() as { paths: Record<string, unknown> }
		writeFileSync(
			spec,
			JSON.stringify({
				...changed,
				paths: {
					...changed.paths,
					"/refunds": { get: { operationId: "refunds.list", responses: { 204: { description: "none" } } } },
				},
			}),
		)
		await holds("refunds")
		writeFileSync(spec, "not JSON")
		await until(() => err !== "")
		stop.abort()
		/* a watch ends once its last run has: no child of it left */
		expect([await watching, stdout, err, marked(MARK)]).toEqual([
			0,
			`honey-codegen: watching ${spec}\n`,
			"honey-codegen: honey-codegen generate failed (exit 1)\n",
			[],
		])
	}, 60_000)
})

describe("no process left behind (phase h)", () => {
	it("leaves no child of this file running: any that outlived its leg is killed and named", () => {
		expect(reap(MARK)).toEqual([])
	})
})
