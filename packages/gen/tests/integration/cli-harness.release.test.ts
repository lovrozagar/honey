/**
 * The CLI's release, cross-built (bit 17 phase g; harness mode, heavy): the shop CLI's module in a fresh git repo,
 * `goreleaser build --snapshot` at the pinned goreleaser under the pinned Go, and each of the six binaries read back
 * by `go version -m`: its own GOOS and GOARCH, CGO off. -trimpath keeps -ldflags out of the build info, so the version
 * the tag stamps is found as bytes in each binary's file (-X writes it into the data, and -s -w keep it), and read by
 * running this machine's own build.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { shop } from "../../src/emit/cli/__fixtures__/shop.ts"
import { toolBin, withTools } from "../../src/emit/cli/__fixtures__/tools.ts"
import { generateGoCli } from "../../src/emit/cli/module.ts"
import { goCacheDir, goEnv, runGo, withGo } from "../../src/emit/go/__fixtures__/go-env.ts"

/* the tag the snapshot stamps: distinctive, so its bytes in a binary are the -X value and nothing else */
const STAMP = "v9.8.7-honey-stamp"

/** The shop CLI's module (released to acme/shop) in a fresh git repo with one commit, tagged STAMP. */
function repo(): string {
	const dir = mkdtempSync(join(goCacheDir("tmp"), "release-build-"))
	const { files } = generateGoCli(shop(), { modulePath: "github.com/acme/shop", repo: "acme/shop" })
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true })
		writeFileSync(join(dir, name), text)
	}
	const git = (...args: string[]) =>
		spawnSync("git", ["-c", "user.name=honey", "-c", "user.email=honey@example.com", ...args], { cwd: dir })
	git("init", "-q")
	/* goreleaser reads the remote's URL (never fetches it); without one its snapshot drops the git state, the tag too */
	git("remote", "add", "origin", "https://github.com/acme/shop.git")
	git("add", "-A")
	git("commit", "-q", "-m", "the shop CLI")
	git("tag", STAMP)
	return dir
}

/** A build setting `go version -m` lists, by its key. */
const setting = (info: string, key: string) => new RegExp(`^\\tbuild\\t${key}=(.*)$`, "m").exec(info)?.[1]

describe.skipIf(!withGo() || !withTools())("the CLI's release, cross-built (phase g)", () => {
	it("builds six static binaries, each its own GOOS and GOARCH, CGO off, the tag linked in as the version", () => {
		const dir = repo()
		const built = spawnSync(toolBin("goreleaser"), ["build", "--snapshot", "--clean"], {
			cwd: dir,
			encoding: "utf8",
			env: goEnv(),
		})
		const binaries = readdirSync(join(dir, "dist"), { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && /^shop(\.exe)?$/.test(entry.name))
			.map((entry) => join(entry.parentPath, entry.name))
		const read = binaries.map((path) => {
			const info = runGo(["version", "-m", path]).stdout
			const stamped = readFileSync(path).includes(STAMP)
			return `${setting(info, "GOOS")}/${setting(info, "GOARCH")} cgo=${setting(info, "CGO_ENABLED")} stamped=${stamped}`
		})
		const host = binaries.find((path) => path.includes("linux_amd64")) ?? ""
		const version = spawnSync(host, ["--version"], { encoding: "utf8" }).stdout
		expect([built.status, read.sort(), version], built.stderr).toEqual([
			0,
			[
				"darwin/amd64 cgo=0 stamped=true",
				"darwin/arm64 cgo=0 stamped=true",
				"linux/amd64 cgo=0 stamped=true",
				"linux/arm64 cgo=0 stamped=true",
				"windows/amd64 cgo=0 stamped=true",
				"windows/arm64 cgo=0 stamped=true",
			],
			`${STAMP}\n`,
		])
	}, 900_000)
})
