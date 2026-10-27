/**
 * The install scripts' fixture (bit 17 phase g, moved out of install.test.ts at bit 19 i): the shop's scripts, a
 * local server holding a fake release (archives, checksums.txt and, at i, its signature bundle), PATH dirs of linked
 * tools and sh shims (a fake cosign among them), and the scripts run async against that server.
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
import { goCacheDir } from "../../go/__fixtures__/go-env.ts"
import { generateGoCli } from "../module.ts"
import { shop } from "./shop.ts"
import { toolBin } from "./tools.ts"

export const LINUX = "shop_linux_amd64.tar.gz"
export const WINDOWS = "shop_windows_amd64.zip"
export const ZEROS = "0000000000000000000000000000000000000000000000000000000000000000"
/** The signature bundle goreleaser's cosign writes beside checksums.txt. */
export const BUNDLE = "checksums.txt.sigstore.json"

/** The shop's install scripts, released to `repo` (none for null). */
export const scripts = (repo: string | null = "acme/shop") => {
	const { files } = generateGoCli(shop(), repo === null ? {} : { repo })
	return { ps1: files["install.ps1"] as string, sh: files["install.sh"] as string }
}

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
export const scratch = (name: string) => mkdtempSync(join(goCacheDir("tmp"), `install-${name}-`))

/** A tar.gz holding one executable `shop` that prints `fake shop`. */
export function tarGz(): Buffer {
	const dir = scratch("tar")
	writeFileSync(join(dir, "shop"), "#!/bin/sh\necho fake shop\n", { mode: 0o755 })
	spawnSync("tar", ["-czf", join(dir, "a.tar.gz"), "-C", dir, "shop"])
	return readFileSync(join(dir, "a.tar.gz"))
}

/** A zip holding one `shop.exe`. */
export function zipOf(): Buffer {
	const dir = scratch("zip")
	writeFileSync(join(dir, "shop.exe"), "fake shop exe\n")
	spawnSync("zip", ["-q", "-j", join(dir, "a.zip"), join(dir, "shop.exe")])
	return readFileSync(join(dir, "a.zip"))
}

/** What the fake cosign takes for a signature over `bytes`: their digest, so a bundle over other bytes fails. */
const signatureOver = (bytes: Buffer) => Buffer.from(`signed:${sha256(bytes)}\n`)

/** The release's options: an archive's digest `tampered` or `unlisted`; a signature bundle `valid` or `forged`. */
type ReleaseOptions = { tampered?: string; unlisted?: string; bundle?: "valid" | "forged" }

/** The fake release: each archive, checksums.txt over them as `opts` bends it, and the bundle `opts` asks for. */
export function release(archives: Record<string, Buffer>, opts: ReleaseOptions = {}) {
	const lines = Object.entries(archives)
		.filter(([name]) => name !== opts.unlisted)
		.map(([name, bytes]) => `${name === opts.tampered ? ZEROS : sha256(bytes)}  ${name}`)
	const sums = Buffer.from(`${lines.join("\n")}\n`)
	const files = new Map([...Object.entries(archives), ["checksums.txt", sums]])
	if (opts.bundle !== undefined)
		files.set(BUNDLE, signatureOver(opts.bundle === "valid" ? sums : Buffer.from("other checksums\n")))
	return files
}

/** A server answering from the files `set` gives it, recording each path asked for since. */
export type Served = {
	readonly url: string
	readonly asked: string[]
	set(files: Map<string, Buffer>): void
	close(): void
}
export async function serve(): Promise<Served> {
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
export const which = (tool: string) => spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim()

/** A PATH dir with the system's `tools` linked in and `shims` (name → sh body) written beside them. */
export function pathWith(tools: readonly string[], shims: Record<string, string> = {}): string {
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
export const BASE_TOOLS = ["sh", "awk", "tar", "gzip", "mktemp", "rm", "mkdir", "cp", "chmod", "mv", "cat", "sha256sum"]

/**
 * A fake cosign recording its arguments to `log`: `verify-blob` passes when the `--bundle` file holds the digest of
 * the blob, its last argument, as `release` signs it; anything else fails, as a signature from another signer would.
 */
export const fakeCosign = (log: string) => `echo "$@" >> ${log}
for a; do case $prev in --bundle) bundle=$a ;; esac; prev=$a; blob=$a; done
[ "$1" = verify-blob ] && [ "$(cat "$bundle")" = "signed:$(sha256sum "$blob" | awk '{ print $1 }')" ] && exit 0
echo "Error: none of the expected identities matched" >&2
exit 1`

/** A log for a fake cosign's arguments, and a PATH holding it beside the system's `tools`. */
export function withCosign(tools: readonly string[]) {
	const log = join(scratch("cosign"), "args")
	return { log, path: pathWith(tools, { cosign: fakeCosign(log) }) }
}

/** The arguments the fake cosign was called with, a line a call, a run's temp dir as <tmp>; "" when never called. */
export const cosignCalls = (log: string) =>
	existsSync(log)
		? readFileSync(log, "utf8").replaceAll(/\S+[/\\](checksums\.txt(?:\.sigstore\.json)?)/g, "<tmp>/$1")
		: ""

/* the identity and issuer the shop's scripts check, written out apart from the emitter's identityOf */
const IDENTITY = "(?i)^https://github\\.com/acme/shop/\\.github/workflows/release\\.yml@refs/tags/v"
const ISSUER = "https://token.actions.githubusercontent.com"
/** The one cosign call a checked install of the shop makes. */
export const CALL = `verify-blob --bundle <tmp>/${BUNDLE} --certificate-identity-regexp ${IDENTITY} --certificate-oidc-issuer ${ISSUER} <tmp>/checksums.txt\n`

/** The shop scripts' signature refusals: a forged bundle; require without cosign, without a repo; another value. */
export const FORGED =
	"shop install: checksums.txt: cosign could not verify it as signed by acme/shop's release workflow\n"
export const NO_COSIGN =
	"shop install: SHOP_INSTALL_VERIFY=require: cosign is not installed to verify checksums.txt's signature\n"
export const NO_REPO = "shop install: SHOP_INSTALL_VERIFY=require: no repository names who signs checksums.txt\n"
export const UNKNOWN = "shop install: SHOP_INSTALL_VERIFY yes: want require, or unset\n"

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

/** The system's tools install.sh runs, its downloaders and uname among them, and never a cosign this machine has. */
const systemPath = () => pathWith([...BASE_TOOLS, "uname", "curl", "wget"])

/** install.sh `text` run with `env`, under PATH `path` (systemPath by default); the install dir and the run. */
export async function runSh(text: string, env: Record<string, string>, path?: string) {
	const dir = scratch("run")
	writeFileSync(join(dir, "install.sh"), text)
	const bin = join(dir, "bin")
	/* mktemp's own dir, so a leg can see what the run left there */
	const tmp = join(dir, "tmp")
	mkdirSync(tmp)
	const ran = await runAsync("sh", [join(dir, "install.sh")], {
		HOME: dir,
		PATH: path ?? systemPath(),
		SHOP_INSTALL_DIR: bin,
		TMPDIR: tmp,
		...env,
	})
	return { bin, installed: existsSync(join(bin, "shop")), left: readdirSync(tmp), ran }
}

/** install.ps1 `text` run with `env`, under PATH `path` (an empty dir by default: no cosign); the dir and the run. */
export async function runPs1(text: string, env: Record<string, string>, path?: string) {
	const dir = scratch("ps1")
	writeFileSync(join(dir, "install.ps1"), text)
	const bin = join(dir, "bin")
	const ran = await runAsync(toolBin("pwsh"), ["-NoProfile", "-NonInteractive", "-File", join(dir, "install.ps1")], {
		HOME: dir,
		PATH: path ?? pathWith([]),
		SHOP_INSTALL_DIR: bin,
		...env,
	})
	return { bin, installed: existsSync(join(bin, "shop.exe")), ran }
}

/** Each of `runs`, one after another. */
export async function inTurn<T>(runs: readonly (() => Promise<T>)[]): Promise<T[]> {
	const out: T[] = []
	for (const run of runs) out.push(await run())
	return out
}

/** A run's status, whether it installed, and its stderr. */
export const outcome = ({ installed, ran }: { installed: boolean; ran: { status: number | null; stderr: string } }) => [
	ran.status,
	installed,
	ran.stderr,
]
