/**
 * The install scripts (bit 17 phase g), run against a local server holding a fake release:
 * - install.sh installs the archive for this platform only after its sha256 matches checksums.txt, refuses a
 *   tampered archive, a missing checksum line, an unknown OS or architecture, a base that is neither https:// nor
 *   http:// on loopback (before any fetch), a version that is no tag, and a machine without curl, wget or a digest
 *   tool; each refusal one line on stderr, nonzero, nothing installed;
 * - curl runs with --proto and --tlsv1.2, wget with --https-only on an https base;
 * - the default base is the repository's GitHub Releases, a tag's or the latest;
 * - a truncated download runs nothing;
 * - sh -n and shellcheck pass, and install.ps1 parses and does the same under PowerShell.
 */
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { goCacheDir } from "../go/__fixtures__/go-env.ts"
import { shop } from "./__fixtures__/shop.ts"
import { syntaxCheck, toolBin, withTools } from "./__fixtures__/tools.ts"
import { generateGoCli } from "./module.ts"

const TOOLS = withTools()
const LINUX = "shop_linux_amd64.tar.gz"
const WINDOWS = "shop_windows_amd64.zip"
const ZEROS = "0".repeat(64)

/** The shop's install scripts, released to `repo` (none for null). */
const scripts = (repo: string | null = "acme/shop") => {
	const { files } = generateGoCli(shop(), repo === null ? {} : { repo })
	return { ps1: files["install.ps1"] as string, sh: files["install.sh"] as string }
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const scratch = (name: string) => mkdtempSync(join(goCacheDir("tmp"), `install-${name}-`))

/** A tar.gz holding one executable `shop` that prints `fake shop`. */
function tarGz(): Buffer {
	const dir = scratch("tar")
	writeFileSync(join(dir, "shop"), "#!/bin/sh\necho fake shop\n", { mode: 0o755 })
	spawnSync("tar", ["-czf", join(dir, "a.tar.gz"), "-C", dir, "shop"])
	return readFileSync(join(dir, "a.tar.gz"))
}

/** A zip holding one `shop.exe`. */
function zipOf(): Buffer {
	const dir = scratch("zip")
	writeFileSync(join(dir, "shop.exe"), "fake shop exe\n")
	spawnSync("zip", ["-q", "-j", join(dir, "a.zip"), join(dir, "shop.exe")])
	return readFileSync(join(dir, "a.zip"))
}

/** The fake release: each archive, and checksums.txt over all but `unlisted`, an archive's digest `tampered`. */
function release(archives: Record<string, Buffer>, opts: { tampered?: string; unlisted?: string } = {}) {
	const sums = Object.entries(archives)
		.filter(([name]) => name !== opts.unlisted)
		.map(([name, bytes]) => `${name === opts.tampered ? ZEROS : sha256(bytes)}  ${name}`)
	return new Map([...Object.entries(archives), ["checksums.txt", Buffer.from(`${sums.join("\n")}\n`)]])
}

/** A server answering from the files `set` gives it, recording each path asked for since. */
type Served = { readonly url: string; readonly asked: string[]; set(files: Map<string, Buffer>): void; close(): void }
async function serve(): Promise<Served> {
	let files = new Map<string, Buffer>()
	const asked: string[] = []
	const server = createServer((req, res) => {
		const name = (req.url ?? "/").slice(1)
		asked.push(name)
		const body = files.get(name)
		res.writeHead(body === undefined ? 404 : 200).end(body)
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	return {
		asked,
		close: () => server.close(),
		set: (next) => {
			files = next
			asked.length = 0
		},
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
	}
}

/** Where `tool` is on this machine's PATH, or "". */
const which = (tool: string) => spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim()

/** A PATH dir with the system's `tools` linked in and `shims` (name → sh body) written beside them. */
function pathWith(tools: readonly string[], shims: Record<string, string> = {}): string {
	const dir = scratch("path")
	/* a shim is never written through a link: a tool it replaces is not linked */
	for (const tool of tools.filter((each) => !Object.hasOwn(shims, each))) {
		const found = which(tool)
		if (found !== "") symlinkSync(found, join(dir, tool))
	}
	for (const [name, body] of Object.entries(shims)) {
		writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
		chmodSync(join(dir, name), 0o755)
	}
	return dir
}

/** What install.sh runs besides its downloader and uname. */
const BASE_TOOLS = ["sh", "awk", "tar", "gzip", "mktemp", "rm", "mkdir", "cp", "chmod", "mv", "cat", "sha256sum"]

/** A PATH whose uname answers `s` to -s and `m` to -m, curl beside it. */
const unamePath = (s: string, m: string) =>
	pathWith([...BASE_TOOLS, "curl"], { uname: `case "$1" in -s) echo ${s} ;; -m) echo ${m} ;; esac` })

/** A PATH whose curl records its arguments to `log` and fails, so no run leaves this machine. */
const recordingCurl = (log: string) => pathWith([...BASE_TOOLS, "uname"], { curl: `echo "$@" >> ${log}\nexit 22` })

type Ran = { readonly status: number | null; readonly stdout: string; readonly stderr: string }

/* async, never spawnSync: the server answering the script lives in this process's event loop */
function runAsync(command: string, args: readonly string[], env: Record<string, string>): Promise<Ran> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env })
		let stdout = ""
		let stderr = ""
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk
		})
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk
		})
		child.on("error", reject)
		child.on("close", (status) => resolve({ status, stderr, stdout }))
	})
}

/** install.sh `text` run with `env`, under PATH `path` (the system's by default); the install dir and the run. */
async function runSh(text: string, env: Record<string, string>, path?: string) {
	const dir = scratch("run")
	writeFileSync(join(dir, "install.sh"), text)
	const bin = join(dir, "bin")
	/* mktemp's own dir, so a leg can see what the run left there */
	const tmp = join(dir, "tmp")
	mkdirSync(tmp)
	const ran = await runAsync("sh", [join(dir, "install.sh")], {
		HOME: dir,
		PATH: path ?? (process.env.PATH as string),
		SHOP_INSTALL_DIR: bin,
		TMPDIR: tmp,
		...env,
	})
	return { bin, installed: existsSync(join(bin, "shop")), left: readdirSync(tmp), ran }
}

/** install.ps1 `text` run with `env`; the install dir, whether shop.exe landed, and the run. */
async function runPs1(text: string, env: Record<string, string>) {
	const dir = scratch("ps1")
	writeFileSync(join(dir, "install.ps1"), text)
	const bin = join(dir, "bin")
	const ran = await runAsync(toolBin("pwsh"), ["-NoProfile", "-NonInteractive", "-File", join(dir, "install.ps1")], {
		HOME: dir,
		PATH: process.env.PATH as string,
		SHOP_INSTALL_DIR: bin,
		...env,
	})
	return { bin, installed: existsSync(join(bin, "shop.exe")), ran }
}

/** Each of `runs`, one after another. */
async function inTurn<T>(runs: readonly (() => Promise<T>)[]): Promise<T[]> {
	const out: T[] = []
	for (const run of runs) out.push(await run())
	return out
}

/** A run's status, whether it installed, and its stderr. */
const outcome = ({ installed, ran }: { installed: boolean; ran: { status: number | null; stderr: string } }) => [
	ran.status,
	installed,
	ran.stderr,
]

let server: Served
beforeAll(async () => {
	server = await serve()
})
afterAll(() => server.close())

describe("install.sh installs only what its checksum vouches for (phase g)", () => {
	it("installs this platform's archive once its sha256 matches checksums.txt", async () => {
		server.set(release({ [LINUX]: tarGz() }))
		const { bin, ran } = await runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url })
		const runs = spawnSync(join(bin, "shop"), { encoding: "utf8" }).stdout
		expect([ran.status, ran.stdout, ran.stderr, server.asked, runs]).toEqual([
			0,
			`installed ${bin}/shop\n`,
			"",
			[LINUX, "checksums.txt"],
			"fake shop\n",
		])
	})

	it("refuses a tampered archive and one checksums.txt does not list, one line each, nothing installed", async () => {
		const archive = tarGz()
		server.set(release({ [LINUX]: archive }, { tampered: LINUX }))
		const tampered = await runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url })
		server.set(release({ [LINUX]: archive }, { unlisted: LINUX }))
		const unlisted = await runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url })
		expect([tampered, unlisted].map(outcome)).toEqual([
			[1, false, `shop install: ${LINUX}: its sha256 is ${sha256(archive)}, checksums.txt says ${ZEROS}\n`],
			[1, false, `shop install: checksums.txt lists no ${LINUX}\n`],
		])
	})
})

describe("install.sh's platform (phase g)", () => {
	it("picks the archive by uname and the arch override, and refuses another OS or architecture", async () => {
		server.set(release({ "shop_darwin_arm64.tar.gz": tarGz(), "shop_linux_arm64.tar.gz": tarGz() }))
		const base = { SHOP_INSTALL_BASE: server.url }
		const runs = await inTurn([
			() => runSh(scripts().sh, base, unamePath("Darwin", "arm64")),
			() => runSh(scripts().sh, { ...base, SHOP_INSTALL_ARCH: "arm64" }, unamePath("Linux", "x86_64")),
			() => runSh(scripts().sh, base, unamePath("Linux", "sparc64")),
			() => runSh(scripts().sh, { ...base, SHOP_INSTALL_ARCH: "mips" }, unamePath("Linux", "x86_64")),
			() => runSh(scripts().sh, base, unamePath("FreeBSD", "amd64")),
		])
		expect(runs.map(outcome)).toEqual([
			[0, true, ""],
			[0, true, ""],
			[1, false, "shop install: sparc64: no build for this architecture (set SHOP_INSTALL_ARCH to amd64 or arm64)\n"],
			[1, false, "shop install: SHOP_INSTALL_ARCH mips: want amd64 or arm64\n"],
			[1, false, "shop install: FreeBSD: this script installs on Linux and macOS; on Windows, run install.ps1\n"],
		])
	})
})

describe("install.sh's base (phase g)", () => {
	it("refuses a base that is neither https:// nor http:// on loopback, before any fetch", async () => {
		server.set(release({ [LINUX]: tarGz() }))
		const runs = await inTurn(
			["http://example.com", "http://127.evil.com:80", "ftp://127.0.0.1/x"].map(
				(base) => () => runSh(scripts().sh, { SHOP_INSTALL_BASE: base }),
			),
		)
		expect([runs.map(({ ran }) => [ran.status, ran.stderr]), server.asked]).toEqual([
			[
				[1, "shop install: http://example.com: want https://, or http:// on loopback\n"],
				[1, "shop install: http://127.evil.com:80: want https://\n"],
				[1, "shop install: ftp://127.0.0.1/x: want https://\n"],
			],
			[],
		])
	})

	it("downloads from the repository's latest release or a tag's, by https alone", async () => {
		const log = join(scratch("args"), "args")
		const path = recordingCurl(log)
		const runs = await inTurn([
			() => runSh(scripts().sh, {}, path),
			() => runSh(scripts().sh, { SHOP_VERSION: "v1.2.3" }, path),
			() => runSh(scripts().sh, { SHOP_VERSION: "../x" }, path),
			() => runSh(scripts(null).sh, {}, path),
		])
		expect([runs.map(({ ran }) => ran.stderr), readFileSync(log, "utf8").replaceAll(/-o \S+/g, "-o <file>")]).toEqual([
			[
				"shop install: could not download https://github.com/acme/shop/releases/latest/download/shop_linux_amd64.tar.gz\n",
				"shop install: could not download https://github.com/acme/shop/releases/download/v1.2.3/shop_linux_amd64.tar.gz\n",
				"shop install: SHOP_VERSION ../x: not a release tag\n",
				"shop install: set SHOP_INSTALL_BASE: no repository to download from\n",
			],
			[
				"--proto =https --tlsv1.2 -fsSL -o <file> https://github.com/acme/shop/releases/latest/download/shop_linux_amd64.tar.gz",
				"--proto =https --tlsv1.2 -fsSL -o <file> https://github.com/acme/shop/releases/download/v1.2.3/shop_linux_amd64.tar.gz",
				"",
			].join("\n"),
		])
	})
})

describe("install.sh's downloader and digest (phase g)", () => {
	it("falls back to wget, --https-only on an https base, and refuses with neither or with no digest tool", async () => {
		server.set(release({ [LINUX]: tarGz() }))
		const log = join(scratch("wget"), "args")
		/* the wget shim records its arguments, then fetches its last one to the file -O names, by curl */
		const shim = `echo "$@" >> ${log}\nfor a; do url=$a; done\nwhile [ "$1" != -O ]; do shift; done\nexec ${which("curl")} -fs -o "$2" "$url"`
		const withWget = pathWith([...BASE_TOOLS, "uname"], { wget: shim })
		const runs = await inTurn([
			() => runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url }, withWget),
			() => runSh(scripts().sh, { SHOP_INSTALL_BASE: "https://127.0.0.1:1" }, withWget),
			() => runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url }, pathWith([...BASE_TOOLS, "uname"])),
			() =>
				runSh(
					scripts().sh,
					{ SHOP_INSTALL_BASE: server.url },
					pathWith([...BASE_TOOLS.filter((tool) => tool !== "sha256sum"), "uname", "curl"]),
				),
		])
		expect({
			args: readFileSync(log, "utf8").replaceAll(/-O \S+/g, "-O <file>"),
			runs: runs.map(outcome),
		}).toEqual({
			args: [
				`-q -O <file> ${server.url}/${LINUX}`,
				`-q -O <file> ${server.url}/checksums.txt`,
				`--https-only -q -O <file> https://127.0.0.1:1/${LINUX}`,
				"",
			].join("\n"),
			runs: [
				[0, true, ""],
				[1, false, `shop install: could not download https://127.0.0.1:1/${LINUX}\n`],
				[1, false, "shop install: neither curl nor wget is installed\n"],
				[1, false, "shop install: neither sha256sum nor shasum is installed to verify the download\n"],
			],
		})
	})
})

describe("install.sh as a download (phase g)", () => {
	it("runs nothing when the download stops short, before the last line or inside a function", async () => {
		server.set(release({ [LINUX]: tarGz() }))
		const text = scripts().sh
		const cuts = [text.slice(0, text.lastIndexOf('main "$@"')), text.slice(0, text.indexOf('\tfetch "$base/$archive"'))]
		const runs = await inTurn(cuts.map((cut) => () => runSh(cut, { SHOP_INSTALL_BASE: server.url })))
		expect([runs.map(({ installed }) => installed), runs[0]?.ran.status, server.asked]).toEqual([[false, false], 0, []])
	})

	it.skipIf(!TOOLS)("parses under sh -n and passes shellcheck", () => {
		const file = join(scratch("check"), "install.sh")
		writeFileSync(file, scripts().sh)
		const [parsed, checked] = [
			spawnSync("sh", ["-n", file], { encoding: "utf8" }),
			spawnSync(toolBin("shellcheck"), ["-s", "sh", file], { encoding: "utf8" }),
		]
		expect([parsed.status, parsed.stderr, checked.status, checked.stdout]).toEqual([0, "", 0, ""])
	})
})

describe("install.sh's hardening (phase g)", () => {
	it("leaves no temp dir behind, after an install or a refusal", async () => {
		const archive = tarGz()
		server.set(release({ [LINUX]: archive }))
		const installed = await runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url })
		server.set(release({ [LINUX]: archive }, { tampered: LINUX }))
		const refused = await runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url })
		expect([installed.ran.status, installed.left, refused.ran.status, refused.left]).toEqual([0, [], 1, []])
	})

	it("stops at a failing step under set -eu: an install dir it cannot make is no install", async () => {
		server.set(release({ [LINUX]: tarGz() }))
		const parent = scratch("readonly")
		chmodSync(parent, 0o500)
		const ran = await runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url, SHOP_INSTALL_DIR: join(parent, "bin") })
		chmodSync(parent, 0o700)
		expect([ran.ran.status === 0, ran.ran.stdout]).toEqual([false, ""])
	})

	it("evaluates no string: no eval in install.sh, no Invoke-Expression in install.ps1", () => {
		const { ps1, sh } = scripts()
		expect([/\beval\b/.test(sh), /Invoke-Expression|\biex\b/i.test(ps1)]).toEqual([false, false])
	})
})

describe.skipIf(!TOOLS)("install.ps1 under PowerShell (phase g)", () => {
	it("parses, installs this architecture's zip once its sha256 matches, and refuses as install.sh does", async () => {
		const zip = zipOf()
		server.set(release({ [WINDOWS]: zip, "shop_windows_arm64.zip": zip }))
		const file = join(scratch("parse"), "install.ps1")
		writeFileSync(file, scripts().ps1)
		const parsed = syntaxCheck("powershell", file)
		const arches: Record<string, string>[] = [{}, { SHOP_INSTALL_ARCH: "arm64" }, { SHOP_INSTALL_ARCH: "mips" }]
		const runs = await inTurn(
			arches.map((env) => () => runPs1(scripts().ps1, { SHOP_INSTALL_BASE: server.url, ...env })),
		)
		server.set(release({ [WINDOWS]: zip }, { tampered: WINDOWS }))
		const refused = await inTurn(
			[server.url, "http://example.com"].map((base) => () => runPs1(scripts().ps1, { SHOP_INSTALL_BASE: base })),
		)
		expect({ parsed, refused: refused.map(outcome), runs: runs.map(outcome) }).toEqual({
			parsed: { errors: "", status: 0 },
			refused: [
				[1, false, `shop install: ${WINDOWS}: its sha256 is ${sha256(zip)}, checksums.txt says ${ZEROS}\n`],
				[1, false, "shop install: http://example.com: want https://, or http:// on loopback\n"],
			],
			runs: [
				[0, true, ""],
				[0, true, ""],
				[1, false, "shop install: SHOP_INSTALL_ARCH mips: want amd64 or arm64\n"],
			],
		})
	})

	it("runs nothing when the download stops short of its last line", async () => {
		server.set(release({ [WINDOWS]: zipOf() }))
		const text = scripts().ps1
		const cut = await runPs1(text.slice(0, text.lastIndexOf("Install-Release\n")), { SHOP_INSTALL_BASE: server.url })
		expect([cut.ran.status, cut.installed, server.asked]).toEqual([0, false, []])
	})
})
