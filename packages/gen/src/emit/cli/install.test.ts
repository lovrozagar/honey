/**
 * The install scripts (bit 17 phase g, release program D8): installgen writes them from the layout release.ts
 * publishes, so this holds the layout, not installgen's own contract:
 * - with a repository, both scripts read the tag from the release's version.txt, fetch `<bin>_<os>_<arch>` and
 *   checksums.txt from its GitHub Releases, verify checksums.txt's bundle as signed by the repository's release
 *   workflow on that tag, and read the `<PREFIX>_` variables; the script URL is the release's unless
 *   `installUrl` names another;
 * - without a repository there are no scripts;
 * - install.sh passes sh -n and shellcheck, install.ps1 parses under PowerShell;
 * - end to end: install.sh, pointed at a loopback copy of a goreleaser snapshot release built from the generated
 *   config, installs this host's binary after its sha256 check, and refuses a tampered checksums.txt.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { delimiter, join } from "node:path"
import { generateInstallers } from "@lovrozagar/installgen"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { goCacheDir, goEnv, withGo } from "../go/__fixtures__/go-env.ts"
import { shop } from "./__fixtures__/shop.ts"
import { syntaxCheck, toolBin, withTools } from "./__fixtures__/tools.ts"
import { installerConfig } from "./install.ts"
import { type GoCliOptions, generateGoCli } from "./module.ts"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"

const TOOLS = withTools()
const GO = withGo()

const files = (options: GoCliOptions = { repo: "acme/shop" }) =>
	generateGoCli(shop(), { modulePath: "github.com/acme/shop", ...options }).files

const scratch = (name: string) => mkdtempSync(join(goCacheDir("tmp"), `install-${name}-`))

describe("the install scripts' layout (phase g)", () => {
	it("fetch the repository's release files and check its release workflow's signature on the tag", () => {
		const generated = files()
		for (const script of [generated["install.sh"], generated["install.ps1"]]) {
			expect(script).toContain("https://github.com/acme/shop/releases")
			expect(script).toContain("latest/download/version.txt")
			expect(script).toContain("shop_")
			expect(script).toContain("checksums.txt")
			expect(script).toContain("https://github.com/acme/shop/.github/workflows/release.yml@refs/tags/")
			expect(script).toContain("https://token.actions.githubusercontent.com")
			expect(script).toContain("SHOP_INSTALL_VERIFY")
			expect(script).toContain("https://github.com/acme/shop/releases/latest/download/install.")
		}
	})

	it("name the prefix the options give, and the script URL installUrl names", () => {
		const generated = files({ envPrefix: "SHOP_CLI", installUrl: "https://shop.example.com/cli/", repo: "acme/shop" })
		expect([
			generated["install.sh"]?.includes("SHOP_CLI_INSTALL_DIR"),
			generated["install.sh"]?.includes("https://shop.example.com/cli/install.sh"),
			generated["install.ps1"]?.includes("https://shop.example.com/cli/install.ps1"),
			generated["install.sh"]?.includes("releases/latest/download/install.sh"),
		]).toEqual([true, true, true, false])
	})

	it("are not written without a repository, which they would download from", () => {
		const generated = files({})
		expect([generated["install.sh"], generated["install.ps1"]]).toEqual([undefined, undefined])
	})

	it.skipIf(!TOOLS)(
		"parse under sh -n, pass shellcheck, and parse under PowerShell",
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const dir = scratch("check")
			const generated = files()
			writeFileSync(join(dir, "install.sh"), generated["install.sh"] ?? "")
			writeFileSync(join(dir, "install.ps1"), generated["install.ps1"] ?? "")
			const parsed = spawnSync("sh", ["-n", join(dir, "install.sh")], { encoding: "utf8" })
			const checked = spawnSync(toolBin("shellcheck"), ["-s", "sh", join(dir, "install.sh")], { encoding: "utf8" })
			const ps1 = syntaxCheck("powershell", join(dir, "install.ps1"))
			expect([parsed.status, parsed.stderr, checked.status, checked.stdout, ps1.status, ps1.errors]).toEqual([
				0,
				"",
				0,
				"",
				0,
				"",
			])
		},
	)
})

/* the snapshot builds a stub main: the scripts' layout is under test, the CLI's own build elsewhere */
const STUB = { "go.mod": "module github.com/acme/shop\n\ngo 1.24\n", "main.go": "package main\n\nfunc main() {}\n" }
const TAG = "v1.2.3"
const ARCH = ({ arm64: "arm64", x64: "amd64" } as Record<string, string>)[process.arch]
const LINUX = process.platform === "linux" && ARCH !== undefined

/** A goreleaser snapshot release from the generated config: its files by the path a GitHub release serves them at. */
function snapshotRelease(): Map<string, Buffer> {
	const dir = scratch("release")
	const generated = files()
	for (const [name, text] of Object.entries({ ".goreleaser.yaml": generated[".goreleaser.yaml"] ?? "", ...STUB })) {
		writeFileSync(join(dir, name), text)
	}
	/* the release uploads the scripts; the snapshot needs them present */
	writeFileSync(join(dir, "install.sh"), generated["install.sh"] ?? "")
	writeFileSync(join(dir, "install.ps1"), generated["install.ps1"] ?? "")
	const git = (...args: string[]) =>
		spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: dir })
	git("init", "-q")
	git("add", "-A")
	git("commit", "-qm", "init")
	const ran = spawnSync(toolBin("goreleaser"), ["release", "--snapshot", "--clean", "--skip=sign"], {
		cwd: dir,
		encoding: "utf8",
		env: goEnv(),
	})
	if (ran.status !== 0) throw new Error(`goreleaser snapshot failed: ${ran.stderr}`)
	const out = join(dir, "dist")
	const served = new Map<string, Buffer>([["/latest/download/version.txt", Buffer.from(`${TAG}\n`)]])
	for (const name of ["checksums.txt", `shop_linux_${ARCH}.tar.gz`]) {
		served.set(`/download/${TAG}/${name}`, readFileSync(join(out, name)))
	}
	return served
}

/** PATH without a cosign, so the install takes the sha256-only path wherever the test runs. */
const withoutCosign = (path: string) =>
	path
		.split(delimiter)
		.filter((dir) => dir !== "" && !existsSync(join(dir, "cosign")))
		.join(delimiter)

/** install.sh run with sh, its output and status. */
function runSh(script: string, env: Record<string, string>): Promise<{ status: number; out: string }> {
	return new Promise((resolve) => {
		const child = spawn("sh", ["-c", script], {
			env: { HOME: env.HOME ?? "", PATH: withoutCosign(process.env.PATH ?? ""), ...env },
		})
		let out = ""
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()))
		child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()))
		child.on("close", (code) => resolve({ out, status: code ?? 1 }))
	})
}

/** A fresh home to install into, its profile left alone. */
const env = () => {
	const home = scratch("home")
	return { HOME: home, SHOP_INSTALL_DIR: join(home, "bin"), SHOP_NO_MODIFY_PATH: "1" }
}

/** A loopback server answering `served`'s paths, its base URL once listening. */
async function serve(served: Map<string, Buffer>): Promise<{ server: Server; base: string }> {
	const server = createServer((request, response) => {
		const body = served.get(request.url ?? "")
		response.writeHead(body === undefined ? 404 : 200)
		response.end(body)
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	return { base: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`, server }
}

describe.skipIf(!TOOLS || !GO || !LINUX)("install.sh against a snapshot release (release program D8)", () => {
	let server: Server
	let base = ""
	let served = new Map<string, Buffer>()

	beforeAll(async () => {
		served = snapshotRelease()
		;({ base, server } = await serve(served))
	}, 300_000)
	afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

	const script = () =>
		generateInstallers(installerConfig({ bin: "shop", installUrl: base, prefix: "SHOP", repo: "acme/shop" }, base))
			.sh ?? ""

	it(
		"installs this host's binary from the latest release after its sha256 check",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const target = env()
			const ran = await runSh(script(), target)
			expect([ran.status, ran.out.includes("Verified"), existsSync(join(target.SHOP_INSTALL_DIR, "shop"))]).toEqual([
				0,
				true,
				true,
			])
		},
	)

	it("refuses an archive whose checksums.txt entry does not match", { timeout: SPAWN_TIMEOUT }, async () => {
		const path = `/download/${TAG}/checksums.txt`
		const good = served.get(path) ?? Buffer.alloc(0)
		const archive = `shop_linux_${ARCH}.tar.gz`
		served.set(
			path,
			Buffer.from(
				good
					.toString()
					.split("\n")
					.map((line) => (line.endsWith(archive) ? `${"0".repeat(64)}  ${archive}` : line))
					.join("\n"),
			),
		)
		try {
			const target = env()
			const ran = await runSh(script(), target)
			expect([
				ran.status,
				ran.out.includes("checksum mismatch"),
				existsSync(join(target.SHOP_INSTALL_DIR, "shop")),
			]).toEqual([1, true, false])
		} finally {
			served.set(path, good)
		}
	})
})
