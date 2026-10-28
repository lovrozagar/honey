/**
 * The install scripts (bit 17 phase g), run against a local server holding a fake release:
 * - install.sh installs the archive for this platform only after its sha256 matches checksums.txt, refuses a
 *   tampered archive, a missing checksum line, an unknown OS or architecture, a base that is neither https:// nor
 *   http:// on loopback (before any fetch), a version that is no tag, and a machine without curl, wget or a digest
 *   tool; each refusal one line on stderr, nonzero, nothing installed;
 * - curl runs with --proto and --tlsv1.2, wget with --https-only on an https base;
 * - the default base is the repository's GitHub Releases, a tag's or the latest;
 * - a truncated download runs nothing;
 * - sh -n and shellcheck pass.
 * install.ps1's legs are install-ps1.test.ts's.
 * The signature check (bit 19 i) is install.verify.test.ts's.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	BASE_TOOLS,
	inTurn,
	LINUX,
	outcome,
	pathWith,
	release,
	runSh,
	type Served,
	scratch,
	scripts,
	serve,
	sha256,
	tarGz,
	which,
	ZEROS,
} from "./__fixtures__/install.ts"
import { toolBin, withTools } from "./__fixtures__/tools.ts"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"

const TOOLS = withTools()

/** A PATH whose uname answers `s` to -s and `m` to -m, curl beside it. */
const unamePath = (s: string, m: string) =>
	pathWith([...BASE_TOOLS, "curl"], { uname: `case "$1" in -s) echo ${s} ;; -m) echo ${m} ;; esac` })

/** A PATH whose curl records its arguments to `log` and fails, so no run leaves this machine. */
const recordingCurl = (log: string) => pathWith([...BASE_TOOLS, "uname"], { curl: `echo "$@" >> ${log}\nexit 22` })

let server: Served
beforeAll(async () => {
	server = await serve()
})
afterAll(() => server.close())

describe("install.sh installs only what its checksum vouches for (phase g)", () => {
	it("installs this platform's archive once its sha256 matches checksums.txt", { timeout: SPAWN_TIMEOUT }, async () => {
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

	it(
		"refuses a tampered archive and one checksums.txt does not list, one line each, nothing installed",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const archive = tarGz()
			server.set(release({ [LINUX]: archive }, { tampered: LINUX }))
			const tampered = await runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url })
			server.set(release({ [LINUX]: archive }, { unlisted: LINUX }))
			const unlisted = await runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url })
			expect([tampered, unlisted].map(outcome)).toEqual([
				[1, false, `shop install: ${LINUX}: its sha256 is ${sha256(archive)}, checksums.txt says ${ZEROS}\n`],
				[1, false, `shop install: checksums.txt lists no ${LINUX}\n`],
			])
		},
	)
})

describe("install.sh's platform (phase g)", () => {
	it(
		"picks the archive by uname and the arch override, and refuses another OS or architecture",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
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
		},
	)
})

describe("install.sh's base (phase g)", () => {
	it(
		"refuses a base that is neither https:// nor http:// on loopback, before any fetch",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
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
		},
	)

	it(
		"downloads from the repository's latest release or a tag's, by https alone",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const log = join(scratch("args"), "args")
			const path = recordingCurl(log)
			const runs = await inTurn([
				() => runSh(scripts().sh, {}, path),
				() => runSh(scripts().sh, { SHOP_VERSION: "v1.2.3" }, path),
				() => runSh(scripts().sh, { SHOP_VERSION: "../x" }, path),
				() => runSh(scripts(null).sh, {}, path),
			])
			expect([runs.map(({ ran }) => ran.stderr), readFileSync(log, "utf8").replaceAll(/-o \S+/g, "-o <file>")]).toEqual(
				[
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
				],
			)
		},
	)
})

describe("install.sh's downloader and digest (phase g)", () => {
	it(
		"falls back to wget, --https-only on an https base, and refuses with neither or with no digest tool",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
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
		},
	)
})

describe("install.sh as a download (phase g)", () => {
	it(
		"runs nothing when the download stops short, before the last line or inside a function",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			server.set(release({ [LINUX]: tarGz() }))
			const text = scripts().sh
			const cuts = [
				text.slice(0, text.lastIndexOf('main "$@"')),
				text.slice(0, text.indexOf('\tfetch "$base/$archive"')),
			]
			const runs = await inTurn(cuts.map((cut) => () => runSh(cut, { SHOP_INSTALL_BASE: server.url })))
			expect([runs.map(({ installed }) => installed), runs[0]?.ran.status, server.asked]).toEqual([
				[false, false],
				0,
				[],
			])
		},
	)

	it.skipIf(!TOOLS)("parses under sh -n and passes shellcheck", { timeout: SPAWN_TIMEOUT }, () => {
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
	it("leaves no temp dir behind, after an install or a refusal", { timeout: SPAWN_TIMEOUT }, async () => {
		const archive = tarGz()
		server.set(release({ [LINUX]: archive }))
		const installed = await runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url })
		server.set(release({ [LINUX]: archive }, { tampered: LINUX }))
		const refused = await runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url })
		expect([installed.ran.status, installed.left, refused.ran.status, refused.left]).toEqual([0, [], 1, []])
	})

	it(
		"stops at a failing step under set -eu: an install dir it cannot make is no install",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			server.set(release({ [LINUX]: tarGz() }))
			const parent = scratch("readonly")
			chmodSync(parent, 0o500)
			const ran = await runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url, SHOP_INSTALL_DIR: join(parent, "bin") })
			chmodSync(parent, 0o700)
			expect([ran.ran.status === 0, ran.ran.stdout]).toEqual([false, ""])
		},
	)

	it("evaluates no string: no eval in install.sh, no Invoke-Expression in install.ps1", () => {
		const { ps1, sh } = scripts()
		expect([/\beval\b/.test(sh), /Invoke-Expression|\biex\b/i.test(ps1)]).toEqual([false, false])
	})
})
