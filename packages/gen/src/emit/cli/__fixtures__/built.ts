/**
 * The generated CLI, built: its module written, built and vetted by `compileGo` (go-env's pinned toolchain, or a
 * floor toolchain), then linked once per content hash into a static binary (`CGO_ENABLED=0`, `-trimpath`) with the
 * version a release would stamp. `cli(args)` runs that binary as a user would, without blocking the event loop, so
 * an in-process server keeps answering meanwhile; its environment is only what the call passes, PATH aside, and its
 * HOME an empty directory of its own, so no config file of the machine's reaches it.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"
import { type Compiled, compileGo } from "../../go/__fixtures__/compiled.ts"
import { goCacheDir, runGo } from "../../go/__fixtures__/go-env.ts"

/** The version every built CLI is stamped with, as a release's `-ldflags -X` stamps it. */
export const STAMPED = "v1.2.3-test"

/** A run of the CLI: its exit status and output. */
export type Ran = { readonly status: number; readonly stderr: string; readonly stdout: string }

export type BuiltCli = Compiled & {
	/** the linked binary's path; empty when the build or the link failed */
	readonly binary: string
	/** the link's errors, if any */
	readonly linkErrors: string
	/** run the binary with `args`, `env` as its environment beside PATH and HOME, `input` on stdin */
	cli(args: readonly string[], options?: { readonly env?: NodeJS.ProcessEnv; readonly input?: string }): Promise<Ran>
}

/** The module path a go.mod declares. */
const moduleOf = (files: Readonly<Record<string, string>>) => /^module (\S+)$/m.exec(files["go.mod"] ?? "")?.[1] ?? ""

/** How the binary is linked: a release's flags, cgo off. */
const linkSettings = (modulePath: string) => ({
	env: { CGO_ENABLED: "0" },
	flags: ["-trimpath", "-ldflags", `-s -w -X ${modulePath}/internal/cli.Version=${STAMPED}`],
})

/**
 * The binary's path in `dir`, named by its link settings: a cached module dir (CI restores the last set) never hands
 * back a binary linked another way.
 */
const binaryIn = (dir: string, modulePath: string) =>
	join(
		dir,
		"bin",
		createHash("sha256")
			.update(JSON.stringify(linkSettings(modulePath)))
			.digest("hex")
			.slice(0, 12),
	)

/** Link the module's binary once, beside its final name then renamed; the link's errors, if any. */
function linkOnce(dir: string, modulePath: string, toolchain: string | undefined): string {
	const binary = binaryIn(dir, modulePath)
	if (existsSync(binary)) return ""
	mkdirSync(dirname(binary), { recursive: true })
	const partial = `${binary}.${process.pid}.partial`
	const { env, flags } = linkSettings(modulePath)
	const link = runGo(["build", ...flags, "-o", partial, "."], { cwd: dir, env, toolchain })
	if (link.status !== 0) return link.stderr
	renameSync(partial, binary)
	return ""
}

/** The binary's run with `args`, as a promise. */
function runIn(binary: string, args: readonly string[], env: NodeJS.ProcessEnv, input: string): Promise<Ran> {
	const home = goCacheDir("cli-home", String(process.pid))
	return new Promise((resolve, reject) => {
		const child = spawn(binary, [...args], { env: { HOME: home, PATH: process.env.PATH, ...env } })
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
		child.once("error", reject)
		child.once("close", (status) => resolve({ status: status ?? 1, stderr, stdout }))
		child.stdin.on("error", () => {
			/* a CLI that exits without reading its input: its exit status answers */
		})
		child.stdin.end(input)
	})
}

/** `files` (a CLI module) built, vetted and linked at the pinned toolchain, or at `toolchain` (the floor legs). */
export function builtCli(files: Readonly<Record<string, string>>, options: { readonly toolchain?: string } = {}) {
	const compiled = compileGo(files, options)
	const modulePath = moduleOf(files)
	const linkErrors = compiled.built ? linkOnce(compiled.dir, modulePath, options.toolchain) : ""
	const binary = compiled.built && linkErrors === "" ? binaryIn(compiled.dir, modulePath) : ""
	return {
		...compiled,
		binary,
		cli: (args, run = {}) => runIn(binary, args, run.env ?? {}, run.input ?? ""),
		linkErrors,
	} satisfies BuiltCli
}
