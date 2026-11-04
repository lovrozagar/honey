/**
 * The honey-clients generate CLI (bit 17 phase h): a usage error is exit 1 with the usage text (and --help names what
 * a regeneration deletes); each target written under `<out>/<target>`, its options passed through untouched, so a
 * hostile one is refused by its own generator with that generator's message; a spec that is not JSON refused; the go
 * and cli targets' whole trees through gofmt, found by GOFMT, GOROOT, PATH or beside the real go; the ts target's
 * files as oxfmt formats them, and as emitted when oxfmt does not resolve (bit 19 i, Q12); since bit 22 a formatter
 * that is not there is named on stderr, fatal only under HONEY_REQUIRE_FORMATTERS; `--watch` regenerating in a fresh
 * child on each change until stopped. Most legs run `main` in process; the bin legs prove the command a user runs.
 * Every child carries this file's mark, and the last leg fails on any that outlived its leg.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { format } from "oxfmt"
import { generated, type GenerateContext, type GenerateRun, main } from "./cli.ts"
import { findGofmt, loadOxfmt } from "./gen/formatters.ts"
import { shop } from "./emit/cli/__fixtures__/shop.ts"
import { EMIT_STYLE } from "./emit/shared/format.ts"
import { generateSdkPackage } from "./emit/ts/package.ts"
import { goCacheDir, gofmtPath, withGo } from "./emit/go/__fixtures__/go-env.ts"
import { type Generate, usage } from "./gen/args.ts"
import { pinnedBunVersion, withPinnedBun } from "./gen/__fixtures__/pinned-bun.ts"
import { MARK_KEY, markOf, marked, reap } from "./gen/__fixtures__/survivors.ts"
import { SPAWN_TIMEOUT } from "./gen/__fixtures__/spawn-timeout.ts"

const GO = withGo()
const SLOW = { timeout: 600_000 }
const BIN = resolve(import.meta.dirname, "../bin/honey-clients.js")
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

/* the five modules every TS SDK writes; the package compiles each into dist/ (plan 39 8.3) */
const PARTS = ["client", "index", "map", "runtime", "types"]

describe("generated: a run with no options bag (bit 22 a)", () => {
	it(
		"takes the generator's own defaults for a target whose options are left out",
		async () => {
			const document = {
				info: { title: "Shop", version: "1" },
				openapi: "3.1.0",
				paths: { "/ping": { get: { responses: { "200": { description: "ok" } } } } },
			}
			const files = await generated({ targets: ["ts"] }, document, { env: {}, report: () => undefined })
			expect(Object.keys(files.ts?.files ?? {}).sort()).toEqual([
				...PARTS.flatMap((part) => [`dist/sdk.${part}.gen.d.ts`, `dist/sdk.${part}.gen.js`]),
				"package.json",
				...PARTS.map((part) => `sdk.${part}.gen.ts`),
			])
		},
		SPAWN_TIMEOUT,
	)

	it(
		"writes the TanStack Query adapter for --ts-tanstack-query, which takes no value (bit 22)",
		async () => {
			const document = {
				info: { title: "Shop", version: "1" },
				openapi: "3.1.0",
				paths: { "/ping": { get: { responses: { "200": { description: "ok" } } } } },
			}
			const run: GenerateRun = { options: { ts: { tanstackQuery: "true" } }, targets: ["ts"] }
			const files = await generated(run, document, { env: {}, report: () => undefined })
			expect(Object.keys(files.ts?.files ?? {})).toContain("sdk.tanstack-query.gen.ts")
			/* the string the parser stores must not be what decides it: "false" is off, not truthy */
			const off = await generated({ options: { ts: { tanstackQuery: "false" } }, targets: ["ts"] as const }, document, {
				env: {},
				report: () => undefined,
			})
			expect(Object.keys(off.ts?.files ?? {})).not.toContain("sdk.tanstack-query.gen.ts")
		},
		SPAWN_TIMEOUT,
	)
})

describe("generate's usage (phase h)", () => {
	it(
		"refuses no command and an unknown one, and names what a regeneration deletes",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const [none, unknown] = [await run([]), await run(["serve"])]
			expect([none.status, none.out, unknown.status, unknown.err.split("\n")[0]]).toEqual([
				1,
				`${usage()}\n`,
				1,
				'honey-clients: unknown command "serve"',
			])
			/* the words, not where the paragraph wraps */
			expect(usage().replaceAll("\n", " ")).toContain(
				"the package it makes on each registry (registry, name, version), and every file it wrote with its sha256. A regeneration deletes a file the last run wrote and this one does not, unless it was edited since",
			)
		},
	)
})

describe("generate's regeneration (bit 19 h1)", () => {
	it(
		"deletes the files the last run wrote and this one did not, keeping an edited one and naming it",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const { out, spec } = specDir()
			const once = (stem: string, into = out) =>
				run(["generate", "--spec", spec, "--target", "ts", "--ts-stem", stem, "--out", into])
			await once("first")
			const edited = filesUnder(out).find((name) => name.endsWith(".index.gen.ts")) as string
			writeFileSync(join(out, edited), "// mine\n")
			const second = await once("second")
			const alone = specDir().out
			await once("second", alone)
			expect({ err: second.err, files: filesUnder(out), status: second.status }).toEqual({
				err: `honey-clients: ${edited} is stale but edited since it was generated, or not its to delete: kept\n`,
				files: [...filesUnder(alone), edited].sort(),
				status: 0,
			})
		},
	)
})

describe("generate's files (phase h)", { timeout: SPAWN_TIMEOUT }, () => {
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
			`honey-clients: generated 16 files into ${out}\n`,
			[
				"ts/.honey-generated.json",
				...PARTS.flatMap((part) => [`ts/dist/shop.${part}.gen.d.ts`, `ts/dist/shop.${part}.gen.js`]),
				"ts/package.json",
				...PARTS.map((part) => `ts/shop.${part}.gen.ts`),
			],
		])
	})

	it("refuses a spec that is not JSON, nothing written", async () => {
		const { out, spec } = specDir("openapi: 3.1.0\n")
		const ran = await run(["generate", "--spec", spec, "--target", "ts", "--out", out])
		expect([ran.status, ran.err.startsWith(`honey-clients: ${spec}: not a JSON document (`), existsSync(out)]).toEqual([
			1,
			true,
			false,
		])
	})
})

/** The shop's ts target as its generator emits it, before any post-pass. */
const emitted = () => generateSdkPackage(shop(), { name: "Shop" }, {}).files

/** A loadOxfmt's outcome as a value, a rejection as its message, so a wrong one is a mismatch, never a throw. */
const settled = (specifier?: string) =>
	loadOxfmt(specifier).then(
		(loaded) => loaded,
		(error: Error) => `rejected: ${error.message}`,
	)

describe("the ts tree through oxfmt (bit 19 i, Q12)", () => {
	it("writes the ts target's files byte for byte as oxfmt formats them", { timeout: SPAWN_TIMEOUT }, async () => {
		const { out, spec } = specDir()
		const ran = await run(["generate", "--spec", spec, "--target", "ts", "--ts-name", "Shop", "--out", out])
		/* the sources oxfmt formats; dist/ is the package's compiled twin of them */
		const raw = Object.entries(emitted()).filter(([name]) => /^shop\.[\w-]+\.gen\.ts$/.test(name))
		const formatted = await Promise.all(
			raw.map(async ([name, text]) => [name, (await format(name, text, EMIT_STYLE)).code] as const),
		)
		expect({
			/* not vacuous: oxfmt changes these two of the shop's files */
			reformatted: formatted.filter(([name, code]) => code !== emitted()[name]).map(([name]) => name),
			status: ran.status,
			written: raw.map(([name]) => [name, readFileSync(join(out, "ts", name), "utf8")]),
		}).toEqual({
			reformatted: ["shop.index.gen.ts", "shop.types.gen.ts"],
			status: 0,
			written: formatted.map(([name, code]) => [name, code]),
		})
	})

	it(
		"writes them as emitted, with no error and nothing reported, when oxfmt does not resolve",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const reported: string[] = []
			const context: GenerateContext = { env: {}, oxfmt: "@honey/no-such-oxfmt", report: (line) => reported.push(line) }
			const options = { ts: { name: "Shop" } } as unknown as Generate["options"]
			const files = await generated({ options, targets: ["ts"] }, shop(), context).then(
				(out) => out.ts?.files,
				(error: Error) => error.message,
			)
			/* Q12: oxfmt is an optional peer, so its absence is the documented normal, not news */
			expect({ files, reported }).toEqual({ files: emitted(), reported: [] })
		},
	)

	it("loads the installed oxfmt's format, undefined for a missing one, and rethrows any other failure", async () => {
		expect([
			await settled(),
			await settled("@honey/no-such-oxfmt"),
			await settled("data:text/javascript,throw new Error('broken')"),
		]).toEqual([format, undefined, "rejected: broken"])
	})
})

describe("the generate report (bit 18 phase d)", () => {
	it(
		"names on stderr each MCP operation no tool serves yet, and still writes the server",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const ping = { get: { operationId: "ping", responses: { 204: { description: "none" } }, "x-mcp": true } }
			/* a socket: a multipart form is a tool since bit 21 c */
			const chat = {
				get: { operationId: "chat", responses: { 101: { description: "up" } }, "x-mcp": true, "x-websocket": true },
			}
			const { out, spec } = specDir({
				...(shop() as Record<string, unknown>),
				paths: { "/chat": chat, "/ping": ping },
			})
			const ran = await run(["generate", "--spec", spec, "--target", "mcp", "--out", out])
			expect([ran.status, ran.err, filesUnder(out).includes("mcp/dist/server.js")]).toEqual([
				0,
				"honey-clients: mcp: no tool serves chat (a WebSocket) yet: skipped\n",
				true,
			])
		},
	)
})

/* bit 21 i1 (ts), i2 (python), i3 (go), i4 (rust), i5 (csharp) and i6 (java): each target's file the SDK always writes, and its spelling of the mirror */
const WRITTEN = {
	csharp: "/Client.cs",
	go: "/client.go",
	java: "/ExampleClient.java",
	python: "/src/honey_sdk/client.py",
	rust: "/src/client.rs",
	ts: ".types.gen.ts",
} as const
const SPELLED = {
	csharp: ["Safe", "Safe_"],
	go: ["Safe", "Safe_"],
	java: ["safe", "safe_"],
	python: ["safe", "safe_"],
	rust: ["safe", "safe_"],
	ts: ["safe", "safe_"],
} as const

describe("the generate report: the safe mirror (bit 21 i1, i2, i3, i4, i5, i6)", () => {
	it.each(["ts", "python", "go", "rust", "csharp", "java"] as const)(
		"names on stderr a %s root group renamed off the safe mirror, and still writes the SDK",
		{ timeout: SPAWN_TIMEOUT },
		async (target) => {
			const get = { get: { operationId: "safe.get", responses: { 204: { description: "none" } } } }
			const { out, spec } = specDir({ ...(shop() as Record<string, unknown>), paths: { "/safe": get } })
			/* an empty PATH so the run finds no formatter wherever it runs: this leg is about the rename it
			   names on stderr, and inheriting the machine's toolchains would let ruff's presence decide it */
			const ran = await run(["generate", "--spec", spec, "--target", target, "--out", out], { PATH: "" })
			const [mirror, renamed] = SPELLED[target]
			const rename = `honey-clients: ${target}: the root group "${mirror}" is emitted as "${renamed}": "${mirror}" is the client's safe mirror\n`
			/* oxfmt is quiet when absent, and csharp and java have no formatter here, so those say nothing */
			const tool = {
				go: "gofmt (install Go, or set GOFMT)",
				python: "ruff (install ruff, or set RUFF)",
				rust: "rustfmt (install rustfmt, or set RUSTFMT)",
			}[target as string]
			const skip =
				tool === undefined
					? ""
					: `honey-clients: ${tool.replace(" (", ` was not found, so the ${target} output is not formatted (`)}\n`
			expect([ran.status, ran.err, filesUnder(out).some((file) => file.endsWith(WRITTEN[target]))]).toEqual([
				0,
				`${rename}${skip}`,
				true,
			])
		},
	)
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
})

/* skipped, its title naming the pinned Bun, where that Bun is not found; a failure under HONEY_REQUIRE_TOOLCHAINS */
describe.skipIf(!PINNED_BUN)(`the bin under the pinned Bun ${pinnedBunVersion()} (phase h)`, () => {
	it(
		"prints the usage with exit 1 on a usage error, and exit 0 under --help, through the bin",
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const [wrong, help] = [bin(["generate", "--nope"], {}), bin(["--help"], {})]
			expect([wrong.status, wrong.stderr, help.status, help.stdout]).toEqual([
				1,
				`honey-clients: unknown option --nope\n\n${usage()}\n`,
				0,
				`${usage()}\n`,
			])
		},
	)

	it(
		"refuses a hostile option through the bin with its generator's own message, nothing written",
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const { out, spec } = specDir()
			const hostile = 'shop"; rm -rf ~; "'
			const ran = bin(["generate", "--spec", spec, "--target", "cli", "--cli-binary-name", hostile, "--out", out], {
				GOFMT: "/nonexistent",
			})
			expect([ran.status, ran.stderr, existsSync(out)]).toEqual([
				1,
				`honey-clients: Invalid binaryName: ${JSON.stringify(hostile)}\n`,
				false,
			])
		},
	)
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
			findGofmt({ GOFMT: join(root, "bin", "gofmt"), GOROOT: "/nonexistent", PATH: "" }),
			findGofmt({ GOROOT: root, PATH: onPath }),
			findGofmt({ GOROOT: "/nonexistent", PATH: onPath }),
			findGofmt({ PATH: linked }),
			findGofmt({ PATH: bare }),
			findGofmt({ PATH: "" }),
			findGofmt({}),
		]).toEqual([
			join(root, "bin", "gofmt"),
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
	it("refuses --watch in a generation child, nothing written", { timeout: SPAWN_TIMEOUT }, async () => {
		const { out, spec } = specDir()
		const argv = ["generate", "--spec", spec, "--target", "ts", "--out", out, "--watch"]
		const ran = await run(argv, { ...process.env, [MARK_KEY]: MARK, HONEY_CODEGEN_CHILD: "1" })
		expect([ran.status, ran.err, existsSync(out)]).toEqual([
			1,
			"honey-clients: --watch is not allowed in a generation child\n",
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
			`honey-clients: watching ${spec}\n`,
			"honey-clients: honey-clients generate failed (exit 1)\n",
			[],
		])
	}, 60_000)
})

describe("no process left behind (phase h)", () => {
	it("leaves no child of this file running: any that outlived its leg is killed and named", () => {
		expect(reap(MARK)).toEqual([])
	})
})
